// index.js
require("dotenv").config();

/*
 * -----------------------------------------------------------------------------
 * Timer sanity wrappers
 *
 * Node.js will emit a `TimeoutNegativeWarning` if `setTimeout()` or
 * `setInterval()` are called with a negative delay (or a non‑finite value).
 * Unfortunately, some third party libraries occasionally compute small
 * negative timeouts due to clock skew or rounding issues (for example
 * subtracting two timestamps where one is derived from a remote source). When
 * this happens, Node will coerce the duration to 1ms and log a warning like
 * "TimeoutNegativeWarning: -47 is a negative number. Timeout duration was set
 * to 1.". While the behaviour is harmless, it clutters the console and
 * confuses operators. To avoid these warnings, we wrap the global timer
 * functions and clamp any invalid delays to a minimum of 1ms before passing
 * them through to the original implementations. This fix is applied early in
 * the module before any other dependencies have a chance to schedule timers,
 * ensuring that all timeouts created by this process are sanitised.
 */

(() => {
  /**
   * Normalize a timer delay into a safe, non‑negative integer. If the input
   * cannot be converted to a finite number or if it is negative, it will be
   * replaced with `1`. Using a 1ms fallback mirrors Node's internal behaviour
   * when a negative timeout is supplied, but avoids the emitted warning.
   *
   * @param {*} delay The original delay value provided to setTimeout/setInterval
   * @returns {number} A safe, clamped delay
   */
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

/*
 * Configuration
 *
 * This section centralises all configurable settings for the bot into a single
 * object. Each property reads from the corresponding environment variable,
 * providing a sensible default when the variable is not defined. When the bot
 * starts, it will print a summary of the loaded configuration and the values
 * being used. This allows you to customise behaviour via the `.env` file
 * without editing this script. For example, to change the port that the bot
 * listens on or to override the default volume, add lines like these to
 * `.env`:
 *
 *   PORT=3001
 *   FFMPEG_PATH=/usr/local/bin/ffmpeg
 *   YTDLP_COOKIES_PATH=/path/to/cookies.txt
 *   DEBUG_FFMPEG=true
 *   DEFAULT_VOLUME=80
 *   DEFAULT_LOOP_MODE=track
 *   TIMEZONE_OFFSET_HOURS=7
 *   YTDLP_FORCE_IPV4=true
 *   YTDLP_AUTO_UPDATE=true
 *
 * A missing variable will simply fall back to the default defined below.
 */
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

/* ------------------------- Keep-alive (Railway/Render) ------------------------ */
// Use the configured port rather than reading directly from process.env
http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Discord music bot is running");
}).listen(config.port);
/* ---------------------------------- ffmpeg ----------------------------------- */
let FFMPEG = null;
let FFMPEG_AVAILABLE = false;
// Determine the ffmpeg binary. If the user specifies a custom path via
// configuration, prefer that. Otherwise fall back to ffmpeg-static and
// finally to the system ffmpeg.
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

/* ------------------------------ yt-dlp + cookies ----------------------------- */
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
  };
  if (config.cookieFile) base.cookies = config.cookieFile;
  return { ...base, ...extra };
}

/* ---------------------------------- logging ---------------------------------- */
// Ensure log directory exists based on configuration
const LOG_DIR = config.logDir;
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
// Define two log files: one for general logs and one for detailed debug logs (including ffmpeg)
// The general log omits ffmpeg debug output, while the debug log always includes everything
const LOG_FILE_MAIN = path.join(LOG_DIR, "bot.log");
const LOG_FILE_DEBUG = path.join(LOG_DIR, "bot-debug.log");

/**
 * Format the current timestamp as a human‑readable string without milliseconds.
 * Example: 2025-11-04 02:13:54
 */
function nowStr() {
  return new Date().toISOString().replace("T", " ").split(".")[0];
}

// ANSI colour codes used for console output
const C = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
};

/**
 * Wrap a string with a given colour code for console output.
 *
 * @param {string} s The string to colourise
 * @param {string} code The ANSI colour code
 * @returns {string}
 */
function colorize(s, code) {
  return code + s + C.reset;
}

// Keep a reference to the Discord client so we can include WebSocket ping in logs
let _clientForPing = null;
function wsPing() {
  try {
    return Math.round(_clientForPing?.ws?.ping || 0);
  } catch {
    return 0;
  }
}

/**
 * Append a log line to the appropriate log files.
 * All log lines are appended to the debug log. Lines that are not
 * ffmpeg debug output are also appended to the main log. This ensures
 * that general information (commands, now playing, queue events) shows up
 * in both logs, while ffmpeg noise only appears in the debug log.
 *
 * @param {string} line The fully formatted log line
 * @param {boolean} isDebug Whether this line is considered debug (ffmpeg)
 */
function writeLog(line, isDebug = false) {
  try {
    // Always write to the debug log
    fs.appendFileSync(LOG_FILE_DEBUG, line + "\n", "utf8");
  } catch {}
  if (!isDebug) {
    // Write to the main log only for non‑debug lines
    try {
      fs.appendFileSync(LOG_FILE_MAIN, line + "\n", "utf8");
    } catch {}
  }
}

/**
 * Pretty‑print a log message, colourising the output for the console and
 * routing the formatted line to the appropriate log files. The `type`
 * parameter controls the colour and whether the line should be treated as
 * a debug entry (ffmpeg noise). Debug lines are only printed to the
 * console when the DEBUG_FFMPEG flag is true, but they are always
 * written to the debug log file.
 *
 * @param {"COMMAND"|"NOWPLAY"|"PING"|"ERROR"|"LOG"} type The category of log message
 * @param {string} msg The message body
 * @param {Object} extra Optional additional information such as RTT or tail text
 */
function logPretty(type, msg, extra = {}) {
  let col = C.white;
  if (type === "COMMAND") col = C.cyan;
  if (type === "NOWPLAY") col = C.green;
  if (type === "PING") col = C.yellow;
  if (type === "ERROR") col = C.red;
  // Build the base log line
  const ws = wsPing();
  const line = `[${nowStr()}] ${msg}` + ` | ping=${ws}ms` +
    (extra.rtt ? ` rtt=${extra.rtt}ms` : "") + (extra.tail ? ` | ${extra.tail}` : "");
  // Determine if this is an ffmpeg debug line based on the type
  const isDebug = (type === "LOG");
  // Write to log files appropriately
  writeLog(line, isDebug);
  // Print to console: always for non‑debug entries; for debug entries only
  // when configured
  if (!isDebug || DEBUG_FFMPEG) {
    console.log(colorize(line, col));
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

/* ----------------------- yt-dlp auto-update (BKK midnight) ------------------- */
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
  setTimeout(async () => {
    try {
      await fn();
    } finally {
      scheduleDailyBangkokMidnight(fn);
    }
  }, delay);
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
    // Always run ffmpeg at info level so that stderr emits logs. We rely on
    // our logging pipeline to route these messages to the debug file and
    // respect the DEBUG_FFMPEG flag for console output.
    "-loglevel", "info",
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
  // Always capture ffmpeg stderr. We route it through logPretty with type "LOG"
  // so that it is written to the debug log file. The console output will
  // respect the DEBUG_FFMPEG flag inside logPretty, printing only when enabled.
  ff.stderr.on("data", d => {
    try {
      const msg = "[ffmpeg] " + d.toString().trim();
      logPretty("LOG", msg);
    } catch {}
  });
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
const restClient = new REST({ version: "10" }).setToken(config.token);
client.once(Events.ClientReady, async () => {
  console.log(`✅ bot online ${client.user.tag}`);
  try {
    await restClient.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered");
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

client.login(config.token);
