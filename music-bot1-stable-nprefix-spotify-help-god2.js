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
const config = {
  // Port for the HTTP keep‑alive server
  port: Number(process.env.PORT) || 3000,
  // Discord bot token – MUST be set in the environment; if missing, the bot
  // will still attempt to start but login will fail.
  token: process.env.TOKEN || "",
  // Optional explicit path to ffmpeg; if empty, ffmpeg-static or system ffmpeg is used
  ffmpegPath: process.env.FFMPEG_PATH || null,
  // Path to a yt-dlp cookies file; used for age/region restricted videos
  cookieFile: process.env.YTDLP_COOKIES_PATH || null,
  // Directory to store log files; relative paths are resolved from cwd
  logDir: process.env.LOG_DIR || path.join(process.cwd(), "logs"),
  // Directory to store data files (e.g., yt-dlp update marker)
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), "data"),
  // Whether to show detailed ffmpeg logs in the console
  debugFfmpeg: (process.env.DEBUG_FFMPEG || "false").toLowerCase() === "true",
  // Default volume percentage when a guild state is created (0–1000)
  defaultVolume: Math.max(0, Math.min(1000, Number(process.env.DEFAULT_VOLUME) || 100)),
  // Default loop mode: off | track | queue
  defaultLoop: (() => {
    const raw = (process.env.DEFAULT_LOOP_MODE || "off").toLowerCase();
    return ["off", "track", "queue"].includes(raw) ? raw : "off";
  })(),
  // Timezone offset for scheduling yt-dlp updates, in hours (e.g. 7 for Bangkok)
  timezoneOffsetHours: Number(process.env.TIMEZONE_OFFSET_HOURS) || 7,
  // Force yt-dlp to use IPv4 instead of IPv6
  ytdlpForceIpv4: (process.env.YTDLP_FORCE_IPV4 || "true").toLowerCase() === "true",
  // Whether to automatically update yt-dlp at midnight local time
  ytdlpAutoUpdate: (process.env.YTDLP_AUTO_UPDATE || "true").toLowerCase() === "true",

  // Hard cap for /playlist to prevent excessive memory/time usage
  playlistHardCap: Math.max(1, Number(process.env.PLAYLIST_HARD_CAP) || 5000),

  // ===== Audio quality controls (.env) =====
  audioChannels: Math.min(2, Math.max(1, Number(process.env.AUDIO_CHANNELS) || 2)),
  audioSampleRate: Number(process.env.AUDIO_SAMPLE_RATE) || 48000,
  opusBitrate: (process.env.OPUS_BITRATE || "128k").toLowerCase(),
  opusVbr: (process.env.OPUS_VBR || "on").toLowerCase(),
  opusApplication: (process.env.OPUS_APPLICATION || "audio").toLowerCase(),
  opusFrameDuration: Number(process.env.OPUS_FRAME_DURATION) || 20,
  opusComplexity: Math.max(0, Math.min(10, Number(process.env.OPUS_COMPLEXITY) ?? 8)),
  audioFilter: process.env.AUDIO_FILTER || "",
  ffmpegLowLatency: (process.env.FFMPEG_LOW_LATENCY || "true").toLowerCase() === "true",
  ffmpegInputAnalyzeMs: Math.max(0, Number(process.env.FFMPEG_INPUT_ANALYZE_MS) || 0),
  ffmpegReconnectDelayMax: Math.max(1, Number(process.env.FFMPEG_RECONNECT_DELAY_MAX) || 10),
  ffmpegExtraArgs: process.env.FFMPEG_EXTRA_ARGS || "",
};

// Print out a summary of the configuration and environment variables. Sensitive
// values such as the bot token are not printed directly; instead we indicate
// whether they are set. This runs immediately so users can verify their
// `.env` settings when starting the bot.
function logConfiguration() {
  const entries = [
    { key: "port", env: "PORT" },
    { key: "token", env: "TOKEN", mask: true },
    { key: "ffmpegPath", env: "FFMPEG_PATH" },
    { key: "cookieFile", env: "YTDLP_COOKIES_PATH" },
    { key: "logDir", env: "LOG_DIR" },
    { key: "dataDir", env: "DATA_DIR" },
    { key: "debugFfmpeg", env: "DEBUG_FFMPEG" },
    { key: "defaultVolume", env: "DEFAULT_VOLUME" },
    { key: "defaultLoop", env: "DEFAULT_LOOP_MODE" },
    { key: "timezoneOffsetHours", env: "TIMEZONE_OFFSET_HOURS" },
    { key: "ytdlpForceIpv4", env: "YTDLP_FORCE_IPV4" },
    { key: "ytdlpAutoUpdate", env: "YTDLP_AUTO_UPDATE" },
    { key: "audioChannels", env: "AUDIO_CHANNELS" },
    { key: "audioSampleRate", env: "AUDIO_SAMPLE_RATE" },
    { key: "opusBitrate", env: "OPUS_BITRATE" },
    { key: "opusVbr", env: "OPUS_VBR" },
    { key: "opusApplication", env: "OPUS_APPLICATION" },
    { key: "opusFrameDuration", env: "OPUS_FRAME_DURATION" },
    { key: "opusComplexity", env: "OPUS_COMPLEXITY" },
    { key: "audioFilter", env: "AUDIO_FILTER" },
    { key: "ffmpegLowLatency", env: "FFMPEG_LOW_LATENCY" },
    { key: "ffmpegInputAnalyzeMs", env: "FFMPEG_INPUT_ANALYZE_MS" },
    { key: "ffmpegReconnectDelayMax", env: "FFMPEG_RECONNECT_DELAY_MAX" },
    { key: "ffmpegExtraArgs", env: "FFMPEG_EXTRA_ARGS" },
  ];
  // We want to simulate loading the .env file by printing a message
  // and waiting a short time before outputting the configuration.  Using
  // an Atomics.wait call lets us block synchronously without complicating
  // the asynchronous flow elsewhere in the program.  This approach
  // guarantees that the loading message appears before the variables
  // themselves, and avoids interleaving logs due to unresolved promises.
  console.log("--------------------------------");
  // Thai text explains the wait – it will show up in the console to
  // indicate a brief pause while reading the .env file.
  console.log(
    "[BOT] loading .env"
  );
  console.log("--------------------------------");
  // Block for 1000ms to simulate reading the .env file
  try {
    const sab = new SharedArrayBuffer(4);
    const ia = new Int32Array(sab);
    // Atomics.wait returns 'timed-out' when the timeout expires
    Atomics.wait(ia, 0, 0, 1000);
  } catch {
    // Fall back to a non-blocking setTimeout if Atomics.wait is unavailable
    const end = Date.now() + 1000;
    while (Date.now() < end) {
      // busy loop
    }
  }
  for (const entry of entries) {
    const used = config[entry.key];
    let displayValue;
    if (entry.mask) {
      displayValue = used ? "[set]" : "[not set]";
    } else {
      displayValue = used;
    }
    // Print in the form "<ENV_NAME>:<value>" with a single leading space
    console.log(` ${entry.env}:${displayValue}`);
    console.log("--------------------------------");
  }
}
// Invoke the configuration logger early so users see settings on startup
logConfiguration();
console.log("[BOT] Starting now");
console.log("--------------------------------")
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

