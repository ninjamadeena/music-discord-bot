// index.js
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

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
try { FFMPEG = require("ffmpeg-static"); } catch {}

/* ------------------------------ yt-dlp + cookies ----------------------------- */
const ytdlp = require("yt-dlp-exec");
const COOKIES_FILE = process.env.YTDLP_COOKIES_PATH || null;
function ytdlpOpts(extra = {}) {
  const base = {
    noCheckCertificates: true,
    retries: "infinite",
    "fragment-retries": "infinite",
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
    .addIntegerOption(o => o.setName("limit").setDescription("จำนวนสูงสุด (1-500)").setMinValue(1).setMaxValue(500)),
].map(c => c.toJSON());

/* ---------------------------- Queue / Player state ---------------------------- */
let queue = [];                    // [{title, source, requestedBy, guild, voiceChannelId, textChannelId}]
let current = null;                // item ปัจจุบัน
const player = createAudioPlayer();
let currentPipe = /** @type {null | { ff: import('child_process').ChildProcessWithoutNullStreams, stream: NodeJS.ReadableStream }} */ (null);
let restartGuard = { tried: false };
let currentResource = null;        // createAudioResource(.., {inlineVolume:true})
let volumePct = 100;               // 0..500

/* ------------------------------- Util functions ------------------------------- */
async function sendToTextChannel(guild, textChannelId, content){
  try {
    const ch = guild.channels.cache.get(textChannelId);
    if (ch && ch.isTextBased?.()) return ch.send(content);
  } catch {}
}
function ensureVC(guild, channelId){
  let conn = getVoiceConnection(guild.id);
  if (!conn) {
    conn = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
    conn.subscribe(player);
  }
  return conn;
}
function cleanupCurrentPipeline(){
  if (!currentPipe) return;
  try {
    try { currentPipe.stream.destroy(); } catch {}
    try { currentPipe.ff.kill("SIGKILL"); } catch {}
  } catch (e) { swallowPipeError(e); }
  finally { currentPipe = null; }
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
  const ffArgs = [
    "-loglevel", DEBUG_FFMPEG ? "info" : "quiet",
    "-hide_banner",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "10",
    "-rw_timeout", "15000000",
    "-timeout", "15000000",
    "-headers", headersStr + "\r\n",
    "-i", url,
    "-vn",
    "-ac", "2",
    "-ar", "48000",
    "-c:a", "libopus",
    "-b:a", "128k",
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
        const url = e?.webpage_url || e?.url || (e?.id ? `https://www.youtube.com/watch?v=${e.id}` : null);
        const title = e?.title || e?.id || "unknown";
        if (url) entries.push({ title, url });
      }
    } else {
      const n = Math.min(Math.max(Number(limit) || 25, 1), 50);
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
  return entries;
}

/* ------------------------------ Player events -------------------------------- */
player.on(AudioPlayerStatus.Idle, () => {
  cleanupCurrentPipeline();
  currentResource = null;
  if (!current) return;
  logPretty("NOWPLAY", `⏭️ FINISHED: ${current.title}`);
  playNext(current.guild, current.textChannelId);
});
player.on("error", async (e) => {
  logPretty("ERROR", `Player error: ${e?.message || e}`);
  if (!restartGuard.tried && current) {
    restartGuard.tried = true;
    logPretty("ERROR", "Attempting one-time stream restart due to premature close", { tail: `title="${current.title}"` });
    await sendToTextChannel(current.guild, current.textChannelId, "🔁 สัญญาณหลุด กำลังลองเชื่อมต่อใหม่…");
    playSame(current.guild, current.textChannelId, current);
    return;
  }
  if (current) playNext(current.guild, current.textChannelId);
});
client.on("error", (e) => logPretty("ERROR", `Client error: ${e?.message || e}`));
process.on("unhandledRejection", (e) => logPretty("ERROR", `unhandledRejection: ${e}`));

/* --------------------------------- Play flow --------------------------------- */
async function playNext(guild, textChannelId){
  restartGuard.tried = false;
  cleanupCurrentPipeline();

  if (!queue.length) {
    current = null;
    const vc = getVoiceConnection(guild.id);
    if (vc) vc.destroy();
    logPretty("NOWPLAY", "⏹️ QUEUE EMPTY");
    await sendToTextChannel(guild, textChannelId, "⏹️ คิวหมดแล้ว");
    return;
  }
  current = queue.shift();

  try {
    ensureVC(guild, current.voiceChannelId);

    const pageUrl = await resolveFirstVideoUrl(current.source);
    if (!pageUrl) {
      logPretty("ERROR", "cannot resolve page url, skip", { tail: `q="${current.source}"` });
      await sendToTextChannel(guild, current.textChannelId, `⚠️ เล่นไม่ได้ ข้าม: **${current.title}**`);
      return playNext(guild, textChannelId);
    }

    const { url, headers } = await getDirectAudioUrlAndHeaders(pageUrl);
    const ff = spawnFfmpegFromDirectUrl(url, buildFfmpegHeadersString(headers));
    currentPipe = { ff, stream: ff.stdout };

    const { stream, type } = await demuxProbe(ff.stdout);
    const resource = createAudioResource(stream, { inputType: type, inlineVolume: true });
    currentResource = resource;
    setVolumePct(volumePct);

    player.play(resource);

    const upNext = queue.slice(0, 3).map(x => x.title).join(" | ") || "-";
    logPretty("NOWPLAY", `🎶 NOW PLAYING: ${current.title}`, { tail: `by=${current.requestedBy} via=ffmpeg(url+headers) up_next=${upNext}` });

    const ws = wsPing();
    await sendToTextChannel(guild, current.textChannelId, `🎶 กำลังเล่น: **${current.title}** — ขอโดย ${current.requestedBy} | ping ${ws} ms | 🔊 ${volumePct}%`);
  } catch (e) {
    logPretty("ERROR", "play error: " + (e?.message || e));
    await sendToTextChannel(guild, current.textChannelId, `⚠️ มีปัญหากับเพลงนี้ ข้าม: **${current?.title ?? "ไม่ทราบชื่อ"}**`);
    playNext(guild, textChannelId);
  }
}
async function playSame(guild, textChannelId, item){
  try {
    cleanupCurrentPipeline();
    ensureVC(guild, item.voiceChannelId);
    const pageUrl = await resolveFirstVideoUrl(item.source);
    if (!pageUrl) return playNext(guild, textChannelId);
    const { url, headers } = await getDirectAudioUrlAndHeaders(pageUrl);
    const ff = spawnFfmpegFromDirectUrl(url, buildFfmpegHeadersString(headers));
    currentPipe = { ff, stream: ff.stdout };
    const { stream, type } = await demuxProbe(ff.stdout);
    const resource = createAudioResource(stream, { inputType: type, inlineVolume: true });
    currentResource = resource;
    setVolumePct(volumePct);
    player.play(resource);
    logPretty("NOWPLAY", `🔁 RESTARTED: ${item.title}`, { tail: `via=ffmpeg(url+headers)` });
  } catch {
    playNext(guild, textChannelId);
  }
}

/* ------------------------------- Volume helper -------------------------------- */
function setVolumePct(pct){
  if (pct < 0) pct = 0;
  if (pct > 1000) pct = 1000;
  volumePct = pct;
  try { currentResource?.volume?.setVolumeLogarithmic(pct / 100); } catch {}
}

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
  const rtt = Date.now() - itx.createdTimestamp;
  logPretty("COMMAND", `/${itx.commandName} by ${itx.user.tag}`, { rtt });

  const me = itx.guild.members.me;
  const userVC = itx.member?.voice?.channelId;
  const botVC = me?.voice?.channelId;
  const sameVC = userVC && (!botVC || botVC === userVC);

  const needsSameVC = !["ping", "botupdate", "np", "queue"].includes(itx.commandName);

  if (needsSameVC && !sameVC) {
    return itx.reply({ content: "❌ กรุณาเข้าห้องเสียงเดียวกับบอทก่อน", ephemeral: true });
  }

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
    queue.push({
      title,
      source: q,
      requestedBy: itx.user.tag,
      guild: itx.guild,
      voiceChannelId: userVC,
      textChannelId: itx.channelId,
    });
    await itx.editReply(`➕ เพิ่ม: **${title}**`);
    if (!current) playNext(itx.guild, itx.channelId);
    return;
  }

  if (itx.commandName === "skip") {
    player.stop(true);
    cleanupCurrentPipeline();
    await itx.reply("⏭️ ข้ามแล้ว");
    await sendToTextChannel(itx.guild, itx.channelId, "⏭️ ข้ามเพลงปัจจุบัน");
    return;
  }

  if (itx.commandName === "stop") {
    queue = [];
    current = null;
    player.stop(true);
    cleanupCurrentPipeline();
    const vc = getVoiceConnection(itx.guild.id);
    if (vc) vc.destroy();
    await itx.reply("🛑 หยุดและล้างคิวแล้ว");
    await sendToTextChannel(itx.guild, itx.channelId, "🛑 หยุดและล้างคิวแล้ว");
    return;
  }

  if (itx.commandName === "pause") {
    player.pause();
    await itx.reply("⏸️ หยุดชั่วคราว");
    await sendToTextChannel(itx.guild, itx.channelId, "⏸️ หยุดชั่วคราว");
    return;
  }

  if (itx.commandName === "resume") {
    player.unpause();
    await itx.reply("▶️ เล่นต่อ");
    await sendToTextChannel(itx.guild, itx.channelId, "▶️ เล่นต่อ");
    return;
  }

  if (itx.commandName === "np") {
    if (!current) return itx.reply("ℹ️ ยังไม่มีเพลงกำลังเล่น");
    const embed = new EmbedBuilder()
      .setTitle("Now Playing")
      .setDescription(`**${current.title}**\nขอโดย: ${current.requestedBy}`)
      .addFields(
        { name: "คิวที่เหลือ", value: String(queue.length), inline: true },
        { name: "Volume", value: `${volumePct}%`, inline: true }
      );
    return itx.reply({ embeds: [embed] });
  }

  if (itx.commandName === "queue") {
    if (!queue.length) return itx.reply("📭 คิวว่าง");
    const lines = queue.slice(0, 10).map((x, i) => `\`${i+1}.\` ${x.title} — *${x.requestedBy}*`);
    const more = queue.length > 10 ? `\n…และอีก ${queue.length - 10} เพลง` : "";
    return itx.reply(`🎼 **คิวเพลง (${queue.length})**\n${lines.join("\n")}${more}`);
  }

  if (itx.commandName === "volume") {
    const v = itx.options.getInteger("value");
    setVolumePct(v);
    return itx.reply(`🔊 ปรับความดังเป็น **${volumePct}%**`);
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
      queue.push({
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

    if (!current) playNext(itx.guild, itx.channelId);
    return;
  }
});

client.login(process.env.TOKEN);
