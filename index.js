// index.js
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

// -----------------------------
// Discord & Voice
// -----------------------------
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
} = require("@discordjs/voice");

// -----------------------------
// Keep-alive (Railway/Render friendly)
// -----------------------------
const PORT = process.env.PORT || 3000;
http
  .createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Discord music bot is running");
  })
  .listen(PORT, () => console.log("HTTP server on " + PORT));

// -----------------------------
// ffmpeg path (ffmpeg-static)
// -----------------------------
let FFMPEG = null;
try { FFMPEG = require("ffmpeg-static"); } catch { /* system ffmpeg fallback */ }

// -----------------------------
// yt-dlp (via yt-dlp-exec)
// -----------------------------
const ytdlp = require("yt-dlp-exec");

// -----------------------------
// Logging (console + file)
// -----------------------------
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "bot.log");
function nowStr() { return new Date().toISOString().replace("T", " ").split(".")[0]; }
function log(msg) {
  const line = `[${nowStr()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// -----------------------------
// yt-dlp: Auto Update + Scheduler (Asia/Bangkok)
// -----------------------------
const UPDATE_MARK_FILE = path.join(process.cwd(), "data", "yt-dlp.last");
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7
let isUpdatingYtDlp = false;

function readLastUpdateTs() {
  try { return Number(fs.readFileSync(UPDATE_MARK_FILE, "utf8")); } catch { return 0; }
}
function writeLastUpdateTs(ts = Date.now()) {
  try {
    const dir = path.dirname(UPDATE_MARK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(UPDATE_MARK_FILE, String(ts), "utf8");
  } catch {}
}
async function runYtDlpUpdate(interactionReplyFn) {
  if (isUpdatingYtDlp) { interactionReplyFn?.("⏳ กำลังอัปเดตอยู่แล้ว"); return; }
  isUpdatingYtDlp = true;
  const started = Date.now();
  try {
    try { await ytdlp("--version"); } catch {}
    const out = await ytdlp("-U", { shell: true }).catch(err => ({ error: err }));
    if (out?.error) {
      log(`yt-dlp update failed: ${out.error.message || out.error}`);
      interactionReplyFn?.("❌ อัปเดตไม่สำเร็จ (ดู log)");
    } else {
      const msg = (out?.stdout || out)?.toString?.().trim?.() || "(no stdout)";
      log(`yt-dlp update done: ${msg}`);
      writeLastUpdateTs(started);
      interactionReplyFn?.("✅ อัปเดตเสร็จแล้ว");
    }
  } catch (e) {
    log(`yt-dlp update error: ${e?.message || e}`);
    interactionReplyFn?.("❌ อัปเดตไม่สำเร็จ (เกิดข้อผิดพลาด)");
  } finally {
    isUpdatingYtDlp = false;
  }
}
function msUntilNextBangkokMidnight() {
  const now = new Date();
  const bkkNow = new Date(now.getTime() + BKK_OFFSET_MS);
  const nextMidnightBkkUTCms = Date.UTC(
    bkkNow.getUTCFullYear(),
    bkkNow.getUTCMonth(),
    bkkNow.getUTCDate() + 1,
    0, 0, 0, 0
  ) - BKK_OFFSET_MS;
  return Math.max(1, nextMidnightBkkUTCms - now.getTime());
}
function scheduleDailyBangkokMidnight(fn) {
  const delay = msUntilNextBangkokMidnight();
  setTimeout(async () => {
    try { await fn(); } finally { scheduleDailyBangkokMidnight(fn); }
  }, delay);
}

// -----------------------------
// Discord client + Slash commands
// -----------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("เล่นเพลงจาก YouTube (ชื่อเพลงหรือ URL)")
    .addStringOption(o =>
      o.setName("query").setDescription("ชื่อเพลง/URL").setRequired(true)
    ),
  new SlashCommandBuilder().setName("skip").setDescription("ข้ามเพลงปัจจุบัน"),
  new SlashCommandBuilder().setName("stop").setDescription("หยุดเพลงและล้างคิว"),
  new SlashCommandBuilder().setName("pause").setDescription("หยุดชั่วคราว"),
  new SlashCommandBuilder().setName("resume").setDescription("เล่นต่อ"),
  new SlashCommandBuilder().setName("ping").setDescription("เช็คค่า ping"),
  new SlashCommandBuilder().setName("botupdate").setDescription("อัปเดต yt-dlp ตอนนี้"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

// -----------------------------
// Queue / Player
// -----------------------------
let queue = [];
let current = null;
const player = createAudioPlayer();

player.on(AudioPlayerStatus.Idle, () => {
  if (!current) return;
  log(`⏭️ finished: ${current.title}`);
  playNext(current.guild, current.textChannelId);
});
player.on("error", (e) => log(`Player error: ${e?.message || e}`));

client.on("error", (e) => log(`Client error: ${e?.message || e}`));
process.on("unhandledRejection", (e) => log(`unhandledRejection: ${e}`));

// -----------------------------
// Helpers
// -----------------------------
function isUrl(s) { try { new URL(s); return true; } catch { return false; } }

async function resolveToWatchUrl(query) {
  if (isUrl(query)) return query;
  try {
    const out = await ytdlp(`ytsearch1:${query}`, { getUrl: true, shell: true });
    const url = (out.stdout || "").trim().split("\n").pop();
    return url || null;
  } catch (e) {
    log("resolve fail: " + (e?.message || e));
    return null;
  }
}

async function getTitle(input) {
  try {
    const info = await ytdlp(input, { dumpSingleJson: true, noCheckCertificates: true, shell: true });
    if (info && info.title) return info.title;
  } catch {}
  return input;
}

function spawnFfmpegInput(inputUrl) {
  const args = [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-i", inputUrl,
    "-vn",
    "-acodec", "pcm_s16le",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1",
  ];
  const ff = spawn(FFMPEG || "ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
  ff.on("error", (e) => log("ffmpeg spawn error: " + e?.message));
  return ff.stdout;
}

function ensureVC(guild, channelId) {
  let conn = getVoiceConnection(guild.id);
  if (!conn) {
    conn = joinVoiceChannel({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    conn.subscribe(player);
  }
  return conn;
}

async function playNext(guild, textChannelId) {
  if (!queue.length) {
    current = null;
    const vc = getVoiceConnection(guild.id);
    if (vc) vc.destroy();
    return;
  }
  current = queue.shift();

  try {
    ensureVC(guild, current.voiceChannelId);
    const inputUrl = await resolveToWatchUrl(current.source);
    if (!inputUrl) {
      log("cannot resolve stream, skip: " + current.source);
      return playNext(guild, textChannelId);
    }
    const pcm = spawnFfmpegInput(inputUrl);
    const resource = createAudioResource(pcm);
    player.play(resource);
    log(`🎶 now: ${current.title} | via yt-dlp`);
  } catch (e) {
    log("play error: " + (e?.message || e));
    playNext(guild, textChannelId);
  }
}

// -----------------------------
// Ready
// -----------------------------
client.once(Events.ClientReady, async () => {
  console.log(`✅ bot online ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered");
  } catch (e) {
    log("register error: " + (e?.message || e));
  }

  // เริ่มตั้งเวลาอัปเดตทุกเที่ยงคืน (เวลาไทย)
  scheduleDailyBangkokMidnight(() => runYtDlpUpdate());
  // ถ้าห่างการอัปเดตครั้งสุดท้าย > 24 ชม. ให้ลองอัปเดตตอนบูต
  const ONE_DAY = 24 * 3600 * 1000;
  if (Date.now() - readLastUpdateTs() > ONE_DAY) runYtDlpUpdate();
});

