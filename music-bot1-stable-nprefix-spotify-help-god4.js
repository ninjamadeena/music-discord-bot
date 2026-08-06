// index.js
require("dotenv").config();

// --- Spotify link support (no direct Spotify audio streaming) ---
// Accept Spotify TRACK/EPISODE URLs/URIs and convert to a YouTube search query.
function isSpotifyUrl(s){
  return typeof s === "string" && (s.includes("open.spotify.com/") || s.startsWith("spotify:"));
}
function normalizeSpotifyUrl(input){
  if (!input || typeof input !== "string") return null;
  const m = input.match(/^spotify:(track|album|playlist|episode):([A-Za-z0-9]+)$/);
  if (m) return `https://open.spotify.com/${m[1]}/${m[2]}`;
  return input.replace(/^<|>$/g, "");
}
function spotifyKind(url){
  const u = normalizeSpotifyUrl(url);
  if (!u) return null;
  const m = u.match(/open\.spotify\.com\/(track|album|playlist|episode)\/([A-Za-z0-9]+)/i);
  return m ? m[1].toLowerCase() : null;
}
async function fetchJsonWithTimeout(url, ms=8000){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
async function spotifyTitle(input){
  const url = normalizeSpotifyUrl(input);
  const kind = spotifyKind(url);
  if (!kind) return null;
  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  const data = await fetchJsonWithTimeout(oembedUrl, 8000);
  return data?.title ? String(data.title) : null;
}
async function spotifyTrackToSearchQuery(input){
  const url = normalizeSpotifyUrl(input);
  const kind = spotifyKind(url);
  if (kind !== "track" && kind !== "episode") return null;
  const t = await spotifyTitle(url);
  if (!t) return null;
  return `${t} audio`;
}
// --- end Spotify support ---

/* Clamp negative or invalid timer delays to 1 ms to avoid TimeoutNegativeWarning. */

(() => {
  // Convert delay into a non‑negative integer; invalid values are clamped to 1 ms.
  function sanitizeDelay(delay) {
    const n = Number(delay);
    return Number.isFinite(n) && n >= 0 ? n : 1;
  }
  const _setTimeout = global.setTimeout;
  const _setInterval = global.setInterval;
  global.setTimeout = function (fn, delay, ...args) {
    return _setTimeout(fn, sanitizeDelay(delay), ...args);
  };
  global.setInterval = function (fn, delay, ...args) {
    return _setInterval(fn, sanitizeDelay(delay), ...args);
  };
})();

/* Configuration: read settings from environment variables with sensible defaults. */
const path = require("path");
const fs = require("fs");

const config = {
  port: Number(process.env.PORT) || 3000,
  token: process.env.TOKEN || "",
  ffmpegPath: process.env.FFMPEG_PATH || null,
  cookieFile: process.env.YTDLP_COOKIES_PATH || null,
  logDir: process.env.LOG_DIR || path.join(process.cwd(), "logs"),
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), "data"),
  debugFfmpeg: (process.env.DEBUG_FFMPEG || "false").toLowerCase() === "true",
  defaultVolume: Math.max(0, Math.min(1000, Number(process.env.DEFAULT_VOLUME) || 100)),
  defaultLoop: (() => {
    const raw = (process.env.DEFAULT_LOOP_MODE || "off").toLowerCase();
    return ["off", "track", "queue"].includes(raw) ? raw : "off";
  })(),
  timezoneOffsetHours: Number(process.env.TIMEZONE_OFFSET_HOURS) || 7,
  ytdlpForceIpv4: (process.env.YTDLP_FORCE_IPV4 || "true").toLowerCase() === "true",
  ytdlpAutoUpdate: (process.env.YTDLP_AUTO_UPDATE || "true").toLowerCase() === "true",
  playlistHardCap: Math.max(1, Number(process.env.PLAYLIST_HARD_CAP) || 5000),

  audioChannels: Math.min(2, Math.max(1, Number(process.env.AUDIO_CHANNELS) || 2)),
  audioSampleRate: Number(process.env.AUDIO_SAMPLE_RATE) || 48000,
  opusBitrate: (process.env.OPUS_BITRATE || "128k").toLowerCase(),
  opusVbr: (process.env.OPUS_VBR || "on").toLowerCase(),
  opusApplication: (process.env.OPUS_APPLICATION || "audio").toLowerCase(),
  opusFrameDuration: Number(process.env.OPUS_FRAME_DURATION) || 20,
  opusComplexity: Math.max(0, Math.min(10, Number(process.env.OPUS_COMPLEXITY) ?? 5)), // ปรับเหลือ 5 ตามที่คุยกันเพื่อลดภาระ CPU
  audioFilter: process.env.AUDIO_FILTER || "",
  ffmpegLowLatency: (process.env.FFMPEG_LOW_LATENCY || "true").toLowerCase() === "true",
  ffmpegInputAnalyzeMs: Math.max(0, Number(process.env.FFMPEG_INPUT_ANALYZE_MS) || 0),
  ffmpegReconnectDelayMax: Math.max(1, Number(process.env.FFMPEG_RECONNECT_DELAY_MAX) || 10),
  ffmpegExtraArgs: process.env.FFMPEG_EXTRA_ARGS || "",

  // --- ตั้งค่าระบบ CACHE ตามที่คุณขอ ---
  cacheEnabled: (process.env.CACHE_ENABLED || "true").toLowerCase() === "true",
  cacheAutoDelete: (process.env.CACHE_AUTO_DELETE || "true").toLowerCase() === "true",
  cacheExpireSeconds: Number(process.env.CACHE_EXPIRE_SECONDS) || 86400,
};

// 💽 CACHE INITIALIZATION (สร้างโฟลเดอร์ cmusic และอ่านไฟล์ cmusic.json)
const CACHE_DIR = path.join(process.cwd(), "cmusic");
const CACHE_DB_PATH = path.join(process.cwd(), "cmusic.json");

if (config.cacheEnabled && !fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

let cacheDB = {};
if (config.cacheEnabled && fs.existsSync(CACHE_DB_PATH)) {
  try { 
    const raw = fs.readFileSync(CACHE_DB_PATH, "utf8");
    if(raw.trim()) cacheDB = JSON.parse(raw); 
  } catch (err) {
    console.error("❌ อ่านไฟล์ cmusic.json ไม่สำเร็จ เริ่มสร้างฐานข้อมูลใหม่");
  }
}

function saveCacheDB() {
  if (!config.cacheEnabled) return;
  try { fs.writeFileSync(CACHE_DB_PATH, JSON.stringify(cacheDB, null, 2), "utf8"); } 
  catch (err) { console.error("❌ บันทึก cmusic.json ไม่สำเร็จ:", err); }
}

// 🧹 CACHE AUTO-DELETE (ลบไฟล์อัตโนมัติเมื่อครบเวลาที่ตั้งไว้)
if (config.cacheEnabled && config.cacheAutoDelete) {
  setInterval(() => {
    const now = Date.now();
    const expireMs = config.cacheExpireSeconds * 1000;
    let hasDeleted = false;

    for (const [vId, data] of Object.entries(cacheDB)) {
      if (now - data.last_played > expireMs) {
        try {
          if (fs.existsSync(data.file_path)) fs.unlinkSync(data.file_path);
          delete cacheDB[vId];
          hasDeleted = true;
          console.log(`[CACHE] 🗑️ ลบไฟล์อัตโนมัติ (หมดอายุ): ${data.title}`);
        } catch (err) {
          console.error(`[CACHE] ❌ ลบไฟล์ไม่สำเร็จ: ${vId}`, err);
        }
      }
    }
    if (hasDeleted) saveCacheDB();
  }, 60 * 1000); // เช็คทุกๆ 1 นาที
}


function logConfiguration() {
  console.log("--------------------------------");
  console.log("[BOT] loading .env");
  console.log(` CACHE_ENABLED: ${config.cacheEnabled}`);
  console.log(` CACHE_AUTO_DELETE: ${config.cacheAutoDelete}`);
  console.log("--------------------------------");
}
logConfiguration();
console.log("[BOT] Starting now");
console.log("--------------------------------")

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
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  StreamType, // 🟢 ดึง StreamType มาใช้สำหรับแคช
} = require("@discordjs/voice");

try { require("@snazzah/davey"); } catch { /* optional */ }

http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Discord music bot is running");
}).listen(config.port);

let FFMPEG = null;
let FFMPEG_AVAILABLE = false;
try {
  if (config.ffmpegPath) {
    FFMPEG = config.ffmpegPath;
    FFMPEG_AVAILABLE = true;
  } else {
    FFMPEG = require("ffmpeg");
    if (FFMPEG) FFMPEG_AVAILABLE = true;
  }
} catch {}

const ytdlp = require("yt-dlp-exec");
const YTDLP_BIN = (() => {
  try {
    const m = require("yt-dlp-exec");
    if (m && typeof m.raw  === "string") return m.raw;
    if (m && typeof m.path === "string") return m.path;
  } catch {}
  for (const rel of ["yt-dlp-exec/yt-dlp", "yt-dlp-exec/bin/yt-dlp"]) {
    try { return require.resolve(rel); } catch {}
  }
  return "yt-dlp"; 
})();