// Keep‑alive HTTP server for Railway/Render
// Use the configured port rather than reading directly from process.env
http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Discord music bot is running");
}).listen(config.port);
// ffmpeg setup and availability
let FFMPEG = null;
let FFMPEG_AVAILABLE = false;
// Determine the ffmpeg binary. If the user specifies a custom path via
// configuration, prefer that. Otherwise fall back to ffmpeg-static and
// finally to the system ffmapeg.
try {
  if (config.ffmpegPath) {
    // Use the explicit path provided in config
    FFMPEG = config.ffmpegPath;
    FFMPEG_AVAILABLE = true;
  } else {
    // Attempt to load the ffmpeg-static module
    FFMPEG = require("ffmpeg-static");
    if (FFMPEG) FFMPEG_AVAILABLE = true;
  }
} catch {}

// yt-dlp and cookie configuration
const ytdlp = require("yt-dlp-exec");
// Build yt-dlp option defaults based off of the configuration. Cookies and
// force-ipv4 can be toggled via .env.
function ytdlpOpts(extra = {}) {
  const base = {
    // Skip certificate validation; yt-dlp defaults to secure connections but this avoids SSL errors
    noCheckCertificates: true,
    // Retry endlessly for robust downloads
    retries: "infinite",
    "fragment-retries": "infinite",
    // Respect configured IPv4 forcing
    "force-ipv4": config.ytdlpForceIpv4,
    "js-runtimes": "node",
  };
  if (config.cookieFile) base.cookies = config.cookieFile;
  return { ...base, ...extra };
}

// Logging setup
// Ensure log directory exists based on configuration
const LOG_DIR = config.logDir;
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
// Define two log files: one for general logs and one for detailed debug logs (including ffmpeg)
// The general log omits ffmpeg debug output, while the debug log always includes everything
const LOG_FILE_MAIN = path.join(LOG_DIR, "bot.log");
const LOG_FILE_DEBUG = path.join(LOG_DIR, "bot-debug.log");

// ─── ANSI colour palette ────────────────────────────────────────────────────
const C = {
  reset:    "\x1b[0m",
  bold:     "\x1b[1m",
  dim:      "\x1b[2m",
  // foreground
  white:    "\x1b[97m",
  gray:     "\x1b[90m",
  cyan:     "\x1b[96m",
  green:    "\x1b[92m",
  yellow:   "\x1b[93m",
  red:      "\x1b[91m",
  magenta:  "\x1b[95m",
  blue:     "\x1b[94m",
  // background
  bgBlue:   "\x1b[44m",
  bgGreen:  "\x1b[42m",
  bgRed:    "\x1b[41m",
  bgYellow: "\x1b[43m",
  bgCyan:   "\x1b[46m",
  bgMagenta:"\x1b[45m",
  bgGray:   "\x1b[100m",
};
const R = C.reset;

// ─── Timestamp ───────────────────────────────────────────────────────────────
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

// ─── WS ping helper ──────────────────────────────────────────────────────────
let _clientForPing = null;
function wsPing() {
  try { return Math.round(_clientForPing?.ws?.ping || 0); } catch { return 0; }
}

// ─── File logger (plain text, no ANSI) ───────────────────────────────────────
function writeLog(line, isDebug = false) {
  // strip ANSI before writing to file
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  try { fs.appendFileSync(LOG_FILE_DEBUG, plain + "\n", "utf8"); } catch {}
  if (!isDebug) {
    try { fs.appendFileSync(LOG_FILE_MAIN, plain + "\n", "utf8"); } catch {}
  }
}

// ─── Log type config ─────────────────────────────────────────────────────────
//  Each entry: { icon, label, labelColor, bgColor }
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