// -----------------------------
// Commands
// -----------------------------
client.on("interactionCreate", async (itx) => {
  if (!itx.isChatInputCommand()) return;

  const me = itx.guild.members.me;
  const userVC = itx.member?.voice?.channelId;
  const botVC = me?.voice?.channelId;
  const sameVC = userVC && (!botVC || botVC === userVC);

  if (itx.commandName !== "ping" && itx.commandName !== "botupdate" && !sameVC) {
    return itx.reply({ content: "❌ กรุณาเข้าห้องเสียงเดียวกับบอทก่อน", ephemeral: true });
  }

  if (itx.commandName === "ping") {
    return itx.reply(`WebSocket: \`${Math.round(itx.client.ws.ping)} ms\``);
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
    return itx.reply("⏭️ ข้ามแล้ว");
  }

  if (itx.commandName === "stop") {
    queue = [];
    current = null;
    player.stop(true);
    const vc = getVoiceConnection(itx.guild.id);
    if (vc) vc.destroy();
    return itx.reply("🛑 หยุดและล้างคิวแล้ว");
  }

  if (itx.commandName === "pause") {
    player.pause();
    return itx.reply("⏸️ หยุดชั่วคราว");
  }

  if (itx.commandName === "resume") {
    player.unpause();
    return itx.reply("▶️ เล่นต่อ");
  }
});

client.login(process.env.TOKEN);
