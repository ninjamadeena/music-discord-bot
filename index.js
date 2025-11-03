// index.js
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
  EmbedBuilder,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  demuxProbe,
} = require("@discordjs/voice");

try { require("@snazzah/davey"); } catch { /* optional */ }

/* ------------------------- Keep-alive (Railway/Render) ------------------------ */
const PORT = process.env.PORT || 3000;
http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Discord music bot is running");
}).listen(PORT, () => console.log("HTTP server on " + PORT));

/* ---------------------------------- ffmpeg ----------------------------------- */
let FFMPEG = null;
let FFMPEG_AVAILABLE = false;
try {
  FFMPEG = require("ffmpeg-static");
  if (FFMPEG) FFMPEG_AVAILABLE = true;
} catch {}

/* ------------------------------ yt-dlp + cookies ----------------------------- */
const ytdlp = require("yt-dlp-exec");
const COOKIES_FILE = process.env.YTDLP_COOKIES_PATH || null;
function ytdlpOpts(extra = {}) {
  const base = {
    // Skip certificate validation; yt-dlp defaults to secure connections but this avoids SSL errors
    noCheckCertificates: true,
    // Retry endlessly for robust downloads
    retries: "infinite",
    "fragment-retries": "infinite",
    // Force IPv4 connections to avoid potential IPv6 routing issues
    "force-ipv4": true,
  };
  if (COOKIES_FILE) base.cookies = COOKIES_FILE;
  return { ...base, ...extra };
}