function ytdlpOpts(extra = {}) {
  const base = {
    noCheckCertificates: true,
    retries: "infinite",
    "fragment-retries": "infinite",
    "force-ipv4": config.ytdlpForceIpv4,
    "js-runtimes": "node",
  };
  if (config.cookieFile) base.cookies = config.cookieFile;
  return { ...base, ...extra };
}

const LOG_DIR = config.logDir;
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE_MAIN  = path.join(LOG_DIR, "bot.log");
const LOG_FILE_ERROR = path.join(LOG_DIR, "bot-error.log");
const LOG_FILE_DEBUG = path.join(LOG_DIR, "bot-debug.log");

const C = {
  reset:    "\x1b[0m", bold:     "\x1b[1m", dim:      "\x1b[2m",
  white:    "\x1b[97m", gray:     "\x1b[90m", cyan:     "\x1b[96m",
  green:    "\x1b[92m", yellow:   "\x1b[93m", red:      "\x1b[91m",
  magenta:  "\x1b[95m", blue:     "\x1b[94m",
  bgBlue:   "\x1b[44m", bgGreen:  "\x1b[42m", bgRed:    "\x1b[41m",
  bgYellow: "\x1b[43m", bgCyan:   "\x1b[46m", bgMagenta:"\x1b[45m",
  bgGray:   "\x1b[100m",
};
const R = C.reset;

function nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function nowStrShort() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let _clientForPing = null;
function wsPing() {
  try { return Math.round(_clientForPing?.ws?.ping || 0); } catch { return 0; }
}

function writeLog(plain, isDebug = false, type = "") {
  try { fs.appendFileSync(LOG_FILE_DEBUG, plain + "\n", "utf8"); } catch {}
  if (type === "ERROR" || type === "WARN") {
    try { fs.appendFileSync(LOG_FILE_ERROR, plain + "\n", "utf8"); } catch {}
  }
  if (!isDebug) {
    try { fs.appendFileSync(LOG_FILE_MAIN, plain + "\n", "utf8"); } catch {}
  }
}

const LOG_TYPES = {
  COMMAND:  { icon: "❯", label: "CMD",     fg: C.cyan,    bg: C.bgCyan    },
  PREFIX:   { icon: "❯", label: "PREFIX",  fg: C.blue,    bg: C.bgBlue    },
  NOWPLAY:  { icon: "♪", label: "MUSIC",   fg: C.green,   bg: C.bgGreen   },
  ERROR:    { icon: "✖", label: "ERROR",   fg: C.red,     bg: C.bgRed     },
  WARN:     { icon: "!", label: "WARN",    fg: C.yellow,  bg: C.bgYellow  },
  INFO:     { icon: "i", label: "INFO",    fg: C.magenta, bg: C.bgMagenta },
  LOG:      { icon: "·", label: "DEBUG",   fg: C.gray,    bg: C.bgGray    },
  SYSTEM:   { icon: "⚙", label: "SYSTEM",  fg: C.white,   bg: C.bgGray    },
};

function logPretty(type, msg, extra = {}) {
  const cfg = LOG_TYPES[type] || LOG_TYPES.INFO;
  const isDebug = (type === "LOG");

  const ws  = wsPing();
  const ts  = `${C.dim}${C.gray}${nowStrShort()}${R}`;

  const badge = `${C.bold}${cfg.bg}\x1b[30m ${cfg.icon} ${cfg.label.padEnd(6)} ${R}`;
  const body  = `${C.bold}${cfg.fg}${msg}${R}`;

  const parts = [];
  parts.push(`${C.gray}ping ${C.white}${ws}ms${R}`);
  if (extra.rtt  !== undefined) parts.push(`${C.gray}rtt ${C.white}${extra.rtt}ms${R}`);
  if (extra.user)  parts.push(`${C.gray}user ${C.cyan}${extra.user}${R}`);
  if (extra.guild) parts.push(`${C.gray}srv ${C.white}${extra.guild}${R}`);
  if (extra.tail)  parts.push(`${C.dim}${extra.tail}${R}`);
  const meta = parts.join(`  ${C.gray}·${R}  `);

  const sep   = `${C.gray}│${R}`;
  const line  = `${ts}  ${badge}  ${body}  ${sep}  ${meta}`;

  const plain = (`[${nowStr()}] [${cfg.label}] ${msg}` +
    ` | ping=${ws}ms` +
    (extra.rtt   ? ` rtt=${extra.rtt}ms`    : "") +
    (extra.user  ? ` user=${extra.user}`     : "") +
    (extra.guild ? ` srv=${extra.guild}`     : "") +
    (extra.tail  ? ` | ${extra.tail}`        : "")
  ).replace(/\x1b\[[0-9;]*m/g, "");

  writeLog(plain, isDebug, type);
  if (!isDebug || DEBUG_FFMPEG) {
    console.log(line);
  }
}

function swallowPipeError(err){
  const msg = String(err?.message || err || "");
  if (msg.includes("EPIPE") || msg.includes("ERR_STREAM_DESTROYED")) return;
  logPretty("ERROR", "pipe error: " + msg);
}
const DEBUG_FFMPEG = config.debugFfmpeg;

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

const DATA_DIR = config.dataDir;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const UPDATE_MARK_FILE = path.join(DATA_DIR, "yt-dlp.last");
const BKK_OFFSET_MS = config.timezoneOffsetHours * 60 * 60 * 1000;
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
      logPretty("SYSTEM", `yt-dlp updated  ${stdout.toString().trim().split("\n").pop()}`);
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
  setTimeout(async () => {
    try {
      await fn();
    } finally {
      scheduleDailyBangkokMidnight(fn);
    }
  }, delay);
}

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
] });
_clientForPing = client;

const BOT_PREFIX = (process.env.BOT_PREFIX || process.env.COMMAND_PREFIX || "n!").trim();