// ─── Main pretty logger ───────────────────────────────────────────────────────
//
//  Output format (one line):
//  HH:MM:SS  ▌ TYPE ▌  message details
//
//  extra fields (all optional):
//    user    – Discord username
//    guild   – server name
//    rtt     – round-trip time ms (slash commands)
//    tail    – free-form suffix appended after the details
//
function logPretty(type, msg, extra = {}) {
  const cfg = LOG_TYPES[type] || LOG_TYPES.INFO;
  const isDebug = (type === "LOG");

  const ws  = wsPing();
  const ts  = `${C.dim}${C.gray}${nowStrShort()}${R}`;

  // ── badge ──  e.g.  ❯ CMD
  const badge = `${C.bold}${cfg.bg}\x1b[30m ${cfg.icon} ${cfg.label.padEnd(6)} ${R}`;

  // ── message body ──
  const body  = `${C.bold}${cfg.fg}${msg}${R}`;

  // ── meta row: ping / rtt / user / guild ──
  const parts = [];
  parts.push(`${C.gray}ping ${C.white}${ws}ms${R}`);
  if (extra.rtt  !== undefined) parts.push(`${C.gray}rtt ${C.white}${extra.rtt}ms${R}`);
  if (extra.user)  parts.push(`${C.gray}user ${C.cyan}${extra.user}${R}`);
  if (extra.guild) parts.push(`${C.gray}srv ${C.white}${extra.guild}${R}`);
  if (extra.tail)  parts.push(`${C.dim}${extra.tail}${R}`);
  const meta = parts.join(`  ${C.gray}·${R}  `);

  // ── assemble ──
  const sep   = `${C.gray}│${R}`;
  const line  = `${ts}  ${badge}  ${body}  ${sep}  ${meta}`;

  // plain version for file (ANSI stripped inside writeLog)
  const plain = `[${nowStr()}] [${cfg.label}] ${msg}` +
    ` | ping=${ws}ms` +
    (extra.rtt   ? ` rtt=${extra.rtt}ms`    : "") +
    (extra.user  ? ` user=${extra.user}`     : "") +
    (extra.guild ? ` srv=${extra.guild}`     : "") +
    (extra.tail  ? ` | ${extra.tail}`        : "");

  writeLog(plain, isDebug);
  if (!isDebug || DEBUG_FFMPEG) {
    console.log(line);
  }
}
function swallowPipeError(err){
  const msg = String(err?.message || err || "");
  if (msg.includes("EPIPE") || msg.includes("ERR_STREAM_DESTROYED")) return;
  logPretty("ERROR", "pipe error: " + msg);
}
// Use the configured debug flag for ffmpeg logging
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

// yt-dlp automatic update scheduling (Bangkok midnight)
const DATA_DIR = config.dataDir;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const UPDATE_MARK_FILE = path.join(DATA_DIR, "yt-dlp.last");
// Calculate timezone offset in milliseconds based on configuration (hours → ms)
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

// Discord client
const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
] });
_clientForPing = client;

// --- Prefix commands (e.g., n!play ...) ---
const BOT_PREFIX = (process.env.BOT_PREFIX || process.env.COMMAND_PREFIX || "n!").trim();
// NOTE: avoid process.env.PREFIX because Termux sets PREFIX=/data/... by default.

