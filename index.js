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

try { require("@snazzah/davey"); } catch {}

// ---------------------------------------------------------
// Keep-alive
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Discord music bot is running");
}).listen(PORT, () => console.log("HTTP server on " + PORT));

// ---------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------
let FFMPEG = null;
try { FFMPEG = require("ffmpeg-static"); } catch {}

// ---------------------------------------------------------
// yt-dlp + cookies
// ---------------------------------------------------------
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

// ---------------------------------------------------------
// Logging
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

// ---------------------------------------------------------
// yt-dlp Auto Update
// ---------------------------------------------------------
const UPDATE_MARK_FILE = path.join(process.cwd(), "data", "yt-dlp.last");
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;
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

// ---------------------------------------------------------
// Queue / Player
// ---------------------------------------------------------
let queue = [];
let current = null;
const player = createAudioPlayer();
let currentPipe = null;
let restartGuard = { tried: false };

async function sendToTextChannel(guild, textChannelId, content){
  try {
    const ch = guild.channels.cache.get(textChannelId);
    if (ch && ch.isTextBased?.()) return ch.send(content);
  } catch {}
}

// ---------------------------------------------------------
// yt-dlp Helpers
// ---------------------------------------------------------
async function getTitle(input){
  try {
    const info = await ytdlp(input, ytdlpOpts({ dumpSingleJson: true }));
    return info?.title || input;
  } catch { return input; }
}

async function getDirectAudioUrlAndHeaders(input) {
  const info = await ytdlp(input, ytdlpOpts({ dumpSingleJson: true, f: "bestaudio/best" }));
  return { url: info?.url, headers: info?.http_headers || {} };
}

function buildFfmpegHeadersString(h) {
  const merged = {
    "User-Agent": h["User-Agent"] || "Mozilla/5.0",
    "Accept": h["Accept"] || "*/*",
    "Origin": "https://www.youtube.com",
    "Referer": "https://www.youtube.com/",
    ...(h.Cookie ? { "Cookie": h.Cookie } : {}),
  };
  return Object.entries(merged).map(([k,v]) => `${k}: ${v}`).join("\r\n");
}

function spawnFfmpegFromDirectUrl(url, headersStr) {
  const ffArgs = [
    "-loglevel", "quiet",
    "-hide_banner",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
    "-headers", headersStr + "\r\n",
    "-i", url, "-vn", "-ac", "2", "-ar", "48000",
    "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "pipe:1",
  ];
  return spawn(FFMPEG || "ffmpeg", ffArgs, { stdio: ["ignore","pipe","pipe"] });
}

// ---------------------------------------------------------
// Play Queue
// ---------------------------------------------------------
async function resolveFirstVideoUrl(query){
  if (/^https?:\/\//.test(query)) return query;
  try {
    const out = await ytdlp(`ytsearch1:${query}`, ytdlpOpts({ dumpSingleJson: true }));
    return out?.entries?.[0]?.webpage_url || null;
  } catch { return null; }
}

async function playNext(guild, textChannelId){
  restartGuard.tried = false;
  if (!queue.length) { current=null; return; }
  current = queue.shift();

  try {
    const pageUrl = await resolveFirstVideoUrl(current.source);
    if (!pageUrl) return playNext(guild, textChannelId);

    const { url, headers } = await getDirectAudioUrlAndHeaders(pageUrl);
    const ff = spawnFfmpegFromDirectUrl(url, buildFfmpegHeadersString(headers));
    currentPipe = { ff, stream: ff.stdout };

    const { stream, type } = await demuxProbe(ff.stdout);
    player.play(createAudioResource(stream, { inputType: type }));
  } catch {
    playNext(guild, textChannelId);
  }
}

// ---------------------------------------------------------
// Ready & Commands
// ---------------------------------------------------------
client.once(Events.ClientReady, async () => {
  console.log(`✅ bot online ${client.user.tag}`);
  console.log(`🍪 cookies: ${COOKIES_FILE ? `using ${COOKIES_FILE}` : "none"}`);
  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  scheduleDailyBangkokMidnight(() => runYtDlpUpdate());
  if (Date.now() - readLastUpdateTs() > 24*3600*1000) runYtDlpUpdate();
});

client.on("interactionCreate", async (itx) => {
  if (!itx.isChatInputCommand()) return;
  if (itx.commandName === "play") {
    const q = itx.options.getString("query");
    const title = await getTitle(q);
    queue.push({ title, source: q, guild: itx.guild, voiceChannelId: itx.member.voice.channelId, textChannelId: itx.channelId });
    await itx.reply(`➕ เพิ่ม: **${title}**`);
    if (!current) playNext(itx.guild, itx.channelId);
  }
  if (itx.commandName === "skip") { player.stop(); await itx.reply("⏭️ ข้ามแล้ว"); }
  if (itx.commandName === "stop") { queue=[]; player.stop(); await itx.reply("🛑 หยุดแล้ว"); }
  if (itx.commandName === "pause") { player.pause(); await itx.reply("⏸️ หยุดชั่วคราว"); }
  if (itx.commandName === "resume") { player.unpause(); await itx.reply("▶️ เล่นต่อ"); }
  if (itx.commandName === "ping") { await itx.reply(`ping=${Math.round(itx.client.ws.ping)}ms`); }
  if (itx.commandName === "botupdate") { await runYtDlpUpdate((msg)=>itx.reply(msg)); }
});

client.login(process.env.TOKEN);