function buildHelpEmbedPrefix(){
  const p = BOT_PREFIX;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("🎵 Music Bot — คู่มือการใช้งาน")
    .setDescription(`> ใช้คำสั่งด้วย prefix **\`${p}\`** ตัวอย่าง: \`${p}play lofi hip hop\`\n> รองรับ **YouTube · SoundCloud · TikTok · Spotify** (track)`)
    .addFields(
      { name: "╔══════════════════════════╗", value: "** ** ", inline: false },
      {
        name: "🎶  เล่นเพลง & จัดการคิว",
        value: [
          `\`${p}play <ชื่อ/URL>\` — เล่นหรือเพิ่มเพลงเข้าคิว`,
          `\`${p}playlist <URL/คำค้น> --limit N\` — โหลดเพลงเป็นชุด`,
          `\`${p}queue\` — ดูรายการคิวทั้งหมด`,
          `\`${p}np\` — เพลงที่กำลังเล่นอยู่`,
          `\`${p}remove <เลข>\` — ลบเพลงออกจากคิว`,
          `\`${p}shuffle\` — สุ่มลำดับคิว`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "⏯️  ควบคุมการเล่น",
        value: [
          `\`${p}skip\` — ข้ามเพลงปัจจุบัน`,
          `\`${p}pause\` — หยุดชั่วคราว`,
          `\`${p}resume\` — เล่นต่อ`,
          `\`${p}stop\` — หยุดและล้างคิวทั้งหมด`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "🔊  เสียง & การวน",
        value: [
          `\`${p}volume <0-10000>\` — ปรับระดับเสียง`,
          `\`${p}loop off\` — ปิดการวน`,
          `\`${p}loop track\` — วนเพลงเดิม`,
          `\`${p}loop queue\` — วนทั้งคิว`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "⚙️  ระบบ",
        value: [
          `\`${p}ping\` — ตรวจสอบ latency`,
          `\`${p}botupdate\` — อัปเดต yt-dlp`,
          `\`${p}help\` — แสดงคู่มือนี้`,
        ].join("\n"),
        inline: false,
      },
      { name: "╚══════════════════════════╝", value: "** **", inline: false },
    )
    .setFooter({ text: "💡 Shortcut: n!p = play · n!q = queue · n!s = skip · n!h = help", iconURL: "https://cdn.discordapp.com/emojis/1009293917116919808.webp" })
    .setTimestamp();
}

function buildHelpEmbedSlash(){
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("🎵 Music Bot — คู่มือการใช้งาน")
    .setDescription("> ใช้คำสั่งแบบ **Slash** `/` ได้เลย\n> รองรับ **YouTube · SoundCloud · TikTok · Spotify** (track)")
    .addFields(
      { name: "╔══════════════════════════╗", value: "** **", inline: false },
      {
        name: "🎶  เล่นเพลง & จัดการคิว",
        value: [
          "`/play query:<ชื่อ/URL>` — เล่นหรือเพิ่มเพลงเข้าคิว",
          "`/playlist query:<URL/คำค้น> limit:<N>` — โหลดเพลงเป็นชุด",
          "`/queue` — ดูรายการคิวทั้งหมด",
          "`/np` — เพลงที่กำลังเล่นอยู่",
          "`/remove index:<เลข>` — ลบเพลงออกจากคิว",
          "`/shuffle` — สุ่มลำดับคิว",
        ].join("\n"),
        inline: false,
      },
      {
        name: "⏯️  ควบคุมการเล่น",
        value: [
          "`/skip` — ข้ามเพลงปัจจุบัน",
          "`/pause` — หยุดชั่วคราว",
          "`/resume` — เล่นต่อ",
          "`/stop` — หยุดและล้างคิวทั้งหมด",
        ].join("\n"),
        inline: true,
      },
      {
        name: "🔊  เสียง & การวน",
        value: [
          "`/volume value:<0-10000>` — ปรับระดับเสียง",
          "`/loop mode:off` — ปิดการวน",
          "`/loop mode:track` — วนเพลงเดิม",
          "`/loop mode:queue` — วนทั้งคิว",
        ].join("\n"),
        inline: true,
      },
      {
        name: "⚙️  ระบบ",
        value: [
          "`/ping` — ตรวจสอบ latency",
          "`/botupdate` — อัปเดต yt-dlp",
          "`/help` — แสดงคู่มือนี้",
        ].join("\n"),
        inline: false,
      },
      { name: "╚══════════════════════════╝", value: "** **", inline: false },
    )
    .setFooter({ text: "💡 ใช้บ่อย? ลอง n!help แบบ prefix เร็วกว่า!" })
    .setTimestamp();
}

function parseLimitFromArgs(tokens){
  let limit = null;
  const out = [];
  for (let i=0;i<tokens.length;i++){
    const t = tokens[i];
    if (t === "--limit" || t === "limit" || t === "-l"){
      const n = parseInt(tokens[i+1], 10);
      if (!Number.isNaN(n)) limit = n;
      i++;
      continue;
    }
    out.push(t);
  }
  return { limit, tokens: out };
}

const COLORS = {
  primary:  0x5865F2,
  success:  0x57F287,
  warning:  0xFEE75C,
  error:    0xED4245,
  info:     0x5DADE2,
  music:    0xE91E63,
  queue:    0x9B59B6,
};

function makeEmbed(color = COLORS.primary) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}
function successEmbed(title, description) {
  return makeEmbed(COLORS.success).setDescription(`### ${title}\n${description ? `${description}` : ""}`);
}
function errorEmbed(description) {
  return makeEmbed(COLORS.error).setDescription(`### ❌  เกิดข้อผิดพลาด\n${description}`);
}
function infoEmbed(title, description) {
  return makeEmbed(COLORS.info).setDescription(`### ${title}\n${description ? `${description}` : ""}`);
}
function musicEmbed(title, description) {
  return makeEmbed(COLORS.music).setDescription(`### ${title}\n${description ? `${description}` : ""}`);
}

function loopLabel(mode) {
  if (mode === "track") return "🔂 วนเพลงเดิม";
  if (mode === "queue") return "🔁 วนทั้งคิว";
  return "➡️ ปิด";
}

function buildMusicControlRow(isPaused = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("mc_pause_resume")
      .setLabel(isPaused ? "▶️  เล่นต่อ" : "⏸️  หยุดชั่วคราว")
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("mc_skip")
      .setLabel("⏭️  ข้ามเพลง")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("mc_stop")
      .setLabel("⏹️  ปิดระบบ")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildNowPlayingEmbed(title, requestedBy, volumePct, ping, nextTitle, isPaused = false) {
  const statusLine = isPaused ? "⏸️  **หยุดชั่วคราว**" : "▶️  **กำลังเล่นอยู่**";
  return makeEmbed(isPaused ? COLORS.warning : COLORS.music)
    .setDescription(`### 🎶  Now Playing\n${statusLine}`)
    .addFields(
      { name: "🎵 เพลง",     value: `**${title}**`,                                        inline: false },
      { name: "👤 ขอโดย",   value: requestedBy,                                             inline: true  },
      { name: "🔊 Volume",   value: `${volumePct}%`,                                        inline: true  },
      { name: "🌐 Ping",     value: `${ping} ms`,                                           inline: true  },
      { name: "📋 ถัดไป",   value: nextTitle ? `\`${nextTitle}\`` : "—",                   inline: false },
    );
}

// 🟢 ฟังก์ชันอัปเดต UI 🟢
async function updateControlMsgIfNeeded(state) {
  if (!state.controlMsg || !state.current) return;
  try {
    const isPaused = state.player.state.status === AudioPlayerStatus.Paused;
    await state.controlMsg.edit({
      embeds: [buildNowPlayingEmbed(
        state.current.title, state.current.requestedBy,
        state.volumePct, wsPing(), state.queue[0]?.title || null, isPaused
      )],
      components: [buildMusicControlRow(isPaused)],
    });
  } catch (err) {
    if (err?.code === 10008) state.controlMsg = null;
  }
}

async function replyAck(msg, text){
  try { return await msg.channel.send({ content: text }); } catch { return null; }
}

client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild) return;
    if (msg.author?.bot) return;

    const raw = (msg.content || "").trim();
    if (!raw.startsWith(BOT_PREFIX)) return;

    const body = raw.slice(BOT_PREFIX.length).trim();
    if (!body) return;

    const parts = body.split(/\s+/);
    const cmdRaw = (parts.shift() || "").toLowerCase();

    const cmd = ({
      p: "play", q: "queue", now: "np", next: "skip", s: "skip",
      st: "stop", vol: "volume", upd: "botupdate", h: "help", help: "help",
    })[cmdRaw] || cmdRaw;

    logPretty("PREFIX", `${BOT_PREFIX}${cmd}`, { user: msg.author.tag, guild: msg.guild.name });

    const allowed = new Set(["help","play","playlist","skip","stop","pause","resume","queue","np","remove","shuffle","loop","volume","ping","botupdate"]);
    if (!allowed.has(cmd)) {
      return msg.reply({ embeds: [
        errorEmbed(`ไม่รู้จักคำสั่ง \`${BOT_PREFIX}${cmdRaw}\``)
          .addFields({ name: "💡 คำสั่งที่รองรับ", value: Array.from(allowed).map(c=>`\`${BOT_PREFIX}${c}\``).join(" ") })
      ]});
    }

    if (cmd === "help") return msg.reply({ embeds: [buildHelpEmbedPrefix()] });

    let q = null, limit = null, index = null, mode = null, value = null;

    if (cmd === "play") {
      q = parts.join(" ").trim();
      if (!q) return msg.reply({ embeds: [errorEmbed(`กรุณาระบุชื่อเพลงหรือลิงก์\n**ตัวอย่าง:** \`${BOT_PREFIX}play lofi hip hop\``)] });
    } else if (cmd === "playlist") {
      const parsed = parseLimitFromArgs(parts);
      limit = parsed.limit;
      q = parsed.tokens.join(" ").trim();
      if (!q) return msg.reply({ embeds: [errorEmbed(`กรุณาระบุลิงก์ playlist หรือคำค้น\n**ตัวอย่าง:** \`${BOT_PREFIX}playlist lofi playlist --limit 20\``)] });
    } else if (cmd === "remove") {
      index = parseInt(parts[0], 10);
      if (Number.isNaN(index) || index < 1) return msg.reply({ embeds: [errorEmbed(`กรุณาระบุหมายเลขลำดับ\n**ตัวอย่าง:** \`${BOT_PREFIX}remove 3\``)] });
    } else if (cmd === "loop") {
      mode = (parts[0] || "").toLowerCase();
      if (!mode) return msg.reply({ embeds: [errorEmbed(`กรุณาระบุโหมด: \`off\` · \`track\` · \`queue\`\n**ตัวอย่าง:** \`${BOT_PREFIX}loop track\``)] });
    } else if (cmd === "volume") {
      value = parseInt(parts[0], 10);
      if (Number.isNaN(value)) return msg.reply({ embeds: [errorEmbed(`กรุณาระบุตัวเลขความดัง (0–10000)\n**ตัวอย่าง:** \`${BOT_PREFIX}volume 80\``)] });
    }

    const me = msg.guild.members.me;
    const userVC = msg.member?.voice?.channelId;
    const botVC = me?.voice?.channelId;
    const sameVC = userVC && (!botVC || botVC === userVC);
    const needsSameVC = !["help","ping", "botupdate", "np", "queue"].includes(cmd);
    
    if (needsSameVC && !sameVC) {
      return msg.reply({ embeds: [errorEmbed("กรุณาเข้าห้องเสียงเดียวกับบอทก่อนนะ 🎙️")] });
    }

    if (["play","playlist","volume","skip","stop","pause","resume","ping","botupdate"].includes(cmd)) await replyAck(msg, "");

    const state = getGuildState(msg.guild);

    if (cmd === "ping") {
      return msg.reply({ embeds: [
        makeEmbed(COLORS.info).setDescription("### 🏓  Pong!").addFields({ name: "🌐 WebSocket", value: `\`${Math.round(msg.client.ws.ping)} ms\``, inline: true })
      ]});
    }

    if (cmd === "botupdate") {
      const m = await msg.reply({ embeds: [infoEmbed("🔄  กำลังอัปเดต yt-dlp…", "โปรดรอสักครู่")] });
      await runYtDlpUpdate((t) => m.edit({ embeds: [
        t.startsWith("✅") ? successEmbed("✅  อัปเดตสำเร็จ", "yt-dlp อัปเดตเรียบร้อยแล้ว") : errorEmbed(t)
      ], content: "" }));
      return;
    }

    if (cmd === "play") {
      const title = await getTitle(q);
      state.queue.push({ title, source: q, requestedBy: msg.author.tag, guild: msg.guild, voiceChannelId: userVC, textChannelId: msg.channelId });
      await msg.reply({ embeds: [
        makeEmbed(COLORS.success).setDescription(`### ➕  เพิ่มเพลงเข้าคิวแล้ว`)
          .addFields(
            { name: "🎵 เพลง", value: `**${title}**`, inline: false },
            { name: "📋 ลำดับในคิว", value: `\`#${state.queue.length}\``, inline: true },
            { name: "👤 ขอโดย", value: `${msg.author}`, inline: true },
          )
      ]});
      if (!state.current) playNext(msg.guild, msg.channelId, state);
      else updateControlMsgIfNeeded(state);
      return;
    }

    if (cmd === "playlist") {
      const items = await fetchPlaylistEntries(q, limit);
      if (!items.length) return msg.reply({ embeds: [errorEmbed("ไม่พบเพลงในเพลย์ลิสต์หรือผลการค้นหา")] });
      for (const { title, url } of items) {
        state.queue.push({ title, source: url, requestedBy: msg.author.tag, guild: msg.guild, voiceChannelId: userVC, textChannelId: msg.channelId });
      }
      const preview = items.slice(0, 5).map((x, i) => `\`${i + 1}.\` ${x.title}`).join("\n");
      const more = items.length > 5 ? `\n*… และอีก ${items.length - 5} เพลง*` : "";
      await msg.reply({ embeds: [
        makeEmbed(COLORS.queue).setDescription(`### 📚  โหลด Playlist สำเร็จ`)
          .addFields(
            { name: "🎶 เพลงทั้งหมด", value: `**${items.length} เพลง**`, inline: true },
            { name: "👤 ขอโดย", value: `${msg.author}`, inline: true },
            { name: "📋 รายการแรก", value: `${preview}${more}`, inline: false },
          )
      ]});
      if (!state.current) playNext(msg.guild, msg.channelId, state);
      else updateControlMsgIfNeeded(state);
      return;
    }

    if (cmd === "skip") {
      if (!state.current) return msg.reply({ embeds: [infoEmbed("ℹ️  ไม่มีเพลงกำลังเล่น", "")] });
      
      if (state.queue.length === 0 && state.loopMode !== "queue") {
        state.isForceTransition = true;
        state.current = null;
        state.loopMode = "off";
        state.skipRequested = false;
        if (state.controlMsg) {
          try {
            await state.controlMsg.edit({
              components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("mc_pause_resume").setLabel("⏸️  หยุดชั่วคราว").setStyle(ButtonStyle.Primary).setDisabled(true),
                new ButtonBuilder().setCustomId("mc_skip").setLabel("⏭️  ข้ามเพลง").setStyle(ButtonStyle.Secondary).setDisabled(true),
                new ButtonBuilder().setCustomId("mc_stop").setLabel("⏹️  ปิดระบบ").setStyle(ButtonStyle.Danger).setDisabled(true),
              )],
            });
          } catch {}
          state.controlMsg = null;
        }
        cleanupCurrentPipeline(state);
        state.player.stop(true);
        const vc = getVoiceConnection(msg.guild.id);
        if (vc) vc.destroy();
        return msg.reply({ embeds: [successEmbed("⏭️  ข้ามเพลงสุดท้ายแล้ว!", "คิวว่างเปล่า ขอตัวไปนอนพักก่อนนะ 👋")] });
      }

      state.isForceTransition = true;
      state.skipRequested = true;
      state.skipGeneration = (state.skipGeneration || 0) + 1;
      
      if (state.controlMsg) {
        try {
          await state.controlMsg.edit({
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("mc_pause_resume").setLabel("⏸️  หยุดชั่วคราว").setStyle(ButtonStyle.Primary).setDisabled(true),
              new ButtonBuilder().setCustomId("mc_skip").setLabel("⏭️  ข้ามเพลง").setStyle(ButtonStyle.Secondary).setDisabled(true),
              new ButtonBuilder().setCustomId("mc_stop").setLabel("⏹️  ปิดระบบ").setStyle(ButtonStyle.Danger).setDisabled(true),
            )],
          });
        } catch {}
        state.controlMsg = null;
      }
      cleanupCurrentPipeline(state);
      state.player.stop(true);
      return msg.reply({ embeds: [successEmbed("⏭️  ข้ามเพลงแล้ว", state.queue.length ? `ถัดไป: **${state.queue[0]?.title || "—"}**` : "คิวหมดแล้ว")] });
    }

    if (cmd === "stop") {
      state.isForceTransition = true;
      state.queue = [];
      state.current = null;
      state.loopMode = "off";
      state.skipRequested = false;
      if (state.controlMsg) {
        try {
          await state.controlMsg.edit({
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("mc_pause_resume").setLabel("⏸️  หยุดชั่วคราว").setStyle(ButtonStyle.Primary).setDisabled(true),
              new ButtonBuilder().setCustomId("mc_skip").setLabel("⏭️  ข้ามเพลง").setStyle(ButtonStyle.Secondary).setDisabled(true),
              new ButtonBuilder().setCustomId("mc_stop").setLabel("⏹️  ปิดระบบ").setStyle(ButtonStyle.Danger).setDisabled(true),
            )],
          });
        } catch {}
        state.controlMsg = null;
      }
      cleanupCurrentPipeline(state); 
      state.player.stop(true);       
      const vc = getVoiceConnection(msg.guild.id);
      if (vc) vc.destroy();
      return msg.reply({ embeds: [successEmbed("🛑  หยุดเพลงแล้ว", "ล้างคิวและออกจากห้องเสียงเรียบร้อย")] });
    }

    if (cmd === "pause") { 
      state.player.pause(); 
      updateControlMsgIfNeeded(state); 
      return msg.reply({ embeds: [infoEmbed("⏸️  หยุดชั่วคราว", "พิมพ์ `n!resume` เพื่อเล่นต่อ")] }); 
    }
    
    if (cmd === "resume") { 
      state.player.unpause(); 
      updateControlMsgIfNeeded(state); 
      return msg.reply({ embeds: [successEmbed("▶️  เล่นต่อแล้ว", `กำลังเล่น: **${state.current?.title || "—"}**`)] }); 
    }

    if (cmd === "np") {
      if (!state.current) return msg.reply({ embeds: [infoEmbed("🎵  ไม่มีเพลงกำลังเล่น", "ใช้ `n!play <ชื่อเพลง>` เพื่อเริ่มเล่น")] });
      return msg.reply({ embeds: [
        makeEmbed(COLORS.music).setDescription(`### 🎶  Now Playing`)
          .addFields(
            { name: "🎵 เพลง", value: `**${state.current.title}**`, inline: false },
            { name: "👤 ขอโดย", value: state.current.requestedBy, inline: true },
            { name: "🔊 ระดับเสียง", value: `${state.volumePct}%`, inline: true },
            { name: "🔁 Loop", value: loopLabel(state.loopMode), inline: true },
            { name: "📋 คิวที่เหลือ", value: `${state.queue.length} เพลง`, inline: true },
          )
      ]});
    }

    if (cmd === "queue") {
      if (!state.queue.length) return msg.reply({ embeds: [infoEmbed("📭  คิวว่างเปล่า", "ใช้ `n!play <ชื่อเพลง>` เพื่อเพิ่มเพลง")] });
      const lines = state.queue.slice(0, 10).map((x, i) => `\`${String(i+1).padStart(2,"0")}.\` **${x.title}**\n　　👤 ${x.requestedBy}`).join("\n");
      const more = state.queue.length > 10 ? `\n*… และอีก **${state.queue.length - 10}** เพลง*` : "";
      return msg.reply({ embeds: [
        makeEmbed(COLORS.queue).setDescription(`### 📋  คิวเพลง`)
          .addFields(
            { name: `รายการ (${Math.min(state.queue.length, 10)}/${state.queue.length})`, value: lines + more, inline: false },
            { name: "🔁 Loop", value: loopLabel(state.loopMode), inline: true },
            { name: "🎵 กำลังเล่น", value: state.current ? `**${state.current.title}**` : "—", inline: true },
          )
      ]});
    }

    if (cmd === "volume") {
      setVolumePct(state, value);
      updateControlMsgIfNeeded(state);
      const bar = "█".repeat(Math.round(Math.min(state.volumePct, 200) / 20)) + "░".repeat(10 - Math.round(Math.min(state.volumePct, 200) / 20));
      return msg.reply({ embeds: [successEmbed("🔊  ปรับระดับเสียงแล้ว", `\`${bar}\` **${state.volumePct}%**`)] });
    }

    if (cmd === "shuffle") {
      shuffleArray(state.queue);
      updateControlMsgIfNeeded(state);
      return msg.reply({ embeds: [successEmbed("🔀  สุ่มคิวแล้ว", `สลับลำดับ **${state.queue.length} เพลง** เรียบร้อย`)] });
    }

    if (cmd === "remove") {
      if (index > state.queue.length) return msg.reply({ embeds: [errorEmbed(`หมายเลขลำดับเกินจำนวนในคิว (มีอยู่ ${state.queue.length} เพลง)`)] });
      const [rm] = state.queue.splice(index - 1, 1);
      updateControlMsgIfNeeded(state);
      return msg.reply({ embeds: [successEmbed("🗑️  ลบเพลงออกจากคิวแล้ว", `**${rm?.title || "ไม่ทราบชื่อ"}**`)] });
    }

    if (cmd === "loop") {
      if (!["off","track","queue"].includes(mode)) return msg.reply({ embeds: [errorEmbed("โหมดต้องเป็น `off` · `track` · `queue`")] });
      state.loopMode = mode;
      return msg.reply({ embeds: [successEmbed("🔁  ตั้งค่า Loop แล้ว", `โหมดปัจจุบัน: **${loopLabel(mode)}**`)] });
    }

  } catch (e) {
    console.error(e);
    try { await msg.reply({ embeds: [errorEmbed("เกิดข้อผิดพลาดขณะอ่านคำสั่ง กรุณาลองใหม่อีกครั้ง")] }); } catch {}
  }
});


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
  new SlashCommandBuilder().setName("volume").setDescription("ปรับความดัง (0-10000)")
    .addIntegerOption(o => o.setName("value").setDescription("เปอร์เซ็นต์ (0-10000)").setRequired(true).setMinValue(0).setMaxValue(10000)),
  new SlashCommandBuilder().setName("playlist").setDescription("เพิ่มเพลงเป็นชุดจาก YouTube (playlist หรือผลค้นหา)")
    .addStringOption(o => o.setName("query").setDescription("ลิงก์ playlist หรือคำค้น").setRequired(true))
    .addIntegerOption(o => o.setName("limit").setDescription("จำนวนสูงสุด (ถ้าไม่ใส่ = ทั้ง playlist) (1-5000)").setMinValue(1).setMaxValue(5000)),
  new SlashCommandBuilder().setName("remove").setDescription("ลบเพลงจากคิวตามลำดับ")
    .addIntegerOption(o => o.setName("index").setDescription("ลำดับเพลงตาม /queue").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("shuffle").setDescription("สลับลำดับคิวแบบสุ่ม"),
  new SlashCommandBuilder().setName("loop").setDescription("ตั้งค่าการวนเพลง/คิว")
    .addStringOption(o =>
      o.setName("mode").setDescription("รูปแบบการวน").setRequired(true)
        .addChoices({ name: "ปิด", value: "off" }, { name: "วนเพลงปัจจุบัน", value: "track" }, { name: "วนทั้งคิว", value: "queue" })
    ),
  new SlashCommandBuilder().setName("help").setDescription("แสดงวิธีใช้และคำสั่งทั้งหมด"),
].map(c => c.toJSON());