function buildHelpEmbedPrefix(){
  const p = BOT_PREFIX;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("🎵 Music Bot — คู่มือการใช้งาน")
    .setDescription(`> ใช้คำสั่งด้วย prefix **\`${p}\`** ตัวอย่าง: \`${p}play lofi hip hop\`\n> รองรับ **YouTube · SoundCloud · TikTok · Spotify** (track)`)
    .addFields(
      {
        name: "╔══════════════════════════╗",
        value: "** ** ",
        inline: false,
      },
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
      {
        name: "╚══════════════════════════╝",
        value: "** **",
        inline: false,
      },
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
      {
        name: "╔══════════════════════════╗",
        value: "** **",
        inline: false,
      },
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
      {
        name: "╚══════════════════════════╝",
        value: "** **",
        inline: false,
      },
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

// ─── Embed helper functions ────────────────────────────────────────────────
const COLORS = {
  primary:  0x5865F2, // Discord Blurple
  success:  0x57F287, // Green
  warning:  0xFEE75C, // Yellow
  error:    0xED4245, // Red
  info:     0x5DADE2, // Blue
  music:    0xE91E63, // Pink/Music
  queue:    0x9B59B6, // Purple
};

function makeEmbed(color = COLORS.primary) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

function successEmbed(title, description) {
  return makeEmbed(COLORS.success)
    .setDescription(`### ${title}\n${description ? `${description}` : ""}`);
}

function errorEmbed(description) {
  return makeEmbed(COLORS.error)
    .setDescription(`### ❌  เกิดข้อผิดพลาด\n${description}`);
}

function infoEmbed(title, description) {
  return makeEmbed(COLORS.info)
    .setDescription(`### ${title}\n${description ? `${description}` : ""}`);
}

function musicEmbed(title, description) {
  return makeEmbed(COLORS.music)
    .setDescription(`### ${title}\n${description ? `${description}` : ""}`);
}

function loopLabel(mode) {
  if (mode === "track") return "🔂 วนเพลงเดิม";
  if (mode === "queue") return "🔁 วนทั้งคิว";
  return "➡️ ปิด";
}

// ────────────────────────────────────────────────────────────────────────────

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
      p: "play",
      q: "queue",
      now: "np",
      next: "skip",
      s: "skip",
      st: "stop",
      vol: "volume",
      upd: "botupdate",
      h: "help",
      help: "help",
    })[cmdRaw] || cmdRaw;

    // Log every prefix command
    logPretty("PREFIX", `${BOT_PREFIX}${cmd}`, {
      user:  msg.author.tag,
      guild: msg.guild.name,
    });

    const allowed = new Set(["help","play","playlist","skip","stop","pause","resume","queue","np","remove","shuffle","loop","volume","ping","botupdate"]);
    if (!allowed.has(cmd)) {
      return msg.reply({ embeds: [
        errorEmbed(`ไม่รู้จักคำสั่ง \`${BOT_PREFIX}${cmdRaw}\``)
          .addFields({ name: "💡 คำสั่งที่รองรับ", value: Array.from(allowed).map(c=>`\`${BOT_PREFIX}${c}\``).join(" ") })
      ]});
    }

    if (cmd === "help") {
      return msg.reply({ embeds: [buildHelpEmbedPrefix()] });
    }

    // Prepare option values similar to slash
    let q = null, limit = null, index = null, mode = null, value = null;

    if (cmd === "play") {
      q = parts.join(" ").trim();
      if (!q) return msg.reply({ embeds: [errorEmbed(`กรุณาระบุชื่อเพลงหรือลิงก์\n**ตัวอย่าง:** \`${BOT_PREFIX}play lofi hip hop\` หรือ \`${BOT_PREFIX}play https://open.spotify.com/track/...\``)] });
    } else if (cmd === "playlist") {
      const parsed = parseLimitFromArgs(parts);
      limit = parsed.limit;
      q = parsed.tokens.join(" ").trim();
      if (!q) return msg.reply({ embeds: [errorEmbed(`กรุณาระบุลิงก์ playlist หรือคำค้น\n**ตัวอย่าง:** \`${BOT_PREFIX}playlist lofi playlist --limit 20\``)] });
    } else if (cmd === "remove") {
      index = parseInt(parts[0], 10);
      if (Number.isNaN(index) || index < 1) return msg.reply({ embeds: [errorEmbed(`กรุณาระบุหมายเลขลำดับเพลงที่ต้องการลบ\n**ตัวอย่าง:** \`${BOT_PREFIX}remove 3\``)] });
    } else if (cmd === "loop") {
      mode = (parts[0] || "").toLowerCase();
      if (!mode) return msg.reply({ embeds: [errorEmbed(`กรุณาระบุโหมด: \`off\` · \`track\` · \`queue\`\n**ตัวอย่าง:** \`${BOT_PREFIX}loop track\``)] });
    } else if (cmd === "volume") {
      value = parseInt(parts[0], 10);
      if (Number.isNaN(value)) return msg.reply({ embeds: [errorEmbed(`กรุณาระบุตัวเลขความดัง (0–10000)\n**ตัวอย่าง:** \`${BOT_PREFIX}volume 80\``)] });
    }

    // Voice channel check (same as slash)
    const me = msg.guild.members.me;
    const userVC = msg.member?.voice?.channelId;
    const botVC = me?.voice?.channelId;
    const sameVC = userVC && (!botVC || botVC === userVC);
    const needsSameVC = !["help","ping", "botupdate", "np", "queue"].includes(cmd);
    if (needsSameVC && !sameVC) {
      return msg.reply({ embeds: [errorEmbed("กรุณาเข้าห้องเสียงเดียวกับบอทก่อนนะ 🎙️")] });
    }

    // Acknowledge receipt
    if (cmd === "play") await replyAck(msg, "");
    else if (cmd === "playlist") await replyAck(msg, "");
    else if (cmd === "volume") await replyAck(msg, "");
    else if (cmd === "skip") await replyAck(msg, "");
    else if (cmd === "stop") await replyAck(msg, "");
    else if (cmd === "pause") await replyAck(msg, "");
    else if (cmd === "resume") await replyAck(msg, "");
    else if (cmd === "ping") await replyAck(msg, "");
    else if (cmd === "botupdate") await replyAck(msg, "");

    // Execute using the same internal functions as slash
    const state = getGuildState(msg.guild);

    if (cmd === "ping") {
      return msg.reply({ embeds: [
        makeEmbed(COLORS.info)
          .setDescription("### 🏓  Pong!")
          .addFields(
            { name: "🌐 WebSocket", value: `\`${Math.round(msg.client.ws.ping)} ms\``, inline: true },
          )
      ]});
    }

    if (cmd === "botupdate") {
      const m = await msg.reply({ embeds: [infoEmbed("🔄  กำลังอัปเดต yt-dlp…", "โปรดรอสักครู่")] });
      await runYtDlpUpdate((t) => m.edit({ embeds: [
        t.startsWith("✅")
          ? successEmbed("✅  อัปเดตสำเร็จ", "yt-dlp อัปเดตเรียบร้อยแล้ว")
          : errorEmbed(t)
      ], content: "" }));
      return;
    }

    if (cmd === "play") {
      const title = await getTitle(q);
      state.queue.push({
        title,
        source: q,
        requestedBy: msg.author.tag,
        guild: msg.guild,
        voiceChannelId: userVC,
        textChannelId: msg.channelId,
      });
      await msg.reply({ embeds: [
        makeEmbed(COLORS.success)
          .setDescription(`### ➕  เพิ่มเพลงเข้าคิวแล้ว`)
          .addFields(
            { name: "🎵 เพลง", value: `**${title}**`, inline: false },
            { name: "📋 ลำดับในคิว", value: `\`#${state.queue.length}\``, inline: true },
            { name: "👤 ขอโดย", value: `${msg.author}`, inline: true },
          )
      ]});
      if (!state.current) playNext(msg.guild, msg.channelId, state);
      return;
    }

    if (cmd === "playlist") {
      const items = await fetchPlaylistEntries(q, limit);
      if (!items.length) return msg.reply({ embeds: [errorEmbed("ไม่พบเพลงในเพลย์ลิสต์หรือผลการค้นหา")] });
      for (const { title, url } of items) {
        state.queue.push({
          title,
          source: url,
          requestedBy: msg.author.tag,
          guild: msg.guild,
          voiceChannelId: userVC,
          textChannelId: msg.channelId,
        });
      }
      const preview = items.slice(0, 5).map((x, i) => `\`${i + 1}.\` ${x.title}`).join("\n");
      const more = items.length > 5 ? `\n*… และอีก ${items.length - 5} เพลง*` : "";
      await msg.reply({ embeds: [
        makeEmbed(COLORS.queue)
          .setDescription(`### 📚  โหลด Playlist สำเร็จ`)
          .addFields(
            { name: "🎶 เพลงทั้งหมด", value: `**${items.length} เพลง**`, inline: true },
            { name: "👤 ขอโดย", value: `${msg.author}`, inline: true },
            { name: "📋 รายการแรก", value: `${preview}${more}`, inline: false },
          )
      ]});
      if (!state.current) playNext(msg.guild, msg.channelId, state);
      return;
    }

    if (cmd === "skip") {
      state.skipRequested = true;
      state.player.stop(true);
      cleanupCurrentPipeline(state);
      return msg.reply({ embeds: [successEmbed("⏭️  ข้ามเพลงแล้ว", state.queue.length ? `ถัดไป: **${state.queue[0]?.title || "—"}**` : "คิวหมดแล้ว")] });
    }

    if (cmd === "stop") {
      state.queue = [];
      state.current = null;
      state.loopMode = "off";
      state.skipRequested = false;
      state.player.stop(true);
      cleanupCurrentPipeline(state);
      const vc = getVoiceConnection(msg.guild.id);
      if (vc) vc.destroy();
      return msg.reply({ embeds: [successEmbed("🛑  หยุดเพลงแล้ว", "ล้างคิวและออกจากห้องเสียงเรียบร้อย")] });
    }

    if (cmd === "pause") { state.player.pause(); return msg.reply({ embeds: [infoEmbed("⏸️  หยุดชั่วคราว", "พิมพ์ `n!resume` เพื่อเล่นต่อ")] }); }
    if (cmd === "resume") { state.player.unpause(); return msg.reply({ embeds: [successEmbed("▶️  เล่นต่อแล้ว", `กำลังเล่น: **${state.current?.title || "—"}**`)] }); }

    if (cmd === "np") {
      if (!state.current) return msg.reply({ embeds: [infoEmbed("🎵  ไม่มีเพลงกำลังเล่น", "ใช้ `n!play <ชื่อเพลง>` เพื่อเริ่มเล่น")] });
      return msg.reply({ embeds: [
        makeEmbed(COLORS.music)
          .setDescription(`### 🎶  Now Playing`)
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
        makeEmbed(COLORS.queue)
          .setDescription(`### 📋  คิวเพลง`)
          .addFields(
            { name: `รายการ (${Math.min(state.queue.length, 10)}/${state.queue.length})`, value: lines + more, inline: false },
            { name: "🔁 Loop", value: loopLabel(state.loopMode), inline: true },
            { name: "🎵 กำลังเล่น", value: state.current ? `**${state.current.title}**` : "—", inline: true },
          )
      ]});
    }

    if (cmd === "volume") {
      setVolumePct(state, value);
      const bar = "█".repeat(Math.round(Math.min(state.volumePct, 200) / 20)) + "░".repeat(10 - Math.round(Math.min(state.volumePct, 200) / 20));
      return msg.reply({ embeds: [
        successEmbed("🔊  ปรับระดับเสียงแล้ว", `\`${bar}\` **${state.volumePct}%**`)
      ]});
    }

    if (cmd === "shuffle") {
      shuffleArray(state.queue);
      return msg.reply({ embeds: [successEmbed("🔀  สุ่มคิวแล้ว", `สลับลำดับ **${state.queue.length} เพลง** เรียบร้อย`)] });
    }

    if (cmd === "remove") {
      if (index > state.queue.length) return msg.reply({ embeds: [errorEmbed(`หมายเลขลำดับเกินจำนวนในคิว (มีอยู่ ${state.queue.length} เพลง)`)] });
      const [rm] = state.queue.splice(index - 1, 1);
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


// Slash command definitions
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
      o.setName("mode")
        .setDescription("รูปแบบการวน")
        .setRequired(true)
        .addChoices(
          { name: "ปิด", value: "off" },
          { name: "วนเพลงปัจจุบัน", value: "track" },
          { name: "วนทั้งคิว", value: "queue" },
        )
    ),
  new SlashCommandBuilder().setName("help").setDescription("แสดงวิธีใช้และคำสั่งทั้งหมด"),
].map(c => c.toJSON());