/* ---------------------------------- logging ---------------------------------- */
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "bot.log");
function nowStr() { return new Date().toISOString().replace("T", " ").split(".")[0]; }
const C = { reset:"\x1b[0m", cyan:"\x1b[36m", green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m", white:"\x1b[37m" };
function colorize(s, code) { return code + s + C.reset; }
let _clientForPing = null;
function wsPing(){ try { return Math.round(_clientForPing?.ws?.ping || 0); } catch { return 0; } }
function logFile(line){ try { fs.appendFileSync(LOG_FILE, line + "\n", "utf8"); } catch {} }
function logPretty(type, msg, extra = {}) {
  let col = C.white;
  if (type === "COMMAND") col = C.cyan;
  if (type === "NOWPLAY") col = C.green;
  if (type === "PING")    col = C.yellow;
  if (type === "ERROR")   col = C.red;
  const ws = wsPing();
  const line = `[${nowStr()}] ${msg}` + ` | ping=${ws}ms`
    + (extra.rtt ? ` rtt=${extra.rtt}ms` : "") + (extra.tail ? ` | ${extra.tail}` : "");
  console.log(colorize(line, col)); logFile(line);
}
function swallowPipeError(err){
  const msg = String(err?.message || err || "");
  if (msg.includes("EPIPE") || msg.includes("ERR_STREAM_DESTROYED")) return;
  logPretty("ERROR", "pipe error: " + msg);
}
const DEBUG_FFMPEG = (process.env.DEBUG_FFMPEG || "false").toLowerCase() === "true";

function checkFfmpegAvailability(){
  if (FFMPEG_AVAILABLE) return;
  try {
    const res = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    if (!res.error && res.status === 0) {
      FFMPEG_AVAILABLE = true;
      return;
    }
  } catch {}
  logPretty("ERROR", "ffmpeg binary not found. Please install ffmpeg or add it to PATH.");
}

checkFfmpegAvailability();

/* ----------------------- yt-dlp auto-update (BKK midnight) ------------------- */
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const UPDATE_MARK_FILE = path.join(DATA_DIR, "yt-dlp.last");
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;
let isUpdatingYtDlp = false;
function readLastUpdateTs(){ try { return Number(fs.readFileSync(UPDATE_MARK_FILE, "utf8")); } catch { return 0; } }
function writeLastUpdateTs(ts = Date.now()){ try { fs.writeFileSync(UPDATE_MARK_FILE, String(ts), "utf8"); } catch {} }
async function runYtDlpUpdate(replyFn){
  if (isUpdatingYtDlp) { replyFn?.("⏳ กำลังอัปเดตอยู่แล้ว"); return; }
  isUpdatingYtDlp = true;
  const started = Date.now();
  try {
    try { await ytdlp("--version"); } catch {}
    const out = await ytdlp("-U").catch(err => ({ error: err }));
    if (out?.error) {
      logPretty("ERROR", `yt-dlp update failed: ${out.error.message || out.error}`);
      replyFn?.("❌ อัปเดตไม่สำเร็จ");
    } else {
      const stdout = typeof out === "string" ? out : (out?.stdout || "");
      logPretty("NOWPLAY", `yt-dlp update done: ${stdout.toString().trim()}`);
      writeLastUpdateTs(started);
      replyFn?.("✅ อัปเดตเสร็จแล้ว");
    }
  } finally { isUpdatingYtDlp = false; }
}
function msUntilNextBangkokMidnight(){
  const now = new Date();
  const bkkNow = new Date(now.getTime() + BKK_OFFSET_MS);
  const nextMidnightBkkUTCms = Date.UTC(bkkNow.getUTCFullYear(), bkkNow.getUTCMonth(), bkkNow.getUTCDate()+1,0,0,0) - BKK_OFFSET_MS;
  return Math.max(1, nextMidnightBkkUTCms - now.getTime());
}
function scheduleDailyBangkokMidnight(fn){
  const delay = msUntilNextBangkokMidnight();
  setTimeout(async () => { try { await fn(); } finally { scheduleDailyBangkokMidnight(fn); } }, delay);
}

/* ------------------------------ Discord client -------------------------------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
_clientForPing = client;

/* --------------------------------- Commands ---------------------------------- */
const commands = [
  new SlashCommandBuilder().setName("play").setDescription("เล่นเพลงจาก YouTube (ชื่อเพลงหรือ URL)")
    .addStringOption(o => o.setName("query").setDescription("ชื่อเพลง/URL").setRequired(true)),
  new SlashCommandBuilder().setName("skip").setDescription("ข้ามเพลงปัจจุบัน"),
  new SlashCommandBuilder().setName("stop").setDescription("หยุดเพลงและล้างคิว"),
  new SlashCommandBuilder().setName("pause").setDescription("หยุดชั่วคราว"),
  new SlashCommandBuilder().setName("resume").setDescription("เล่นต่อ"),
  new SlashCommandBuilder().setName("ping").setDescription("เช็คค่า ping"),
  new SlashCommandBuilder().setName("botupdate").setDescription("อัปเดต yt-dlp"),
  new SlashCommandBuilder().setName("np").setDescription("ตอนนี้กำลังเล่นเพลงอะไร"),
  new SlashCommandBuilder().setName("queue").setDescription("ดูคิวเพลงที่เหลือ"),
  new SlashCommandBuilder().setName("volume").setDescription("ปรับความดัง (0-1000)")
    .addIntegerOption(o => o.setName("value").setDescription("เปอร์เซ็นต์ (0-1000)").setRequired(true).setMinValue(0).setMaxValue(1000)),
  new SlashCommandBuilder().setName("playlist").setDescription("เพิ่มเพลงเป็นชุดจาก YouTube (playlist หรือผลค้นหา)")
    .addStringOption(o => o.setName("query").setDescription("ลิงก์ playlist หรือคำค้น").setRequired(true))
    .addIntegerOption(o => o.setName("limit").setDescription("จำนวนสูงสุด (1-50)").setMinValue(1).setMaxValue(50)),
  new SlashCommandBuilder().setName("remove").setDescription("ลบเพลงจากคิวตามลำดับ")
    .addIntegerOption(o => o.setName("index").setDescription("ลำดับเพลงตาม /queue").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("shuffle").setDescription("สลับลำดับคิวแบบสุ่ม"),
  new SlashCommandBuilder().setName("loop").setDescription("ตั้งค่าการวนเพลง/คิว")
    .addStringOption(o =>
      o.setName("mode")
        .setDescription("รูปแบบการวน")
        .setRequired(true)
        .addChoices(
          { name: "ปิด", value: "off" },
          { name: "วนเพลงปัจจุบัน", value: "track" },
          { name: "วนทั้งคิว", value: "queue" },
        )
    ),
].map(c => c.toJSON());

/* ---------------------------- Queue / Player state ---------------------------- */
const guildStates = new Map();

function createGuildState(guild) {
  const player = createAudioPlayer();
  const state = {
    queue: [],
    current: null,
    player,
    currentPipe: /** @type {null | { ff: import('child_process').ChildProcessWithoutNullStreams, stream: NodeJS.ReadableStream }} */ (null),
    restartGuard: { tried: false },
    currentResource: null,
    volumePct: 100,
    loopMode: "off", // off | track | queue
    skipRequested: false,
  };

  player.on(AudioPlayerStatus.Idle, () => {
    handlePlayerIdle(guild, state).catch((e) => logPretty("ERROR", `Idle handler error: ${e?.message || e}`));
  });
  player.on("error", (e) => {
    handlePlayerError(e, guild, state).catch((err) => logPretty("ERROR", `Player error handler failed: ${err?.message || err}`));
  });

  return state;
}

function getGuildState(guild) {
  let state = guildStates.get(guild.id);
  if (!state) {
    state = createGuildState(guild);
    guildStates.set(guild.id, state);
  }
  return state;
}

/* ------------------------------- Util functions ------------------------------- */
async function sendToTextChannel(guild, textChannelId, content){
  try {
    const ch = guild.channels.cache.get(textChannelId);
    if (ch && ch.isTextBased?.()) return ch.send(content);
  } catch {}
}
function ensureVC(guild, channelId, state){
  let conn = getVoiceConnection(guild.id);
  if (!conn) {
    conn = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
  }
  if (state) {
    conn.subscribe(state.player);
  }
  return conn;
}
function cleanupCurrentPipeline(state){
  if (!state.currentPipe) return;
  try {
    try { state.currentPipe.stream.destroy(); } catch {}
    try { state.currentPipe.ff.kill("SIGKILL"); } catch {}
  } catch (e) { swallowPipeError(e); }
  finally { state.currentPipe = null; }
}
function isUrl(s){ try { new URL(s); return true; } catch { return false; } }

/* ------------------------------ yt-dlp helpers -------------------------------- */
async function getTitle(input){
  try {
    const info = await ytdlp(input, ytdlpOpts({ dumpSingleJson: true }));
    if (info?.title) return info.title;
  } catch {}
  return input;
}
async function resolveFirstVideoUrl(query){
  if (isUrl(query)) return query;
  try {
    const out = await ytdlp(`ytsearch1:${query}`, ytdlpOpts({ dumpSingleJson: true }));
    return out?.entries?.[0]?.webpage_url || null;
  } catch (e) {
    logPretty("ERROR", "search resolve fail: " + (e?.message || e));
    return null;
  }
}
async function getDirectAudioUrlAndHeaders(input) {
  const info = await ytdlp(input, ytdlpOpts({ dumpSingleJson: true, f: "bestaudio/best" }));
  const url = info?.url;
  const headers = info?.http_headers || {};
  if (!url) throw new Error("yt-dlp did not return media url");
  return { url, headers };
}
function buildFfmpegHeadersString(h) {
  const merged = {
    "User-Agent": h["User-Agent"] || h["user-agent"] || "Mozilla/5.0",
    "Accept": h["Accept"] || "*/*",
    "Accept-Language": h["Accept-Language"] || "en-US,en;q=0.9",
    "Origin": h["Origin"] || "https://www.youtube.com",
    "Referer": h["Referer"] || "https://www.youtube.com/",
    ...(h.Cookie ? { "Cookie": h.Cookie } : (h.cookie ? { "Cookie": h.cookie } : {})),
  };
  return Object.entries(merged).map(([k,v]) => `${k}: ${v}`).join("\r\n");
}
function spawnFfmpegFromDirectUrl(url, headersStr) {
  if (!FFMPEG_AVAILABLE) {
    throw new Error("ffmpeg binary not available");
  }
  // Construct ffmpeg arguments with more robust reconnect and low latency options.
  const ffArgs = [
    "-loglevel", DEBUG_FFMPEG ? "info" : "quiet",
    "-hide_banner",
    // Reconnect options: automatically attempt reconnection on errors and with a delay
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "10",
    // Reduce initial buffering and analysis time for faster start
    "-fflags", "+nobuffer",
    "-flags", "low_delay",
    "-analyzeduration", "0",
    "-probesize", "32k",
    // Set timeouts for read/write operations (in microseconds)
    "-rw_timeout", "15000000",
    "-timeout", "15000000",
    // Pass through HTTP headers
    "-headers", headersStr + "\r\n",
    "-i", url,
    // Drop the video stream and ensure stereo/48kHz audio
    "-vn",
    "-ac", "2",
    "-ar", "48000",
    // Encode audio using libopus at 128kbps (Discord friendly)
    "-c:a", "libopus",
    "-b:a", "128k",
    // Output as an ogg container to stdout
    "-f", "ogg",
    "pipe:1",
  ];
  const ff = spawn(FFMPEG || "ffmpeg", ffArgs, { stdio: ["ignore","pipe","pipe"] });
  ff.on("error", (e) => logPretty("ERROR", "ffmpeg spawn error: " + e?.message));
  ff.stdout.on("error", swallowPipeError);
  ff.stderr.on("error", swallowPipeError);
  if (DEBUG_FFMPEG) ff.stderr.on("data", d => logPretty("LOG", "[ffmpeg] " + d.toString().trim()));
  return ff;
}

/* --------------------- playlist helper: fetch entries list -------------------- */
/** คืนอาเรย์ [{ title, url }] จากลิงก์ playlist/mix หรือจากคำค้น (ytsearchN:) */
async function fetchPlaylistEntries(input, limit = 25) {
  const max = Math.min(Math.max(Number(limit) || 25, 1), 50);
  const entries = [];
  try {
    if (isUrl(input)) {
      const info = await ytdlp(input, ytdlpOpts({
        dumpSingleJson: true,
        "yes-playlist": true,
        "flat-playlist": true,
      }));
      const arr = info?.entries || [];
      for (const e of arr) {
        if (entries.length >= max) break;
        const url = e?.webpage_url || e?.url || (e?.id ? `https://www.youtube.com/watch?v=${e.id}` : null);
        const title = e?.title || e?.id || "unknown";
        if (url) entries.push({ title, url });
      }
    } else {
      const n = max;
      const out = await ytdlp(`ytsearch${n}:${input}`, ytdlpOpts({ dumpSingleJson: true }));
      const arr = out?.entries || [];
      for (const e of arr) {
        const url = e?.webpage_url || e?.url || (e?.id ? `https://www.youtube.com/watch?v=${e.id}` : null);
        const title = e?.title || e?.id || "unknown";
        if (url) entries.push({ title, url });
      }
    }
  } catch (err) {
    logPretty("ERROR", "fetchPlaylistEntries fail: " + (err?.message || err));
  }
  return entries.slice(0, max);
}

/* ------------------------------ Player helpers -------------------------------- */
async function handlePlayerIdle(guild, state) {
  cleanupCurrentPipeline(state);
  state.currentResource = null;
  if (!state.current) return;

  const finished = state.current;
  const manualSkip = state.skipRequested;
  state.skipRequested = false;

  logPretty("NOWPLAY", `⏭️ FINISHED: ${finished.title}`);

  if (state.loopMode === "track" && !manualSkip) {
    state.restartGuard.tried = false;
    await playSame(guild, finished.textChannelId, finished, state);
    return;
  }

  if (state.loopMode === "queue") {
    state.queue.push({ ...finished });
  }

  state.current = null;
  await playNext(guild, finished.textChannelId, state);
}

async function handlePlayerError(error, guild, state) {
  logPretty("ERROR", `Player error: ${error?.message || error}`);
  if (!state.current) return;

  if (!state.restartGuard.tried) {
    state.restartGuard.tried = true;
    logPretty("ERROR", "Attempting one-time stream restart due to premature close", { tail: `title="${state.current.title}"` });
    await sendToTextChannel(guild, state.current.textChannelId, "🔁 สัญญาณหลุด กำลังลองเชื่อมต่อใหม่…");
    await playSame(guild, state.current.textChannelId, state.current, state);
    return;
  }

  await playNext(guild, state.current.textChannelId, state);
}

async function playNext(guild, textChannelId, state = getGuildState(guild)) {
  state.restartGuard.tried = false;
  cleanupCurrentPipeline(state);

  if (!state.queue.length) {
    state.current = null;
    const vc = getVoiceConnection(guild.id);
    if (vc) vc.destroy();
    logPretty("NOWPLAY", "⏹️ QUEUE EMPTY");
    await sendToTextChannel(guild, textChannelId, "⏹️ คิวหมดแล้ว");
    return;
  }

  const next = state.queue.shift();
  state.current = next;

  try {
    // Use unified playback helper; this will throw on resolution errors
    const { pageUrl } = await startPlayback(guild, next, state);
    // Compose information about upcoming tracks
    const upNext = state.queue.slice(0, 3).map(x => x.title).join(" | ") || "-";
    logPretty("NOWPLAY", `🎶 NOW PLAYING: ${next.title}`, { tail: `by=${next.requestedBy} via=ffmpeg(url+headers) up_next=${upNext}` });
    const ws = wsPing();
    await sendToTextChannel(guild, next.textChannelId, `🎶 กำลังเล่น: **${next.title}** — ขอโดย ${next.requestedBy} | ping ${ws} ms | 🔊 ${state.volumePct}%`);
  } catch (e) {
    logPretty("ERROR", "play error: " + (e?.message || e));
    await sendToTextChannel(guild, next.textChannelId, `⚠️ มีปัญหากับเพลงนี้ ข้าม: **${next?.title ?? "ไม่ทราบชื่อ"}**`);
    state.current = null;
    await playNext(guild, textChannelId, state);
  }
}

async function playSame(guild, textChannelId, item, state = getGuildState(guild)) {
  try {
    state.current = item;
    cleanupCurrentPipeline(state);
    // Reuse unified playback helper; any errors will be caught below
    await startPlayback(guild, item, state);
    logPretty("NOWPLAY", `🔁 RESTARTED: ${item.title}`, { tail: `via=ffmpeg(url+headers)` });
  } catch (err) {
    logPretty("ERROR", "playSame error: " + (err?.message || err));
    state.current = null;
    await playNext(guild, textChannelId, state);
  }
}

function applyVolume(state) {
  try {
    const pct = Number.isFinite(state.volumePct) ? state.volumePct : 100;
    state.currentResource?.volume?.setVolumeLogarithmic(Math.max(pct, 0) / 100);
  } catch {}
}

/**
 * Prepare and start playback for a given queue item. This helper centralises
 * the logic of resolving a direct audio URL, spawning ffmpeg, probing the
 * stream type and starting the Discord audio player. It will also ensure
 * the voice connection is joined. If any step fails, it will throw an
 * exception which should be handled by the caller.
 *
 * @param {import('discord.js').Guild} guild
 * @param {Object} item
 * @param {Object} state
 * @returns {Promise<{ pageUrl: string }>} The resolved page URL
 */
async function startPlayback(guild, item, state) {
  // Ensure the bot is connected to the correct voice channel and subscribed to the player
  ensureVC(guild, item.voiceChannelId, state);

  // Resolve the initial video/track URL; this may involve a search
  const pageUrl = await resolveFirstVideoUrl(item.source);
  if (!pageUrl) {
    throw new Error("cannot resolve page url");
  }

  // Retrieve a direct audio URL and associated HTTP headers for yt-dlp
  const { url, headers } = await getDirectAudioUrlAndHeaders(pageUrl);
  // Spawn ffmpeg to transcode the audio stream to Opus/OGG
  const ff = spawnFfmpegFromDirectUrl(url, buildFfmpegHeadersString(headers));
  // Maintain a reference for clean up on idle/skip
  state.currentPipe = { ff, stream: ff.stdout };
  // Probe the stream to determine the correct demuxing configuration
  const { stream, type } = await demuxProbe(ff.stdout);
  // Create an audio resource for Discord with inline volume control
  const resource = createAudioResource(stream, { inputType: type, inlineVolume: true });
  state.currentResource = resource;
  // Apply the current volume setting
  applyVolume(state);
  // Start playback on the audio player
  state.player.play(resource);

  return { pageUrl };
}

function setVolumePct(state, pct){
  if (pct < 0) pct = 0;
  if (pct > 1000) pct = 1000;
  state.volumePct = pct;
  applyVolume(state);
}

client.on("error", (e) => logPretty("ERROR", `Client error: ${e?.message || e}`));
process.on("unhandledRejection", (e) => logPretty("ERROR", `unhandledRejection: ${e}`));

/* ------------------------------ Ready & commands ------------------------------ */
const restClient = new REST({ version: "10" }).setToken(process.env.TOKEN);
client.once(Events.ClientReady, async () => {
  console.log(`✅ bot online ${client.user.tag}`);
  console.log(`🍪 cookies: ${COOKIES_FILE ? `using ${COOKIES_FILE}` : "none"}`);
  try {
    await restClient.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered");
  } catch (e) {
    logPretty("ERROR", "register error: " + (e?.message || e));
  }
  scheduleDailyBangkokMidnight(() => runYtDlpUpdate());
  const ONE_DAY = 24 * 3600 * 1000;
  if (Date.now() - readLastUpdateTs() > ONE_DAY) runYtDlpUpdate();
});

client.on("interactionCreate", async (itx) => {
  if (!itx.isChatInputCommand()) return;
  // Calculate round-trip time. Clamp at zero to avoid negative values when clocks differ.
  const rttRaw = Date.now() - itx.createdTimestamp;
  const rtt = rttRaw < 0 ? 0 : rttRaw;
  logPretty("COMMAND", `/${itx.commandName} by ${itx.user.tag}`, { rtt });

  const me = itx.guild.members.me;
  const userVC = itx.member?.voice?.channelId;
  const botVC = me?.voice?.channelId;
  const sameVC = userVC && (!botVC || botVC === userVC);

  const needsSameVC = !["ping", "botupdate", "np", "queue"].includes(itx.commandName);

  if (needsSameVC && !sameVC) {
    return itx.reply({ content: "❌ กรุณาเข้าห้องเสียงเดียวกับบอทก่อน", ephemeral: true });
  }

  const state = getGuildState(itx.guild);

  if (itx.commandName === "ping") {
    await itx.reply(`\n> WebSocket: \`${Math.round(itx.client.ws.ping)} ms\`\n> RTT: \`${rtt} ms\``);
    return;
  }

  if (itx.commandName === "botupdate") {
    await itx.deferReply({ ephemeral: true });
    await runYtDlpUpdate((msg) => itx.editReply(msg));
    return;
  }

  if (itx.commandName === "play") {
    await itx.deferReply();
    const q = itx.options.getString("query");
    const title = await getTitle(q);
    state.queue.push({
      title,
      source: q,
      requestedBy: itx.user.tag,
      guild: itx.guild,
      voiceChannelId: userVC,
      textChannelId: itx.channelId,
    });
    await itx.editReply(`➕ เพิ่ม: **${title}**`);
    if (!state.current) playNext(itx.guild, itx.channelId, state);
    return;
  }

  if (itx.commandName === "skip") {
    state.skipRequested = true;
    state.player.stop(true);
    cleanupCurrentPipeline(state);
    // Respond once to the command that the current song was skipped
    await itx.reply("⏭️ ข้ามเพลงปัจจุบัน");
    return;
  }

  if (itx.commandName === "stop") {
    state.queue = [];
    state.current = null;
    state.loopMode = "off";
    state.skipRequested = false;
    state.player.stop(true);
    cleanupCurrentPipeline(state);
    const vc = getVoiceConnection(itx.guild.id);
    if (vc) vc.destroy();
    await itx.reply("🛑 หยุดและล้างคิวแล้ว");
    return;
  }

  if (itx.commandName === "pause") {
    state.player.pause();
    await itx.reply("⏸️ หยุดชั่วคราว");
    return;
  }

  if (itx.commandName === "resume") {
    state.player.unpause();
    await itx.reply("▶️ เล่นต่อ");
    return;
  }

  if (itx.commandName === "np") {
    if (!state.current) return itx.reply("ℹ️ ยังไม่มีเพลงกำลังเล่น");
    const embed = new EmbedBuilder()
      .setTitle("Now Playing")
      .setDescription(`**${state.current.title}**\nขอโดย: ${state.current.requestedBy}`)
      .addFields(
        { name: "คิวที่เหลือ", value: String(state.queue.length), inline: true },
        { name: "Volume", value: `${state.volumePct}%`, inline: true },
        { name: "Loop", value: state.loopMode === "off" ? "ปิด" : (state.loopMode === "track" ? "วนเพลง" : "วนคิว"), inline: true }
      );
    return itx.reply({ embeds: [embed] });
  }

  if (itx.commandName === "queue") {
    if (!state.queue.length) return itx.reply("📭 คิวว่าง");
    const lines = state.queue.slice(0, 10).map((x, i) => `\`${i+1}.\` ${x.title} — *${x.requestedBy}*`);
    const more = state.queue.length > 10 ? `\n…และอีก ${state.queue.length - 10} เพลง` : "";
    const loopLabel = state.loopMode === "off" ? "ปิด" : (state.loopMode === "track" ? "วนเพลง" : "วนคิว");
    return itx.reply(`🎼 **คิวเพลง (${state.queue.length})** — Loop: **${loopLabel}**\n${lines.join("\n")}${more}`);
  }

  if (itx.commandName === "volume") {
    const v = itx.options.getInteger("value");
    setVolumePct(state, v);
    return itx.reply(`🔊 ปรับความดังเป็น **${state.volumePct}%**`);
  }

  if (itx.commandName === "playlist") {
    await itx.deferReply();
    const q = itx.options.getString("query");
    const limit = itx.options.getInteger("limit") ?? 25;

    const items = await fetchPlaylistEntries(q, limit);
    if (!items.length) {
      return itx.editReply("❌ หาเพลงในเพลย์ลิสต์/ผลค้นหาไม่เจอ");
    }

    for (const { title, url } of items) {
      state.queue.push({
        title,
        source: url,
        requestedBy: itx.user.tag,
        guild: itx.guild,
        voiceChannelId: itx.member?.voice?.channelId,
        textChannelId: itx.channelId,
      });
    }

    const preview = items.slice(0, 5).map((x, i) => `\`${i + 1}.\` ${x.title}`).join("\n");
    const more = items.length > 5 ? `\n…และอีก ${items.length - 5} เพลง` : "";
    await itx.editReply(`📚 เพิ่มจาก **playlist/search** ทั้งหมด **${items.length}** เพลง\n${preview}${more}`);

    if (!state.current) playNext(itx.guild, itx.channelId, state);
    return;
  }

  if (itx.commandName === "remove") {
    if (!state.queue.length) return itx.reply("📭 คิวว่าง ไม่มีอะไรให้ลบ");
    const index = itx.options.getInteger("index");
    if (index < 1 || index > state.queue.length) {
      return itx.reply({ content: "❌ ลำดับไม่ถูกต้อง", ephemeral: true });
    }
    const [removed] = state.queue.splice(index - 1, 1);
    return itx.reply(`🗑️ ลบเพลงลำดับ ${index}: **${removed.title}**`);
  }

  if (itx.commandName === "shuffle") {
    if (state.queue.length < 2) return itx.reply("ℹ️ คิวมีน้อยกว่าสองเพลง ไม่ต้องสลับ");
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
    return itx.reply("🔀 สลับคิวเรียบร้อย");
  }

  if (itx.commandName === "loop") {
    const mode = itx.options.getString("mode");
    state.loopMode = mode;
    return itx.reply(`🔁 ตั้งค่า loop เป็น **${mode === "off" ? "ปิด" : mode === "track" ? "วนเพลงปัจจุบัน" : "วนทั้งคิว"}**`);
  }
});

client.login(process.env.TOKEN);