const guildStates = new Map();

function createGuildState(guild) {
  const player = createAudioPlayer();
  const state = {
    queue: [],
    current: null,
    player,
    currentPipe: null,
    restartGuard: { tried: false },
    currentResource: null,
    volumePct: config.defaultVolume,
    loopMode: config.defaultLoop,
    skipRequested: false,
    skipGeneration: 0, 
    isHandlingTransition: false,
    isForceTransition: false,
    controlMsg: null,
  };

  player.on(AudioPlayerStatus.Idle, () => {
    if (state.isHandlingTransition) return;
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
    try { state.currentPipe.stream?.destroy?.(); } catch {}
    try { state.currentPipe.ff?.kill?.("SIGKILL"); } catch {}
    try { state.currentPipe.helper?.kill?.("SIGKILL"); } catch {}
  } catch (e) {
    swallowPipeError(e);
  } finally {
    state.currentPipe = null;
  }
}

function isUrl(s){ try { new URL(s); return true; } catch { return false; } }

async function getTitle(input){
  try {
    if (isSpotifyUrl(input)) {
      const t = await spotifyTitle(input);
      if (t) return t;
    }
    const info = await ytdlp(input, ytdlpOpts({ dumpSingleJson: true }));
    if (info?.title) return info.title;
  } catch {}
  return input;
}

async function resolveFirstVideoUrl(query){
  if (isSpotifyUrl(query)) {
    const kind = spotifyKind(query);
    if (kind === "album" || kind === "playlist") return null;
    const q2 = await spotifyTrackToSearchQuery(query);
    if (q2) query = q2;
  }
  if (isUrl(query)) return query;
  try {
    const out = await ytdlp(`ytsearch1:${query}`, ytdlpOpts({ dumpSingleJson: true }));
    return out?.entries?.[0]?.webpage_url || null;
  } catch (e) {
    logPretty("ERROR", "search resolve fail: " + (e?.message || e));
    return null;
  }
}

async function fetchPlaylistEntries(input, limit = null) {
  const isInputUrl = isUrl(input);
  const hardCap = Math.max(1, Number(config.playlistHardCap) || 5000);
  let max;
  if (limit === null || limit === undefined) {
    max = isInputUrl ? Infinity : 25;
  } else {
    max = Math.min(Math.max(Number(limit) || 25, 1), hardCap);
  }
  const entries = [];
  try {
    if (isInputUrl) {
      const info = await ytdlp(input, ytdlpOpts({ dumpSingleJson: true, "yes-playlist": true, "flat-playlist": true }));
      const arr = info?.entries || [];
      for (const e of arr) {
        if (Number.isFinite(max) && entries.length >= max) break;
        if (entries.length >= hardCap) break;
        const url = e?.webpage_url || e?.url || (e?.id ? `https://www.youtube.com/watch?v=${e.id}` : null);
        const title = e?.title || e?.id || "unknown";
        if (url) entries.push({ title, url });
      }
    } else {
      const n = Number.isFinite(max) ? max : 25;
      const out = await ytdlp(`ytsearch${n}:${input}`, ytdlpOpts({ dumpSingleJson: true }));
      const arr = out?.entries || [];
      for (const e of arr) {
        if (entries.length >= n) break;
        const url = e?.webpage_url || e?.url || (e?.id ? `https://www.youtube.com/watch?v=${e.id}` : null);
        const title = e?.title || e?.id || "unknown";
        if (url) entries.push({ title, url });
      }
    }
  } catch (err) {
    logPretty("ERROR", "fetchPlaylistEntries fail: " + (err?.message || err));
  }
  if (!Number.isFinite(max)) return entries;
  return entries.slice(0, max);
}

async function handlePlayerIdle(guild, state) {
  cleanupCurrentPipeline(state);
  state.currentResource = null;
  if (!state.current) return;

  const finished = state.current;
  if (!finished) return; 
  const manualSkip = state.skipRequested;
  state.skipRequested = false;
  const savedChannelId = finished.textChannelId;

  logPretty("NOWPLAY", `FINISHED  ${finished.title}`);

  state.playGeneration = (state.playGeneration || 0) + 1;

  if (state.loopMode === "track" && !manualSkip) {
    state.restartGuard.tried = false;
    await playSame(guild, savedChannelId, finished, state);
    return;
  }

  if (state.loopMode === "queue") {
    state.queue.push({ ...finished });
  }

  state.current = null;
  await playNext(guild, savedChannelId, state);
}

async function handlePlayerError(error, guild, state) {
  logPretty("ERROR", `Player error: ${error?.message || error}`);
  if (!state.current) return;
  if (state.isHandlingTransition) return; 

  if (state.isForceTransition) {
    logPretty("LOG", `Ignored error because of manual skip/stop: ${error?.message || error}`);
    return;
  }

  const currentItem = state.current;
  const savedChannelId = currentItem.textChannelId;

  if (state._activePlayGen !== state.playGeneration) {
    logPretty("LOG", `Player error from previous song (ignored, gen mismatch): ${error?.message || error}`);
    return;
  }

  state._lastErrorGen = state.skipGeneration;

  if (!state.restartGuard.tried) {
    state.restartGuard.tried = true;
    state.isHandlingTransition = true;
    logPretty("WARN", `STREAM DROP — retrying once`, { tail: currentItem.title });
    await sendToTextChannel(guild, savedChannelId, { embeds: [
      makeEmbed(COLORS.warning).setDescription("### 🔁  สัญญาณหลุด\nกำลังลองเชื่อมต่อใหม่…")
    ]});
    await playSame(guild, savedChannelId, currentItem, state);
    state.isHandlingTransition = false;
    return;
  }

  state.isHandlingTransition = true;
  const channelId = state.current?.textChannelId || savedChannelId;
  state.current = null;
  await playNext(guild, channelId, state);
  state.isHandlingTransition = false;
}

async function playNext(guild, textChannelId, state = getGuildState(guild)) {
  state.restartGuard.tried = false;
  cleanupCurrentPipeline(state);

  if (!state.queue.length) {
    state.current = null;
    state.isForceTransition = false; 
    const vc = getVoiceConnection(guild.id);
    if (vc) vc.destroy();
    logPretty("INFO", "QUEUE EMPTY — disconnecting");
    
    if (state.controlMsg) {
      try {
        await state.controlMsg.edit({
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("mc_pause_resume").setLabel("⏸️  หยุดชั่วคราว").setStyle(ButtonStyle.Primary).setDisabled(true),
            new ButtonBuilder().setCustomId("mc_skip").setLabel("⏭️  ข้ามเพลง").setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId("mc_stop").setLabel("⏹️  ปิดระบบ").setStyle(ButtonStyle.Danger).setDisabled(true),
          )],
        });
      } catch {}
      state.controlMsg = null;
    }
    await sendToTextChannel(guild, textChannelId, { embeds: [
      makeEmbed(COLORS.info).setDescription("### 📭  คิวหมดแล้ว\nเพิ่มเพลงใหม่ด้วย `/play` หรือ `n!play` ได้เลย!")
    ]});
    return;
  }

  const next = state.queue.shift();
  state.current = next;

  try {
    const { pageUrl } = await startPlayback(guild, next, state);

    logPretty("NOWPLAY", `${next.title}`, {
      user:  next.requestedBy,
      tail: `up_next: ${state.queue[0]?.title || "—"}`,
    });

    await new Promise((resolve) => {
      if (state.player.state.status === AudioPlayerStatus.Playing) {
        state.isForceTransition = false;
        return resolve();
      }
      
      const onStateChange = (oldState, newState) => {
        if (newState.status === AudioPlayerStatus.Playing) {
          state.player.removeListener("stateChange", onStateChange);
          clearTimeout(timeout);
          state.isForceTransition = false;
          resolve();
        }
      };
      
      state.player.on("stateChange", onStateChange);
      
      const timeout = setTimeout(() => {
        state.player.removeListener("stateChange", onStateChange);
        state.isForceTransition = false;
        resolve();
      }, 15000);
    });

    if (state.current !== next) return;

    const ws = wsPing();
    await sendToTextChannel(guild, next.textChannelId, {
      embeds: [buildNowPlayingEmbed(next.title, next.requestedBy, state.volumePct, ws, state.queue[0]?.title || null, false)],
      components: [buildMusicControlRow(false)],
    }).then(msg => { if (msg) state.controlMsg = msg; }).catch(() => {});
  } catch (e) {
    logPretty("ERROR", "play error: " + (e?.message || e));
    state.isForceTransition = false;
    await sendToTextChannel(guild, next.textChannelId, { embeds: [
      makeEmbed(COLORS.warning).setDescription(`### ⚠️  ข้ามเพลงนี้แล้ว\nเกิดปัญหากับ **${next?.title ?? "ไม่ทราบชื่อ"}**`)
    ]});
    state.current = null;
    await playNext(guild, textChannelId, state);
  }
}