// Guild queue and player state
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
    volumePct: config.defaultVolume,
    loopMode: config.defaultLoop,
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

// Utility functions
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
    // Destroy the audio stream if present
    try { state.currentPipe.stream?.destroy?.(); } catch {}
    // Kill the ffmpeg process
    try { state.currentPipe.ff?.kill?.("SIGKILL"); } catch {}
    // If there is a helper process (e.g. yt-dlp for TikTok), kill it too
    try { state.currentPipe.helper?.kill?.("SIGKILL"); } catch {}
  } catch (e) {
    swallowPipeError(e);
  } finally {
    state.currentPipe = null;
  }
}
function isUrl(s){ try { new URL(s); return true; } catch { return false; } }

// yt-dlp helper functions
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
  if (!FFMPEG_AVAILABLE) throw new Error("ffmpeg binary not available");

  // Build argument list dynamically based off the audio/network config
  const a = [];

  // Base logging and banner settings
  a.push("-loglevel", "info", "-hide_banner");

  // Reconnect logic with configurable max delay
  a.push(
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", String(config.ffmpegReconnectDelayMax)
  );

  // Tune buffering and probing depending on latency preference
  if (config.ffmpegLowLatency) {
    a.push(
      "-fflags", "+nobuffer",
      "-flags", "low_delay",
      "-analyzeduration", String(config.ffmpegInputAnalyzeMs * 1000), // microseconds
      "-probesize", "32k",
      "-rw_timeout", "15000000",
      "-timeout", "15000000"
    );
  } else {
    const us = Math.max(0, config.ffmpegInputAnalyzeMs) * 1000;
    a.push("-analyzeduration", String(us), "-probesize", "256k");
  }

  // Pass through HTTP headers and input URL
  a.push("-headers", headersStr + "\r\n", "-i", url);

  // Drop any video streams
  a.push("-vn");

  // Apply channel count and sample rate
  a.push("-ac", String(config.audioChannels));
  a.push("-ar", String(config.audioSampleRate));

  // Optional audio filter chain
  const afChain = (config.audioFilter || "").trim();
  if (afChain) {
    a.push("-af", afChain);
  }

  // Encode to Opus with bitrate and VBR settings
  a.push("-c:a", "libopus");
  a.push("-b:a", config.opusBitrate);

  // Configure variable bitrate mode
  if (config.opusVbr === "off") {
    a.push("-vbr", "off");
  } else if (config.opusVbr === "constrained") {
    a.push("-vbr", "constrained");
  } else {
    a.push("-vbr", "on");
  }

  // Set Opus application profile if valid
  if (["audio", "voip", "lowdelay"].includes(config.opusApplication)) {
    a.push("-application", config.opusApplication);
  }

  // Frame duration (accepted values: 2.5,5,10,20,40,60 ms)
  const fd = Number(config.opusFrameDuration);
  if ([2.5, 5, 10, 20, 40, 60].includes(fd)) {
    a.push("-frame_duration", String(fd));
  }

  // Complexity (0–10)
  const cx = Number(config.opusComplexity);
  if (Number.isFinite(cx) && cx >= 0 && cx <= 10) {
    a.push("-compression_level", String(cx));
  }

  // Append any custom extra arguments
  if (config.ffmpegExtraArgs && config.ffmpegExtraArgs.trim()) {
    // Split on whitespace to allow multiple flags
    a.push(...config.ffmpegExtraArgs.trim().split(/\s+/));
  }

  // Output container and pipe to stdout
  a.push("-f", "ogg", "pipe:1");

  const ff = spawn(FFMPEG || "ffmpeg", a, { stdio: ["ignore", "pipe", "pipe"] });
  ff.on("error", (e) => logPretty("ERROR", "ffmpeg spawn error: " + (e?.message || e)));
  ff.stdout.on("error", swallowPipeError);
  ff.stderr.on("error", swallowPipeError);
  ff.stderr.on("data", d => {
    try {
      logPretty("LOG", "[ffmpeg] " + d.toString().trim());
    } catch {}
  });
  return ff;
}

