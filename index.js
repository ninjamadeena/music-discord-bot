// index.js
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

// ---------------------------------------------------------
// Discord & Voice
// ---------------------------------------------------------
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  demuxProbe,
} = require("@discordjs/voice");

// (แนะนำ) DAVE สำหรับ @discordjs/voice รุ่นใหม่
try { require("@snazzah/davey"); } catch { /* optional */ }

// ---------------------------------------------------------
// Keep-alive (Railway/Render friendly)
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
http
  .createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Discord music bot is running");
  })
  .listen(PORT, () => console.log("HTTP server on " + PORT));

// ---------------------------------------------------------
// ffmpeg (static ถ้ามี; ไม่มีก็ใช้ของระบบ)
// ---------------------------------------------------------
let FFMPEG = null;
try { FFMPEG = require("ffmpeg-static"); } catch {}

// ---------------------------------------------------------
// yt-dlp (via yt-dlp-exec)
// ---------------------------------------------------------
const ytdlp = require("yt-dlp-exec");

// ---------------------------------------------------------
// Logging — Pretty + สี + ping/rtt/tail
// ---------------------------------------------------------
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "bot.log");

function nowStr() { return new Date().toISOString().replace("T", " ").split(".")[0]; }
const C = { reset:"\x1b[0m", cyan:"\x1b[36m", green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m", white:"\x1b[37m" };
function colorize(s, code) { return code + s + C.reset; }

let _clientForPing = null;
function wsPing() { try { return Math.round(_clientForPing?.ws?.ping || 0); } catch { return 0; } }
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

  console.log(colorize(line, col));
  logFile(line);
}
function log(msg){ logPretty("LOG", msg); }

const DEBUG_FFMPEG = (process.env.DEBUG_FFMPEG || "false").toLowerCase() === "true";

// ---------------------------------------------------------
// yt-dlp: Auto Update + Scheduler (Asia/Bangkok)
// ---------------------------------------------------------
const UPDATE_MARK_FILE = path.join(process.cwd(), "data", "yt-dlp.last");
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7
let isUpdatingYtDlp = false;

function readLastUpdateTs(){ try { return Number(fs.readFileSync(UPDATE_MARK_FILE, "utf8")); } catch { return 0; } }
function writeLastUpdateTs(ts = Date.now()){
  try {
    const dir = path.dirname(UPDATE_MARK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(UPDATE_MARK_FILE, String(ts), "utf8");
  } catch {}
}

async function runYtDlpUpdate(replyFn){
  if (isUpdatingYtDlp) { replyFn?.("⏳ กำลังอัปเดตอยู่แล้ว"); return; }
  isUpdatingYtDlp = true;
  const started = Date.now();
  try {
    try { await ytdlp("--version"); } catch {}
    const out = await ytdlp("-U").catch(err => ({ error: err }));
    if (out?.error) {
      logPretty("ERROR", `yt-dlp update failed: ${out.error.message || out.error}`);
      replyFn?.("❌ อัปเดตไม่สำเร็จ (ดู log)");
    } else {
      const stdout = typeof out === "string" ? out : (out?.stdout || "");
      const msg = stdout.toString().trim() || "(no stdout)";
      logPretty("NOWPLAY", `yt-dlp update done: ${msg}`);
      writeLastUpdateTs(started);
      replyFn?.("✅ อัปเดตเสร็จแล้ว");
    }
  } catch (e) {
    logPretty("ERROR", `yt-dlp update error: ${e?.message || e}`);
    replyFn?.("❌ อัปเดตไม่สำเร็จ (เกิดข้อผิดพลาด)");
  } finally { isUpdatingYtDlp = false; }
}

function msUntilNextBangkokMidnight(){
  const now = new Date();
  const bkkNow = new Date(now.getTime() + BKK_OFFSET_MS);
  const nextMidnightBkkUTCms = Date.UTC(
    bkkNow.getUTCFullYear(), bkkNow.getUTCMonth(), bkkNow.getUTCDate() + 1, 0,0,0,0
  ) - BKK_OFFSET_MS;
  return Math.max(1, nextMidnightBkkUTCms - now.getTime());
}
function scheduleDailyBangkokMidnight(fn){
  const delay = msUntilNextBangkokMidnight();
  setTimeout(async () => { try { await fn(); } finally { scheduleDailyBangkokMidnight(fn); } }, delay);
}

// ---------------------------------------------------------
// Discord client + Slash commands
// ---------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
_clientForPing = client;

const commands = [
  new SlashCommandBuilder().setName("play").setDescription("เล่นเพลงจาก YouTube (ชื่อเพลงหรือ URL)")
    .addStringOption(o => o.setName("query").setDescription("ชื่อเพลง/URL").setRequired(true)),
  new SlashCommandBuilder().setName("skip").setDescription("ข้ามเพลงปัจจุบัน"),
  new SlashCommandBuilder().setName("stop").setDescription("หยุดเพลงและล้างคิว"),
  new SlashCommandBuilder().setName("pause").setDescription("หยุดชั่วคราว"),
  new SlashCommandBuilder().setName("resume").setDescription("เล่นต่อ"),
  new SlashCommandBuilder().setName("ping").setDescription("เช็คค่า ping"),
  new SlashCommandBuilder().setName("botupdate").setDescription("อัปเดต yt-dlp ตอนนี้"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

// ---------------------------------------------------------
// Queue / Player
// ---------------------------------------------------------
let queue = [];
let current = null;
const player = createAudioPlayer();

// เก็บท่อโปรเซสปัจจุบันไว้ปิดเวลา /stop หรือ /skip
let currentPipe = /** @type {null | { ytdlp: import('child_process').ChildProcessWithoutNullStreams, ff: import('child_process').ChildProcessWithoutNullStreams, stream: NodeJS.ReadableStream }} */ (null);

// ส่งข้อความไปห้องที่ระบุ
async function sendToTextChannel(guild, textChannelId, content){
  try {
    const ch = guild.channels.cache.get(textChannelId);
    if (ch && ch.isTextBased?.()) return ch.send(content);
  } catch {}
  return Promise.resolve();
}

player.on(AudioPlayerStatus.Idle, () => {
  cleanupCurrentPipeline();
  if (!current) return;
  logPretty("NOWPLAY", `⏭️ FINISHED: ${current.title}`);
  playNext(current.guild, current.textChannelId);
});
player.on("error", (e) => logPretty("ERROR", `Player error: ${e?.message || e}`));

client.on("error", (e) => logPretty("ERROR", `Client error: ${e?.message || e}`));
process.on("unhandledRejection", (e) => logPretty("ERROR", `unhandledRejection: ${e}`));

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
function isUrl(s){ try { new URL(s); return true; } catch { return false; } }

async function getTitle(input){
  try {
    const info = await ytdlp(input, { dumpSingleJson: true, noCheckCertificates: true });
    if (info && info.title) return info.title;
  } catch {}
  return input;
}

function swallowPipeError(err){
  const msg = String(err?.message || err || "");
  if (msg.includes("EPIPE") || msg.includes("ERR_STREAM_DESTROYED")) return;
  logPretty("ERROR", "pipe error: " + msg);
}

function spawnYtdlpFfmpegPipeline(input){
  const ytdlpArgs = ["-f","bestaudio/best","--no-playlist","--quiet","--no-warnings","-o","-", input];
  const ytdlpProc = spawn(require.resolve("yt-dlp-exec/bin/yt-dlp"), ytdlpArgs, { stdio: ["ignore","pipe","pipe"] });
  ytdlpProc.on("error", (e) => logPretty("ERROR", "yt-dlp spawn error: " + e?.message));
  ytdlpProc.stdout.on("error", swallowPipeError);
  ytdlpProc.stderr.on("error", swallowPipeError);
  if (DEBUG_FFMPEG) ytdlpProc.stderr.on("data", d => logPretty("LOG", "[yt-dlp] " + d.toString().trim()));

  const ffArgs = [
    "-loglevel", DEBUG_FFMPEG ? "info" : "quiet",
    "-hide_banner",
    "-thread_queue_size", "4096",
    "-fflags", "+genpts",
    "-i", "pipe:0",
    "-vn",
    "-ac", "2",
    "-ar", "48000",
    "-c:a", "libopus",
    "-b:a", "128k",
    "-f", "ogg",
    "pipe:1",
  ];
  const ff = spawn(FFMPEG || "ffmpeg", ffArgs, { stdio: ["pipe","pipe","pipe"] });
  ff.on("error", (e) => logPretty("ERROR", "ffmpeg spawn error: " + e?.message));
  ff.stdin.on("error", swallowPipeError);
  ff.stdout.on("error", swallowPipeError);
  ff.stderr.on("error", swallowPipeError);
  if (DEBUG_FFMPEG) ff.stderr.on("data", d => logPretty("LOG", "[ffmpeg] " + d.toString().trim()));

  ytdlpProc.stdout.pipe(ff.stdin);

  const stream = ff.stdout;

  const cleanup = () => {
    try { ytdlpProc.stdout?.unpipe(ff.stdin); } catch {}
    try { ff.stdin?.end(); } catch {}
    try { stream?.destroy?.(); } catch {}
    try { ytdlpProc.kill("SIGKILL"); } catch {}
    try { ff.kill("SIGKILL"); } catch {}
  };
  ytdlpProc.on("close", cleanup);
  ff.on("close", cleanup);

  return { stream, ytdlp: ytdlpProc, ff };
}

function cleanupCurrentPipeline(){
  if (!currentPipe) return;
  try {
    try { currentPipe.stream.destroy(); } catch {}
    try { currentPipe.ytdlp.stdout?.unpipe(currentPipe.ff.stdin); } catch {}
    try { currentPipe.ff.stdin?.end(); } catch {}
    try { currentPipe.ytdlp.kill("SIGKILL"); } catch {}
    try { currentPipe.ff.kill("SIGKILL"); } catch {}
  } catch (e) { swallowPipeError(e); }
  finally { currentPipe = null; }
}

function ensureVC(guild, channelId){
  let conn = getVoiceConnection(guild.id);
  if (!conn) {
    conn = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
    conn.subscribe(player);
  }
  return conn;
}

async function resolveFirstVideoUrl(query){
  if (isUrl(query)) return query;
  try {
    const out = await ytdlp(`ytsearch1:${query}`, { dumpSingleJson: true });
    const entry = out?.entries?.[0];
    return entry?.webpage_url || null;
  } catch (e) {
    logPretty("ERROR", "search resolve fail: " + (e?.message || e));
    return null;
  }
}

async function playNext(guild, textChannelId){
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

    const pipe = spawnYtdlpFfmpegPipeline(pageUrl);
    currentPipe = pipe;

    const { stream, type } = await demuxProbe(pipe.stream);
    const resource = createAudioResource(stream, { inputType: type });

    player.play(resource);

    const upNext = queue.slice(0, 3).map(x => x.title).join(" | ") || "-";
    logPretty("NOWPLAY", `🎶 NOW PLAYING: ${current.title}`, { tail: `by=${current.requestedBy} via=yt-dlp->ffmpeg up_next=${upNext}` });

    const ws = wsPing();
    await sendToTextChannel(
      guild,
      current.textChannelId,
      `🎶 กำลังเล่น: **${current.title}** — ขอโดย ${current.requestedBy} | ping ${ws} ms`
    );
  } catch (e) {
    logPretty("ERROR", "play error: " + (e?.message || e));
    await sendToTextChannel(guild, current.textChannelId, `⚠️ มีปัญหากับเพลงนี้ ข้าม: **${current?.title ?? "ไม่ทราบชื่อ"}**`);
    playNext(guild, textChannelId);
  }
}

// ---------------------------------------------------------
// Ready
// ---------------------------------------------------------
client.once(Events.ClientReady, async () => {
  console.log(`✅ bot online ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered");
  } catch (e) {
    logPretty("ERROR", "register error: " + (e?.message || e));
  }

  scheduleDailyBangkokMidnight(() => runYtDlpUpdate());
  const ONE_DAY = 24 * 3600 * 1000;
  if (Date.now() - readLastUpdateTs() > ONE_DAY) runYtDlpUpdate();
});

// ---------------------------------------------------------
// Commands
// ---------------------------------------------------------
client.on("interactionCreate", async (itx) => {
  if (!itx.isChatInputCommand()) return;
  const rtt = Date.now() - itx.createdTimestamp;

  const me = itx.guild.members.me;
  const userVC = itx.member?.voice?.channelId;
  const botVC = me?.voice?.channelId;
  const sameVC = userVC && (!botVC || botVC === userVC);

  if (itx.commandName !== "ping" && itx.commandName !== "botupdate" && !sameVC) {
    return itx.reply({ content: "❌ กรุณาเข้าห้องเสียงเดียวกับบอทก่อน", ephemeral: true });
  }

  if (itx.commandName === "ping") {
    await itx.reply(`\n> WebSocket: \`${Math.round(itx.client.ws.ping)} ms\`\n> RTT: \`${rtt} ms\``);
    logPretty("PING", `PING requested by ${itx.user.tag}`, { rtt });
    return;
  }

  if (itx.commandName === "botupdate") {
    await itx.deferReply({ ephemeral: true });
    logPretty("COMMAND", `/botupdate by ${itx.user.tag}`, { rtt });
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
    logPretty("COMMAND", `/play by ${itx.user.tag}`, {
      rtt,
      tail: `q="${q}" add="${title}" queue_len=${queue.length}`,
    });
    if (!current) playNext(itx.guild, itx.channelId);
    return;
  }

  if (itx.commandName === "skip") {
    player.stop(true);
    cleanupCurrentPipeline();
    await itx.reply("⏭️ ข้ามแล้ว");
    await sendToTextChannel(itx.guild, itx.channelId, "⏭️ ข้ามเพลงปัจจุบัน");
    logPretty("COMMAND", `⏭️ /skip by ${itx.user.tag}`, { rtt, tail: `queue_len=${queue.length}` });
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
    logPretty("COMMAND", `🛑 /stop by ${itx.user.tag}`, { rtt, tail: "queue_cleared" });
    return;
  }

  if (itx.commandName === "pause") {
    player.pause();
    await itx.reply("⏸️ หยุดชั่วคราว");
    await sendToTextChannel(itx.guild, itx.channelId, "⏸️ หยุดชั่วคราว");
    logPretty("COMMAND", `⏸️ /pause by ${itx.user.tag}`, { rtt });
    return;
  }

  if (itx.commandName === "resume") {
    player.unpause();
    await itx.reply("▶️ เล่นต่อ");
    await sendToTextChannel(itx.guild, itx.channelId, "▶️ เล่นต่อ");
    logPretty("COMMAND", `▶️ /resume by ${itx.user.tag}`, { rtt });
    return;
  }
});

client.login(process.env.TOKEN);