async function playSame(guild, textChannelId, item, state = getGuildState(guild)) {
  try {
    state.current = item;
    cleanupCurrentPipeline(state);
    await startPlayback(guild, item, state);
    logPretty("WARN", `RESTARTED  ${item.title}`);
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


// 🟢 💽 ระบบสถาปัตยกรรม CACHE แบบเต็มสูบ! (ค้นหา -> โหลด -> เล่นตรงจากไฟล์) 🟢
async function startPlayback(guild, item, state) {
  ensureVC(guild, item.voiceChannelId, state);
  state._activePlayGen = state.playGeneration;

  let source = item.source;
  if (isSpotifyUrl(source)) {
    const kind = spotifyKind(source);
    if (kind === "album" || kind === "playlist") throw new Error("Spotify albums/playlists not supported in play; use /playlist");
    const q = await spotifyTrackToSearchQuery(source);
    if (!q) throw new Error("cannot resolve Spotify track title");
    source = `ytsearch1:${q}`;
  } else if (!isUrl(source)) {
    source = `ytsearch1:${source}`;
  }

  // 1. ดึงข้อมูล Video ID เบื้องต้นก่อน
  const info = await ytdlp(source, ytdlpOpts({ dumpSingleJson: true }));
  if (!info || !info.id) throw new Error("ไม่สามารถดึงข้อมูลเพลงได้");
  
  const videoId = info.id;
  const title = info.title || "Unknown Title";
  const duration = info.duration_string || `${info.duration}s`;
  
  let filePath = path.join(CACHE_DIR, `${videoId}.ogg`);
  let playFromCache = false;

  if (config.cacheEnabled) {
    // 🔍 สเตป 1: เช็คในสมุดจด (cmusic.json)
    if (cacheDB[videoId] && fs.existsSync(cacheDB[videoId].file_path)) {
      // 🎯 CACHE HIT! มีคนเคยโหลดแล้ว เล่นจากไฟล์โลด!
      logPretty("LOG", `[CACHE HIT] ⚡ ${title}`);
      cacheDB[videoId].last_played = Date.now(); // อัปเดตเวลาคนฟังล่าสุด
      saveCacheDB();
      filePath = cacheDB[videoId].file_path;
      playFromCache = true;
    } else {
      // 📥 CACHE MISS! เพิ่งมีคนฟังครั้งแรก ต้องไปโหลดจาก YouTube
      logPretty("LOG", `[CACHE MISS] 📥 กำลังดาวน์โหลด: ${title}`);
      
      // ส่งข้อความบอกในช่องแชทว่ากำลังโหลดอยู่ จะได้ไม่งงว่าทำไมเพลงยังไม่ขึ้น
      let cacheMsg = null;
      try {
        cacheMsg = await sendToTextChannel(guild, item.textChannelId, { embeds: [
          makeEmbed(COLORS.info).setDescription(`### 📥 กำลังแคชไฟล์เสียง\n**${title}**\n*(ดึงเพลงครั้งแรกอาจใช้เวลาสักครู่...)*`)
        ]});
      } catch(e) {}

      // คำสั่งโหลดไฟล์เก็บลงโฟลเดอร์ cmusic
      const dlArgs = [
        "--no-check-certificates",
        "--force-ipv4",
        "-f", "bestaudio/best",
        "-x", "--audio-format", "opus",
        "-o", path.join(CACHE_DIR, `${videoId}.%(ext)s`),
        info.webpage_url || info.original_url || source
      ];
      if (config.cookieFile) dlArgs.push("--cookies", config.cookieFile);
      
      try {
         await ytdlp(dlArgs); // รอจนกว่าโหลดเสร็จ
         
         // yt-dlp อาจจะโหลดมาเป็น .opus, .ogg, .webm เราต้องหาให้เจอว่ามันเซฟเป็นไฟล์อะไร
         const possibleExts = [".opus", ".ogg", ".webm", ".m4a", ".mp3"];
         let foundPath = null;
         for (const ext of possibleExts) {
             const testPath = path.join(CACHE_DIR, `${videoId}${ext}`);
             if (fs.existsSync(testPath)) {
                 foundPath = testPath;
                 break;
             }
         }
         
         if (foundPath) {
             filePath = foundPath; 
             // เขียนจดจำลงสมุด cmusic.json
             cacheDB[videoId] = {
                 title: title,
                 duration: duration,
                 file_path: filePath,
                 last_played: Date.now()
             };
             saveCacheDB();
             playFromCache = true;
             logPretty("LOG", `[CACHE SAVED] 💾 บันทึกไฟล์ ${videoId} เรียบร้อย`);
         } else {
             logPretty("WARN", "Download finished but file not found. Falling back to stream.");
         }
      } catch (err) {
         logPretty("ERROR", `Cache download failed: ${err.message}`);
      }

      // โหลดเสร็จแล้ว ลบข้อความ "กำลังแคชไฟล์" ทิ้ง
      if (cacheMsg) cacheMsg.delete().catch(()=>{});
    }
  }

  let resource;
  if (playFromCache) {
      // 🚀 สเตป 2: โยนไฟล์ในเครื่องให้ FFmpeg (ความเร็วระดับสายฟ้าแลบ)
      const a = [
        "-loglevel", "quiet", 
        "-i", filePath,
        "-vn", "-ac", String(config.audioChannels), "-ar", String(config.audioSampleRate),
        "-c:a", "libopus", 
        "-b:a", config.opusBitrate,
        "-f", "ogg", "pipe:1"
      ];
      const ff = spawn(FFMPEG || "ffmpeg", a, { stdio: ["ignore", "pipe", "pipe"] });
      
      state.currentPipe = { ff, stream: ff.stdout };
      resource = createAudioResource(ff.stdout, { inputType: StreamType.OggOpus, inlineVolume: true });
  } else {
      logPretty("WARN", "เล่นจากอินเทอร์เน็ตสด (Fallback)");
      const pipeObj = spawnUniversalPipe(source);
      state.currentPipe = pipeObj;
      resource = createAudioResource(pipeObj.stream, { inputType: StreamType.OggOpus, inlineVolume: true });
  }

  state.currentResource = resource;
  applyVolume(state);
  state.player.play(resource);
  return { pageUrl: source };
}

function setVolumePct(state, pct){
  if (pct < 0) pct = 0;
  if (pct > 10000) pct = 10000;
  state.volumePct = pct;
  applyVolume(state);
}

client.on("error", (e) => logPretty("ERROR", `Client error: ${e?.message || e}`));
process.on("unhandledRejection", (e) => logPretty("ERROR", `unhandledRejection: ${e}`));

const restClient = new REST({ version: "10" }).setToken(config.token);
client.once(Events.ClientReady, async () => {
  const tag = client.user.tag;
  const guildCount = client.guilds.cache.size;
  console.log("");
  console.log(`  ${C.bold}${C.bgGreen}\x1b[30m  ✓ ONLINE  ${R}  ${C.bold}${C.green}${tag}${R}  ${C.gray}·${R}  ${C.white}${guildCount} server(s)${R}`);
  console.log("");
  try {
    await restClient.put(Routes.applicationCommands(client.user.id), { body: commands });
    logPretty("SYSTEM", "Slash commands registered");
  } catch (e) {
    logPretty("ERROR", "register error: " + (e?.message || e));
  }
  if (config.ytdlpAutoUpdate) {
    scheduleDailyBangkokMidnight(() => runYtDlpUpdate());
    const ONE_DAY = 24 * 3600 * 1000;
    if (Date.now() - readLastUpdateTs() > ONE_DAY) runYtDlpUpdate();
  }
});

client.on("interactionCreate", async (itx) => {
  if (itx.isButton()) {
    const id = itx.customId;
    if (!["mc_pause_resume", "mc_skip", "mc_stop"].includes(id)) return;

    const rttRaw = Date.now() - itx.createdTimestamp;
    const rtt = rttRaw < 0 ? 0 : rttRaw;
    const actionName = id === "mc_pause_resume" ? "pause/resume" : id === "mc_skip" ? "skip" : "stop";
    logPretty("COMMAND", `[BTN] ${actionName}`, { user: itx.user.tag, guild: itx.guild?.name || "Unknown", rtt });

    if (!itx.guild) return await itx.reply({ content: "ใช้ได้ในเซิร์ฟเวอร์เท่านั้น", ephemeral: true });

    const state = getGuildState(itx.guild);
    const userVC = itx.member?.voice?.channelId;
    const botVC  = itx.guild.members.me?.voice?.channelId;

    if (!userVC || (botVC && botVC !== userVC)) {
      return itx.reply({ embeds: [errorEmbed("กรุณาเข้าห้องเสียงเดียวกับบอทก่อนนะ 🎙️")], ephemeral: true });
    }

    if (id === "mc_pause_resume") {
      const isPaused = state.player.state.status === AudioPlayerStatus.Paused;
      if (isPaused) {
        state.player.unpause();
      } else {
        state.player.pause();
      }
      const nowPaused = !isPaused;
      if (state.controlMsg && state.current) {
        try {
          await state.controlMsg.edit({
            embeds: [buildNowPlayingEmbed(
              state.current.title, state.current.requestedBy,
              state.volumePct, wsPing(), state.queue[0]?.title || null, nowPaused
            )],
            components: [buildMusicControlRow(nowPaused)],
          });
        } catch {}
      }
      return itx.reply({ embeds: [
        nowPaused
          ? infoEmbed("⏸️  หยุดชั่วคราว", "กด **เล่นต่อ** ที่ปุ่มด้านบนเพื่อเล่นต่อ")
          : successEmbed("▶️  เล่นต่อแล้ว", `กำลังเล่น: **${state.current?.title || "—"}**`)
      ], ephemeral: true });
    }

    if (id === "mc_skip") {
      if (!state.current) return itx.reply({ embeds: [infoEmbed("ℹ️  ไม่มีเพลงกำลังเล่น", "")], ephemeral: true });
      
      if (state.queue.length === 0 && state.loopMode !== "queue") {
        state.isForceTransition = true;
        state.current = null;
        state.loopMode = "off";
        state.skipRequested = false;
        if (state.controlMsg) {
          try {
            await state.controlMsg.edit({
              components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("mc_pause_resume").setLabel("⏸️  หยุดชั่วคราว").setStyle(ButtonStyle.Primary).setDisabled(true),
                new ButtonBuilder().setCustomId("mc_skip").setLabel("⏭️  ข้ามเพลง").setStyle(ButtonStyle.Secondary).setDisabled(true),
                new ButtonBuilder().setCustomId("mc_stop").setLabel("⏹️  ปิดระบบ").setStyle(ButtonStyle.Danger).setDisabled(true),
              )],
            });
          } catch {}
          state.controlMsg = null;
        }
        cleanupCurrentPipeline(state);
        state.player.stop(true);
        const vc = getVoiceConnection(itx.guild.id);
        if (vc) vc.destroy();
        return itx.reply({ embeds: [successEmbed("⏭️  ข้ามเพลงสุดท้ายแล้ว!", "คิวว่างเปล่า บอทขอตัวออกจากห้องเสียงนะ 👋")] });
      }

      state.isForceTransition = true;
      state.skipRequested = true;
      state.skipGeneration = (state.skipGeneration || 0) + 1;
      
      if (state.controlMsg) {
        try {
          await state.controlMsg.edit({
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("mc_pause_resume").setLabel("⏸️  หยุดชั่วคราว").setStyle(ButtonStyle.Primary).setDisabled(true),
              new ButtonBuilder().setCustomId("mc_skip").setLabel("⏭️  ข้ามเพลง").setStyle(ButtonStyle.Secondary).setDisabled(true),
              new ButtonBuilder().setCustomId("mc_stop").setLabel("⏹️  ปิดระบบ").setStyle(ButtonStyle.Danger).setDisabled(true),
            )],
          });
        } catch {}
        state.controlMsg = null;
      }
      cleanupCurrentPipeline(state); 
      state.player.stop(true);       
      return itx.reply({ embeds: [successEmbed("⏭️  ข้ามเพลงแล้ว", state.queue.length ? `ถัดไป: **${state.queue[0]?.title || "—"}**` : "คิวหมดแล้ว")] });
    }

    if (id === "mc_stop") {
      state.isForceTransition = true;
      state.queue = [];
      state.current = null;
      state.loopMode = "off";
      state.skipRequested = false;
      if (state.controlMsg) {
        try {
          await state.controlMsg.edit({
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("mc_pause_resume").setLabel("⏸️  หยุดชั่วคราว").setStyle(ButtonStyle.Primary).setDisabled(true),
              new ButtonBuilder().setCustomId("mc_skip").setLabel("⏭️  ข้ามเพลง").setStyle(ButtonStyle.Secondary).setDisabled(true),
              new ButtonBuilder().setCustomId("mc_stop").setLabel("⏹️  ปิดระบบ").setStyle(ButtonStyle.Danger).setDisabled(true),
            )],
          });
        } catch {}
        state.controlMsg = null;
      }
      cleanupCurrentPipeline(state); 
      state.player.stop(true);       
      const vc = getVoiceConnection(itx.guild.id);
      if (vc) vc.destroy();
      return itx.reply({ embeds: [successEmbed("⏹️  ปิดระบบแล้ว", "ล้างคิวและออกจากห้องเสียงเรียบร้อย")] });
    }
  }
});