// Spawn a TikTok pipeline using yt-dlp piping directly into ffmpeg. This avoids
// fetching the TikTok media URL via ffmpeg (which often results in 403
// Forbidden responses). Instead, yt-dlp is responsible for downloading the
// media, and ffmpeg consumes the stream from stdin. The returned object
// includes the ffmpeg process, its stdout stream, and the yt-dlp helper
// process for cleanup.
function spawnTikTokPipe(pageUrl) {
  if (!FFMPEG_AVAILABLE) {
    throw new Error("ffmpeg binary not available");
  }
  // Build yt-dlp CLI arguments. We respect configuration options such as
  // force IPv4 and cookie file. The output is written to stdout ("-") so
  // ffmpeg can read it from a pipe.
  const ytdlpArgs = [];
  // use force-ipv4 if configured
  if (config.ytdlpForceIpv4) {
    ytdlpArgs.push("--force-ipv4");
  }
  // use cookie file if provided
  if (config.cookieFile) {
    ytdlpArgs.push("--cookies", config.cookieFile);
  }
  // Basic resilient settings
  ytdlpArgs.push(
    "--no-check-certificates",
    "--retries", "infinite",
    "--fragment-retries", "infinite",
    "-f", "ba",
    "-o", "-",
    "--js-runtimes", "node",
    pageUrl
  );
  // Spawn yt-dlp process
  const helper = spawn("yt-dlp", ytdlpArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  helper.on("error", (e) => logPretty("ERROR", "yt-dlp spawn error: " + (e?.message || e)));
  helper.stderr.on("error", swallowPipeError);
  helper.stderr.on("data", (d) => {
    try {
      logPretty("LOG", "[yt-dlp] " + d.toString().trim());
    } catch {}
  });
  // Build ffmpeg arguments based on our audio configuration. Unlike
  // spawnFfmpegFromDirectUrl, we do not include reconnect flags because
  // yt-dlp is handling network access. We still honor low‑latency and
  // audio quality settings.
  const a = [];
  a.push("-loglevel", "info", "-hide_banner");
  if (config.ffmpegLowLatency) {
    a.push(
      "-fflags", "+nobuffer",
      "-flags", "low_delay",
      "-analyzeduration", String(config.ffmpegInputAnalyzeMs * 1000),
      "-probesize", "32k"
    );
  } else {
    const us = Math.max(0, config.ffmpegInputAnalyzeMs) * 1000;
    a.push("-analyzeduration", String(us), "-probesize", "256k");
  }
  // Input from stdin (pipe)
  a.push("-i", "pipe:0");
  // Drop any video
  a.push("-vn");
  // Channels and sample rate
  a.push("-ac", String(config.audioChannels));
  a.push("-ar", String(config.audioSampleRate));
  // Optional audio filter
  const afChain = (config.audioFilter || "").trim();
  if (afChain) {
    a.push("-af", afChain);
  }
  // Opus encoding settings
  a.push("-c:a", "libopus");
  a.push("-b:a", config.opusBitrate);
  if (config.opusVbr === "off") {
    a.push("-vbr", "off");
  } else if (config.opusVbr === "constrained") {
    a.push("-vbr", "constrained");
  } else {
    a.push("-vbr", "on");
  }
  if (["audio", "voip", "lowdelay"].includes(config.opusApplication)) {
    a.push("-application", config.opusApplication);
  }
  const fd = Number(config.opusFrameDuration);
  if ([2.5, 5, 10, 20, 40, 60].includes(fd)) {
    a.push("-frame_duration", String(fd));
  }
  const cx = Number(config.opusComplexity);
  if (Number.isFinite(cx) && cx >= 0 && cx <= 10) {
    a.push("-compression_level", String(cx));
  }
  if (config.ffmpegExtraArgs && config.ffmpegExtraArgs.trim()) {
    a.push(...config.ffmpegExtraArgs.trim().split(/\s+/));
  }
  a.push("-f", "ogg", "pipe:1");
  // Spawn ffmpeg process
  const ff = spawn(FFMPEG || "ffmpeg", a, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  ff.on("error", (e) => logPretty("ERROR", "ffmpeg(tiktok) spawn error: " + (e?.message || e)));
  ff.stdout.on("error", swallowPipeError);
  ff.stderr.on("error", swallowPipeError);
  ff.stderr.on("data", (d) => {
    try {
      logPretty("LOG", "[ffmpeg(tiktok)] " + d.toString().trim());
    } catch {}
  });
  // Pipe yt-dlp stdout into ffmpeg stdin
  helper.stdout.pipe(ff.stdin);
  return { ff, stream: ff.stdout, helper };
}

// Playlist helper: fetch entries list
// คืนอาเรย์ [{ title, url }] จากลิงก์ playlist/mix หรือจากคำค้น (ytsearchN:)
async function fetchPlaylistEntries(input, limit = null) {
  // If limit is omitted:
  // - URL playlist: fetch ALL items (still protected by playlistHardCap)
  // - search text: default to 25 results
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
      const info = await ytdlp(input, ytdlpOpts({
        dumpSingleJson: true,
        "yes-playlist": true,
        "flat-playlist": true,
      }));
      const arr = info?.entries || [];
      for (const e of arr) {
        if (Number.isFinite(max) && entries.length >= max) break;
        // Safety: even if max is Infinity, keep a hard cap to prevent runaway memory usage
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

// Player helper functions
async function handlePlayerIdle(guild, state) {
  cleanupCurrentPipeline(state);
  state.currentResource = null;
  if (!state.current) return;

  const finished = state.current;
  const manualSkip = state.skipRequested;
  state.skipRequested = false;

  logPretty("NOWPLAY", `FINISHED  ${finished.title}`);

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
    logPretty("WARN", `STREAM DROP — retrying once`, { tail: state.current.title });
    await sendToTextChannel(guild, state.current.textChannelId, { embeds: [
      makeEmbed(COLORS.warning)
        .setDescription("### 🔁  สัญญาณหลุด\nกำลังลองเชื่อมต่อใหม่…")
    ]});
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
    logPretty("INFO", "QUEUE EMPTY — disconnecting");
    await sendToTextChannel(guild, textChannelId, { embeds: [
      makeEmbed(COLORS.info)
        .setDescription("### 📭  คิวหมดแล้ว\nเพิ่มเพลงใหม่ด้วย `/play` หรือ `n!play` ได้เลย!")
    ]});
    return;
  }

  const next = state.queue.shift();
  state.current = next;

  try {
    // Use unified playback helper; this will throw on resolution errors
    const { pageUrl } = await startPlayback(guild, next, state);
    // Compose information about upcoming tracks
    const upNext = state.queue.slice(0, 3).map(x => x.title).join(" | ") || "—";
    logPretty("NOWPLAY", `${next.title}`, {
      user:  next.requestedBy,
      tail: `up_next: ${state.queue[0]?.title || "—"}`,
    });
    const ws = wsPing();
    await sendToTextChannel(guild, next.textChannelId, { embeds: [
      makeEmbed(COLORS.music)
        .setDescription(`### 🎶  Now Playing`)
        .addFields(
          { name: "🎵 เพลง", value: `**${next.title}**`, inline: false },
          { name: "👤 ขอโดย", value: next.requestedBy, inline: true },
          { name: "🔊 Volume", value: `${state.volumePct}%`, inline: true },
          { name: "🌐 Ping", value: `${ws} ms`, inline: true },
          { name: "📋 ถัดไป", value: state.queue.length ? `\`${state.queue[0]?.title || "—"}\`` : "—", inline: false },
        )
    ]});
  } catch (e) {
    logPretty("ERROR", "play error: " + (e?.message || e));
    await sendToTextChannel(guild, next.textChannelId, { embeds: [
      makeEmbed(COLORS.warning)
        .setDescription(`### ⚠️  ข้ามเพลงนี้แล้ว\nเกิดปัญหากับ **${next?.title ?? "ไม่ทราบชื่อ"}**`)
    ]});
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

// Prepare and start playback: resolve the audio URL, spawn ffmpeg, probe the stream and play.
async function startPlayback(guild, item, state) {
  // Ensure the bot is connected to the correct voice channel and subscribed to the player
  ensureVC(guild, item.voiceChannelId, state);

  // Resolve the initial video/track URL; this may involve a search
  const pageUrl = await resolveFirstVideoUrl(item.source);
  if (!pageUrl) {
    throw new Error("cannot resolve page url");
  }

  let pipeObj;
  // If the URL is a TikTok link, use the yt-dlp -> ffmpeg pipe to avoid
  // 403 errors. Otherwise, resolve a direct media URL and spawn ffmpeg as
  // usual.
  if (pageUrl.includes("tiktok.com") || pageUrl.includes("vt.tiktok.com")) {
    pipeObj = spawnTikTokPipe(pageUrl);
  } else {
    // Retrieve a direct audio URL and associated HTTP headers for yt-dlp
    const { url, headers } = await getDirectAudioUrlAndHeaders(pageUrl);
    const ff = spawnFfmpegFromDirectUrl(url, buildFfmpegHeadersString(headers));
    pipeObj = { ff, stream: ff.stdout };
  }
  // Maintain a reference for clean up on idle/skip (also stores helper if present)
  state.currentPipe = pipeObj;
  // Probe the stream to determine the correct demuxing configuration
  const { stream, type } = await demuxProbe(pipeObj.stream);
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
  if (pct > 10000) pct = 10000;
  state.volumePct = pct;
  applyVolume(state);
}

client.on("error", (e) => logPretty("ERROR", `Client error: ${e?.message || e}`));
process.on("unhandledRejection", (e) => logPretty("ERROR", `unhandledRejection: ${e}`));

// Ready event and command handling
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
  // Schedule automatic yt-dlp updates only if enabled in the configuration
  if (config.ytdlpAutoUpdate) {
    scheduleDailyBangkokMidnight(() => runYtDlpUpdate());
    const ONE_DAY = 24 * 3600 * 1000;
    if (Date.now() - readLastUpdateTs() > ONE_DAY) runYtDlpUpdate();
  }
});

client.on("interactionCreate", async (itx) => {
  if (!itx.isChatInputCommand()) return;
  // Calculate round-trip time. Clamp at zero to avoid negative values when clocks differ.
  const rttRaw = Date.now() - itx.createdTimestamp;
  const rtt = rttRaw < 0 ? 0 : rttRaw;
  logPretty("COMMAND", `/${itx.commandName}`, {
    user:  itx.user.tag,
    guild: itx.guild.name,
    rtt,
  });

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
      makeEmbed(COLORS.info)
        .setDescription("### 🏓  Pong!")
        .addFields(
          { name: "🌐 WebSocket", value: `\`${Math.round(itx.client.ws.ping)} ms\``, inline: true },
          { name: "⏱️ RTT", value: `\`${rtt} ms\``, inline: true },
        )
    ]});
    return;
  }

  if (itx.commandName === "botupdate") {
    await itx.deferReply({ ephemeral: true });
    await runYtDlpUpdate((msg) => itx.editReply({ embeds: [
      msg.startsWith("✅")
        ? successEmbed("✅  อัปเดตสำเร็จ", "yt-dlp อัปเดตเรียบร้อยแล้ว")
        : msg.startsWith("⏳")
        ? infoEmbed("⏳  กำลังอัปเดต", "กระบวนการอัปเดต yt-dlp กำลังทำงาน")
        : errorEmbed(msg)
    ], content: "" }));
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
    await itx.editReply({ embeds: [
      makeEmbed(COLORS.success)
        .setDescription(`### ➕  เพิ่มเพลงเข้าคิวแล้ว`)
        .addFields(
          { name: "🎵 เพลง", value: `**${title}**`, inline: false },
          { name: "📋 ลำดับในคิว", value: `\`#${state.queue.length}\``, inline: true },
          { name: "👤 ขอโดย", value: `${itx.user}`, inline: true },
        )
    ]});
    if (!state.current) playNext(itx.guild, itx.channelId, state);
    return;
  }

  if (itx.commandName === "skip") {
    state.skipRequested = true;
    state.player.stop(true);
    cleanupCurrentPipeline(state);
    await itx.reply({ embeds: [successEmbed("⏭️  ข้ามเพลงแล้ว", state.queue.length ? `ถัดไป: **${state.queue[0]?.title || "—"}**` : "คิวหมดแล้ว")] });
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
    await itx.reply({ embeds: [successEmbed("🛑  หยุดเพลงแล้ว", "ล้างคิวและออกจากห้องเสียงเรียบร้อย")] });
    return;
  }

  if (itx.commandName === "pause") {
    state.player.pause();
    await itx.reply({ embeds: [infoEmbed("⏸️  หยุดชั่วคราว", "พิมพ์ `/resume` เพื่อเล่นต่อ")] });
    return;
  }

  if (itx.commandName === "resume") {
    state.player.unpause();
    await itx.reply({ embeds: [successEmbed("▶️  เล่นต่อแล้ว", `กำลังเล่น: **${state.current?.title || "—"}**`)] });
    return;
  }

  if (itx.commandName === "np") {
    if (!state.current) return itx.reply({ embeds: [infoEmbed("🎵  ไม่มีเพลงกำลังเล่น", "ใช้ `/play query:<ชื่อเพลง>` เพื่อเริ่มเล่น")] });
    const embed = makeEmbed(COLORS.music)
      .setDescription(`### 🎶  Now Playing`)
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
      makeEmbed(COLORS.queue)
        .setDescription(`### 📋  คิวเพลง`)
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
    const more = items.length > 5 ? `\n*… และอีก ${items.length - 5} เพลง*` : "";
    await itx.editReply({ embeds: [
      makeEmbed(COLORS.queue)
        .setDescription(`### 📚  โหลด Playlist สำเร็จ`)
        .addFields(
          { name: "🎶 เพลงทั้งหมด", value: `**${items.length} เพลง**`, inline: true },
          { name: "👤 ขอโดย", value: `${itx.user}`, inline: true },
          { name: "📋 รายการแรก", value: `${preview}${more}`, inline: false },
        )
    ]});

    if (!state.current) playNext(itx.guild, itx.channelId, state);
    return;
  }

  if (itx.commandName === "remove") {
    if (!state.queue.length) return itx.reply({ embeds: [infoEmbed("📭  คิวว่างเปล่า", "ไม่มีเพลงในคิวให้ลบ")] });
    const index = itx.options.getInteger("index");
    if (index < 1 || index > state.queue.length) {
      return itx.reply({ embeds: [errorEmbed(`หมายเลขลำดับไม่ถูกต้อง (มีอยู่ ${state.queue.length} เพลง)`)], ephemeral: true });
    }
    const [removed] = state.queue.splice(index - 1, 1);
    return itx.reply({ embeds: [successEmbed("🗑️  ลบเพลงออกจากคิวแล้ว", `**${removed.title}**`)] });
  }

  if (itx.commandName === "shuffle") {
    if (state.queue.length < 2) return itx.reply({ embeds: [infoEmbed("🔀  ไม่สามารถสุ่มได้", "ต้องมีเพลงในคิวอย่างน้อย 2 เพลง")] });
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
    return itx.reply({ embeds: [successEmbed("🔀  สุ่มคิวแล้ว", `สลับลำดับ **${state.queue.length} เพลง** เรียบร้อย`)] });
  }

  if (itx.commandName === "loop") {
    const mode = itx.options.getString("mode");
    state.loopMode = mode;
    return itx.reply({ embeds: [successEmbed("🔁  ตั้งค่า Loop แล้ว", `โหมดปัจจุบัน: **${loopLabel(mode)}**`)] });
  }
});

client.login(config.token);