client.on("interactionCreate", async (itx) => {
  if (!itx.isChatInputCommand()) return;
  const rttRaw = Date.now() - itx.createdTimestamp;
  const rtt = rttRaw < 0 ? 0 : rttRaw;
  logPretty("COMMAND", `/${itx.commandName}`, { user: itx.user.tag, guild: itx.guild.name, rtt });

  if (itx.commandName === "help") {
    return itx.reply({ embeds: [buildHelpEmbedSlash()], ephemeral: false });
  }

  const me = itx.guild.members.me;
  const userVC = itx.member?.voice?.channelId;
  const botVC = me?.voice?.channelId;
  const sameVC = userVC && (!botVC || botVC === userVC);

  const needsSameVC = !["help","ping", "botupdate", "np", "queue"].includes(itx.commandName);

  if (needsSameVC && !sameVC) {
    return itx.reply({ embeds: [errorEmbed("กรุณาเข้าห้องเสียงเดียวกับบอทก่อนนะ 🎙️")], ephemeral: true });
  }

  const state = getGuildState(itx.guild);

  if (itx.commandName === "ping") {
    await itx.reply({ embeds: [
      makeEmbed(COLORS.info).setDescription("### 🏓  Pong!").addFields(
          { name: "🌐 WebSocket", value: `\`${Math.round(itx.client.ws.ping)} ms\``, inline: true },
          { name: "⏱️ RTT", value: `\`${rtt} ms\``, inline: true },
        )
    ]});
    return;
  }

  if (itx.commandName === "botupdate") {
    await itx.deferReply({ ephemeral: true });
    await runYtDlpUpdate((msg) => itx.editReply({ embeds: [
      msg.startsWith("✅") ? successEmbed("✅  อัปเดตสำเร็จ", "yt-dlp อัปเดตเรียบร้อยแล้ว")
        : msg.startsWith("⏳") ? infoEmbed("⏳  กำลังอัปเดต", "กระบวนการอัปเดต yt-dlp กำลังทำงาน") : errorEmbed(msg)
    ], content: "" }));
    return;
  }

  if (itx.commandName === "play") {
    await itx.deferReply();
    const q = itx.options.getString("query");
    const title = await getTitle(q);
    state.queue.push({ title, source: q, requestedBy: itx.user.tag, guild: itx.guild, voiceChannelId: userVC, textChannelId: itx.channelId });
    await itx.editReply({ embeds: [
      makeEmbed(COLORS.success).setDescription(`### ➕  เพิ่มเพลงเข้าคิวแล้ว`)
        .addFields(
          { name: "🎵 เพลง", value: `**${title}**`, inline: false },
          { name: "📋 ลำดับในคิว", value: `\`#${state.queue.length}\``, inline: true },
          { name: "👤 ขอโดย", value: `${itx.user}`, inline: true },
        )
    ]});
    if (!state.current) playNext(itx.guild, itx.channelId, state);
    else updateControlMsgIfNeeded(state);
    return;
  }

  if (itx.commandName === "skip") {
    if (!state.current) return itx.reply({ embeds: [infoEmbed("ℹ️  ไม่มีเพลงกำลังเล่น", "")], ephemeral: true });
    
    if (state.queue.length === 0 && state.loopMode !== "queue") {
      state.isForceTransition = true;
      state.current = null;
      state.loopMode = "off";
      state.skipRequested = false;
      if (state.controlMsg) {
        try {
          await state.controlMsg.edit({
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("mc_pause_resume").setLabel("⏸️  หยุดชั่วคราว").setStyle(ButtonStyle.Primary).setDisabled(true),
              new ButtonBuilder().setCustomId("mc_skip").setLabel("⏭️  ข้ามเพลง").setStyle(ButtonStyle.Secondary).setDisabled(true),
              new ButtonBuilder().setCustomId("mc_stop").setLabel("⏹️  ปิดระบบ").setStyle(ButtonStyle.Danger).setDisabled(true),
            )],
          });
        } catch {}
        state.controlMsg = null;
      }
      cleanupCurrentPipeline(state);
      state.player.stop(true);
      const vc = getVoiceConnection(itx.guild.id);
      if (vc) vc.destroy();
      return itx.reply({ embeds: [successEmbed("⏭️  ข้ามเพลงสุดท้ายแล้ว!", "คิวว่างเปล่า บอทขอตัวออกจากห้องเสียงนะ 👋")] });
    }

    state.isForceTransition = true;
    state.skipRequested = true;
    state.skipGeneration = (state.skipGeneration || 0) + 1;
    
    if (state.controlMsg) {
      try {
        await state.controlMsg.edit({
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("mc_pause_resume").setLabel("⏸️  หยุดชั่วคราว").setStyle(ButtonStyle.Primary).setDisabled(true),
            new ButtonBuilder().setCustomId("mc_skip").setLabel("⏭️  ข้ามเพลง").setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId("mc_stop").setLabel("⏹️  ปิดระบบ").setStyle(ButtonStyle.Danger).setDisabled(true),
          )],
        });
      } catch {}
      state.controlMsg = null;
    }
    cleanupCurrentPipeline(state); 
    state.player.stop(true);       
    await itx.reply({ embeds: [successEmbed("⏭️  ข้ามเพลงแล้ว", state.queue.length ? `ถัดไป: **${state.queue[0]?.title || "—"}**` : "คิวหมดแล้ว")] });
    return;
  }

  if (itx.commandName === "stop") {
    state.isForceTransition = true;
    state.queue = [];
    state.current = null;
    state.loopMode = "off";
    state.skipRequested = false;
    if (state.controlMsg) {
      try {
        await state.controlMsg.edit({
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("mc_pause_resume").setLabel("⏸️  หยุดชั่วคราว").setStyle(ButtonStyle.Primary).setDisabled(true),
            new ButtonBuilder().setCustomId("mc_skip").setLabel("⏭️  ข้ามเพลง").setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId("mc_stop").setLabel("⏹️  ปิดระบบ").setStyle(ButtonStyle.Danger).setDisabled(true),
          )],
        });
      } catch {}
      state.controlMsg = null;
    }
    cleanupCurrentPipeline(state); 
    state.player.stop(true);       
    const vc = getVoiceConnection(itx.guild.id);
    if (vc) vc.destroy();
    await itx.reply({ embeds: [successEmbed("🛑  หยุดเพลงแล้ว", "ล้างคิวและออกจากห้องเสียงเรียบร้อย")] });
    return;
  }

  if (itx.commandName === "pause") {
    state.player.pause();
    updateControlMsgIfNeeded(state);
    await itx.reply({ embeds: [infoEmbed("⏸️  หยุดชั่วคราว", "พิมพ์ `/resume` เพื่อเล่นต่อ")] });
    return;
  }

  if (itx.commandName === "resume") {
    state.player.unpause();
    updateControlMsgIfNeeded(state);
    await itx.reply({ embeds: [successEmbed("▶️  เล่นต่อแล้ว", `กำลังเล่น: **${state.current?.title || "—"}**`)] });
    return;
  }

  if (itx.commandName === "np") {
    if (!state.current) return itx.reply({ embeds: [infoEmbed("🎵  ไม่มีเพลงกำลังเล่น", "ใช้ `/play query:<ชื่อเพลง>` เพื่อเริ่มเล่น")] });
    const embed = makeEmbed(COLORS.music).setDescription(`### 🎶  Now Playing`)
      .addFields(
        { name: "🎵 เพลง", value: `**${state.current.title}**`, inline: false },
        { name: "👤 ขอโดย", value: state.current.requestedBy, inline: true },
        { name: "🔊 ระดับเสียง", value: `${state.volumePct}%`, inline: true },
        { name: "🔁 Loop", value: loopLabel(state.loopMode), inline: true },
        { name: "📋 คิวที่เหลือ", value: `${state.queue.length} เพลง`, inline: true },
      );
    return itx.reply({ embeds: [embed] });
  }

  if (itx.commandName === "queue") {
    if (!state.queue.length) return itx.reply({ embeds: [infoEmbed("📭  คิวว่างเปล่า", "ใช้ `/play query:<ชื่อเพลง>` เพื่อเพิ่มเพลง")] });
    const lines = state.queue.slice(0, 10).map((x, i) => `\`${String(i+1).padStart(2,"0")}.\` **${x.title}**\n　　👤 ${x.requestedBy}`).join("\n");
    const more = state.queue.length > 10 ? `\n*… และอีก **${state.queue.length - 10}** เพลง*` : "";
    return itx.reply({ embeds: [
      makeEmbed(COLORS.queue).setDescription(`### 📋  คิวเพลง`)
        .addFields(
          { name: `รายการ (${Math.min(state.queue.length, 10)}/${state.queue.length})`, value: lines + more, inline: false },
          { name: "🔁 Loop", value: loopLabel(state.loopMode), inline: true },
          { name: "🎵 กำลังเล่น", value: state.current ? `**${state.current.title}**` : "—", inline: true },
        )
    ]});
  }

  if (itx.commandName === "volume") {
    const v = itx.options.getInteger("value");
    setVolumePct(state, v);
    updateControlMsgIfNeeded(state);
    const bar = "█".repeat(Math.round(Math.min(state.volumePct, 200) / 20)) + "░".repeat(10 - Math.round(Math.min(state.volumePct, 200) / 20));
    return itx.reply({ embeds: [successEmbed("🔊  ปรับระดับเสียงแล้ว", `\`${bar}\` **${state.volumePct}%**`)] });
  }

  if (itx.commandName === "playlist") {
    await itx.deferReply();
    const q = itx.options.getString("query");
    const limit = itx.options.getInteger("limit");

    const items = await fetchPlaylistEntries(q, limit);
    if (!items.length) {
      return itx.editReply({ embeds: [errorEmbed("ไม่พบเพลงในเพลย์ลิสต์หรือผลการค้นหา")] });
    }

    for (const { title, url } of items) {
      state.queue.push({ title, source: url, requestedBy: itx.user.tag, guild: itx.guild, voiceChannelId: itx.member?.voice?.channelId, textChannelId: itx.channelId });
    }

    const preview = items.slice(0, 5).map((x, i) => `\`${i + 1}.\` ${x.title}`).join("\n");
    const more = items.length > 5 ? `\n*… และอีก ${items.length - 5} เพลง*` : "";
    await itx.editReply({ embeds: [
      makeEmbed(COLORS.queue).setDescription(`### 📚  โหลด Playlist สำเร็จ`)
        .addFields(
          { name: "🎶 เพลงทั้งหมด", value: `**${items.length} เพลง**`, inline: true },
          { name: "👤 ขอโดย", value: `${itx.user}`, inline: true },
          { name: "📋 รายการแรก", value: `${preview}${more}`, inline: false },
        )
    ]});

    if (!state.current) playNext(itx.guild, itx.channelId, state);
    else updateControlMsgIfNeeded(state);
    return;
  }

  if (itx.commandName === "remove") {
    if (!state.queue.length) return itx.reply({ embeds: [infoEmbed("📭  คิวว่างเปล่า", "ไม่มีเพลงในคิวให้ลบ")] });
    const index = itx.options.getInteger("index");
    if (index < 1 || index > state.queue.length) {
      return itx.reply({ embeds: [errorEmbed(`หมายเลขลำดับไม่ถูกต้อง (มีอยู่ ${state.queue.length} เพลง)`)], ephemeral: true });
    }
    const [removed] = state.queue.splice(index - 1, 1);
    updateControlMsgIfNeeded(state);
    return itx.reply({ embeds: [successEmbed("🗑️  ลบเพลงออกจากคิวแล้ว", `**${removed.title}**`)] });
  }

  if (itx.commandName === "shuffle") {
    if (state.queue.length < 2) return itx.reply({ embeds: [infoEmbed("🔀  ไม่สามารถสุ่มได้", "ต้องมีเพลงในคิวอย่างน้อย 2 เพลง")] });
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
    updateControlMsgIfNeeded(state);
    return itx.reply({ embeds: [successEmbed("🔀  สุ่มคิวแล้ว", `สลับลำดับ **${state.queue.length} เพลง** เรียบร้อย`)] });
  }

  if (itx.commandName === "loop") {
    const mode = itx.options.getString("mode");
    state.loopMode = mode;
    return itx.reply({ embeds: [successEmbed("🔁  ตั้งค่า Loop แล้ว", `โหมดปัจจุบัน: **${loopLabel(mode)}**`)] });
  }
});

client.login(config.token);
