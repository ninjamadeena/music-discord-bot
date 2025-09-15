// index.js
require("dotenv").config();

// -----------------------------------------------------------------------------
// Polyfill for `File` and `Blob` on older Node.js versions
//
// Some dependencies (notably `undici`, used internally by modules like
// `@distube/ytdl-core`) expect the global `File` and `Blob` constructors to
// exist. These classes were added to the Node.js runtime starting with
// Node 20. On platforms like Railway, which may default to an older LTS
// version of Node.js, these constructors are undefined and cause a
// `ReferenceError: File is not defined` at runtime. To gracefully support
// older runtimes we conditionally import them from the `undici` package and
// assign them to the global scope. The try/catch guard protects against
// failures if the package interface changes.
try {
  const { File, Blob } = require('undici');
  if (typeof global.File === 'undefined' && typeof File !== 'undefined') {
    global.File = File;
  }
  if (typeof global.Blob === 'undefined' && typeof Blob !== 'undefined') {
    global.Blob = Blob;
  }
} catch (e) {
  // If undici is unavailable or the exports have changed, ignore.
}

// -----------------------------------------------------------------------------
// Set FFMPEG_PATH for ffmpeg-static
//
// The play-dl and ytdl fallback require a working ffmpeg binary. On cloud
// platforms like Railway, ffmpeg is not installed system-wide. The
// `ffmpeg-static` package downloads a compatible ffmpeg binary during install.
// Here we set the `FFMPEG_PATH` environment variable so dependent libraries
// can locate it. If the import fails, the variable remains undefined, and
// external ffmpeg must be installed separately.
try {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath;
  }
} catch (e) {
  // ignore if ffmpeg-static is not installed
}
const fs = require("fs");
const path = require("path");

// -----------------------------------------------------------------------------
// Keep‑alive HTTP server for Railway deployment
//
// Railway (and some other cloud hosts) expect your application to bind to the
// port provided via the `PORT` environment variable. Without an open listener
// the process may shut down prematurely, causing the Discord bot to appear
// offline. Termux does not enforce this requirement, but Railway does. To
// support both environments we spin up a very small HTTP server that simply
// responds with a short message on any request. This does not interfere with
// the bot’s functionality but ensures that the container stays alive on
// platforms like Railway. We avoid pulling in extra dependencies such as
// Express by using Node’s built‑in `http` module.
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Discord music bot is running');
}).listen(PORT, () => {
  console.log('HTTP server listening on port ' + PORT);
});

// -----------------------------------------------------------------------------
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

const playdl = require("play-dl");
const ytdl = require("@distube/ytdl-core");

// =========================
//  LOG SYSTEM (ANSI + FILE)
// =========================
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "bot.log");

function nowStr() {
  return new Date().toISOString().replace("T", " ").split(".")[0];
}
const C = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
};
function colorize(s, code) {
  return code + s + C.reset;
}
function logPretty(type, msg, extra = {}) {
  let col = C.white;
  if (type === "COMMAND") col = C.cyan;
  if (type === "NOWPLAY") col = C.green;
  if (type === "PING") col = C.yellow;
  if (type === "ERROR") col = C.red;

  const ws = Math.round((client?.ws?.ping) || 0);
  const line =
    `[${nowStr()}] ${msg}` +
    ` | ping=${ws}ms` +
    (extra.rtt ? ` rtt=${extra.rtt}ms` : "") +
    (extra.tail ? ` | ${extra.tail}` : "");

  console.log(colorize(line, col));        // สีบน Termux
  try { fs.appendFileSync(LOG_FILE, line + "\n", "utf8"); } catch {} // เก็บลงไฟล์
}

// =========================
//  PLAY-DL COOKIE (ถ้ามี)
// =========================
if (process.env.YT_COOKIE) {
  playdl.setToken({ youtube: { cookie: process.env.YT_COOKIE } }).catch(() => {});
}

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// =========================
//  DISCORD CLIENT
// =========================
const client = new Client({

// -----------------------------------------------------------------------------
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// -----------------------------------------------------------------------------
// Error handlers to prevent the bot from crashing on unhandled promise
// rejections or client errors. Without these handlers, unknown interactions
// (e.g. when a reply is attempted after Discord times out) will emit an
// 'error' event on the client and crash the process. We catch and log them
// instead.
client.on('error', (err) => {
  logPretty('ERROR', `Client error: ${err?.message || err}`, {});
});
process.on('unhandledRejection', (err) => {
  logPretty('ERROR', `Unhandled promise rejection: ${err?.message || err}`, {});
});

// =========================
/** Slash Commands */
// =========================
const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("เล่นเพลงจาก YouTube (รับชื่อเพลงหรือ URL)")
    .addStringOption((o) =>
      o.setName("query").setDescription("ชื่อเพลง/URL").setRequired(true)
    ),
  new SlashCommandBuilder().setName("skip").setDescription("ข้ามเพลงปัจจุบัน"),
  new SlashCommandBuilder().setName("stop").setDescription("หยุดเพลงและล้างคิว"),
  new SlashCommandBuilder().setName("pause").setDescription("หยุดชั่วคราว"),
  new SlashCommandBuilder().setName("resume").setDescription("เล่นต่อ"),
  new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("เพิ่มทั้ง Playlist จาก YouTube")
    .addStringOption((o) =>
      o.setName("url").setDescription("ลิงก์เพลย์ลิสต์ YouTube").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("เช็คค่า ping ของบอท"),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

// =========================
//  QUEUE / PLAYER
// =========================
let queue = [];
let current = null;
const player = createAudioPlayer();

async function sendToTextChannel(guild, textChannelId, content) {
  try {
    const ch = guild.channels.cache.get(textChannelId);
    if (ch && ch.isTextBased?.()) return ch.send(content);
  } catch {}
  return Promise.resolve();
}

// =========================
//  RESOLVE YOUTUBE
// =========================
async function resolveToVideo(query) {
  try {
    const isUrl = /^https?:\/\//i.test(query);
    if (isUrl) {
      const kind = (playdl.yt_validate?.(query)) || playdl.validate(query);
      if (kind === "video" || kind === "yt_video") {
        const info = await playdl.video_basic_info(query);
        return { title: info.video_details.title, url: info.video_details.url };
      }
      if (ytdl.validateURL(query)) {
        const info = await ytdl.getInfo(query, {
          requestOptions: {
            headers: {
              "user-agent": USER_AGENT,
              ...(process.env.YT_COOKIE ? { cookie: process.env.YT_COOKIE } : {}),
            },
          },
        });
        return { title: info.videoDetails.title, url: info.videoDetails.video_url };
      }
      return null;
    } else {
      const results = await playdl.search(query, { limit: 1, source: { youtube: "video" } });
      if (!results.length) return null;
      return { title: results[0].title, url: results[0].url };
    }
  } catch {
    return null;
  }
}

// =========================
//  GET AUDIO STREAM
// =========================
async function getAudioStream(url) {
  try {
    const s = await playdl.stream(url);
    if (s?.stream) return { stream: s.stream, type: s.type, via: "play-dl" };
  } catch {}

  try {
    if (ytdl.validateURL(url)) {
      const s2 = ytdl(url, {
        filter: "audioonly",
        highWaterMark: 1 << 25,
        quality: "highestaudio",
        requestOptions: {
          headers: {
            "user-agent": USER_AGENT,
            ...(process.env.YT_COOKIE ? { cookie: process.env.YT_COOKIE } : {}),
          },
        },
      });
      return { stream: s2, type: undefined, via: "@distube/ytdl-core" };
    }
  } catch {}

  return null;
}

// =========================
//  VOICE CONNECTION
// =========================
async function ensureVC(guild, voiceChannelId) {
  let conn = getVoiceConnection(guild.id);
  if (!conn) {
    conn = joinVoiceChannel({
      channelId: voiceChannelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    conn.subscribe(player);
  }
  return conn;
}

// =========================
//  PLAY NEXT
// =========================
async function playNext(ctx) {
  const { guild, textChannelId } = ctx;

  if (!queue.length) {
    current = null;
    const vc = getVoiceConnection(guild.id);
    if (vc) vc.destroy();
    await sendToTextChannel(guild, textChannelId, "⏹️ คิวหมดแล้ว");
    logPretty("NOWPLAY", "⏹️ QUEUE EMPTY");
    return;
  }

  current = queue.shift();
  try {
    await ensureVC(guild, current.channelId);

    const audio = await getAudioStream(current.url);
    if (!audio?.stream) {
      await sendToTextChannel(guild, current.textChannelId, `⚠️ เล่นไม่ได้ ข้าม: **${current.title}**`);
      logPretty("ERROR", `Stream fail: ${current.title}`, { tail: `url=${current.url}` });
      return playNext({ guild, textChannelId: current.textChannelId });
    }

    const resource = createAudioResource(
      audio.stream,
      audio.type ? { inputType: audio.type } : {}
    );
    player.play(resource);

    const ws = Math.round(client.ws.ping || 0);
    await sendToTextChannel(
      guild,
      current.textChannelId,
      `🎶 กำลังเล่น: **${current.title}** — ขอโดย ${current.requestedBy} (${audio.via}) | ping ${ws} ms`
    );
    const tail = `by=${current.requestedBy} via=${audio.via} up_next=${queue.slice(0,3).map(x=>x.title).join(" | ") || "-"}`;
    logPretty("NOWPLAY", `🎶 NOW PLAYING: ${current.title}`, { tail });
  } catch (e) {
    await sendToTextChannel(
      guild,
      current.textChannelId,
      `⚠️ มีปัญหากับเพลงนี้ ข้าม: **${current?.title ?? "ไม่ทราบชื่อ"}**`
    );
    logPretty("ERROR", `Play error: ${e?.message || e}`);
    return playNext({ guild, textChannelId: current.textChannelId });
  }
}

// =========================
//  PLAYER EVENTS
// =========================
player.on(AudioPlayerStatus.Idle, () => {
  if (!current) return;
  const guild = client.guilds.cache.get(current.guildId);
  if (!guild) return;
  // จบเพลง -> ไปเพลงถัดไป
  logPretty("NOWPLAY", `⏭️ FINISHED: ${current.title}`);
  playNext({ guild, textChannelId: current.textChannelId });
});

player.on("error", (e) => {
  logPretty("ERROR", `Player error: ${e?.message}`);
});

// =========================
//  READY
// =========================
client.once(Events.ClientReady, async () => {
  console.log(`✅ bot online ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash Commands โหลดแล้ว");
  } catch (err) {
    logPretty("ERROR", `Register commands error: ${err?.message}`);
  }
});

// =========================
//  HELPERS
// =========================
function inSameVoiceChannel(interaction) {
  const me = interaction.guild.members.me;
  const userVC = interaction.member?.voice?.channelId;
  const botVC = me?.voice?.channelId;
  return userVC && (!botVC || botVC === userVC);
}

// =========================
//  COMMAND HANDLER
// =========================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const rtt = Date.now() - interaction.createdTimestamp;

  // /ping อนุญาตให้ใช้ได้แม้ไม่อยู่ช่องเดียวกัน
  if (!inSameVoiceChannel(interaction) && interaction.commandName !== "ping") {
    return interaction.reply({ content: "❌ กรุณาเข้าห้องเสียงเดียวกับบอทก่อน", ephemeral: true });
  }

  if (interaction.commandName === "ping") {
    const ws = Math.round(client.ws.ping || 0);
    await interaction.reply(`\n> WebSocket: \`${ws} ms\`\n> RTT: \`${rtt} ms\``);
    logPretty("PING", ` PING requested by ${interaction.user.tag}`, { rtt });
  }

  if (interaction.commandName === "play") {
    await interaction.deferReply();
    const q = interaction.options.getString("query");

    const video = await resolveToVideo(q);
    if (!video) {
      logPretty("ERROR", `Resolve fail for query`, { tail: `q="${q}"` });
      return interaction.editReply("❌ รองรับเฉพาะวิดีโอ YouTube หรือค้นหาไม่เจอ");
    }

    queue.push({
      title: video.title,
      url: video.url,
      requestedBy: interaction.user.tag,
      guildId: interaction.guild.id,
      channelId: interaction.member.voice.channel.id,
      textChannelId: interaction.channelId,
    });

    await interaction.editReply(`➕ เพิ่ม **${video.title}** ลงคิว`);
    logPretty("COMMAND", `🎮 /play by ${interaction.user.tag}`, {
      rtt,
      tail: `query="${q}" add="${video.title}" queue_len=${queue.length}`,
    });

    if (!current) {
      await playNext({ guild: interaction.guild, textChannelId: interaction.channelId });
    }
  }

  if (interaction.commandName === "skip") {
    player.stop(true);
    await interaction.reply("⏭️ ข้ามเพลงแล้ว");
    logPretty("COMMAND", `⏭️ /skip by ${interaction.user.tag}`, { rtt });
  }

  if (interaction.commandName === "stop") {
    queue = [];
    current = null;
    player.stop(true);
    const vc = getVoiceConnection(interaction.guild.id);
    if (vc) vc.destroy();
    await interaction.reply("🛑 หยุดและล้างคิวแล้ว");
    logPretty("COMMAND", `🛑 /stop by ${interaction.user.tag}`, { rtt, tail: "queue_cleared" });
  }

  if (interaction.commandName === "pause") {
    player.pause();
    await interaction.reply("⏸️ หยุดชั่วคราว");
    logPretty("COMMAND", `⏸️ /pause by ${interaction.user.tag}`, { rtt });
  }

  if (interaction.commandName === "resume") {
    player.unpause();
    await interaction.reply("▶️ เล่นต่อ");
    logPretty("COMMAND", `▶️ /resume by ${interaction.user.tag}`, { rtt });
  }

  if (interaction.commandName === "playlist") {
    await interaction.deferReply();
    const url = interaction.options.getString("url");
    try {
      const kind = (playdl.yt_validate?.(url)) || playdl.validate(url);
      if (!(kind === "playlist" || kind === "yt_playlist")) {
        await interaction.editReply("❌ ต้องเป็นลิงก์เพลย์ลิสต์ YouTube เท่านั้น");
        logPretty("ERROR", "Playlist invalid", { tail: `url=${url}` });
        return;
      }
      const pl = await playdl.playlist_info(url, { incomplete: true });
      const vids = await pl.all_videos();
      vids.forEach((v) =>
        queue.push({
          title: v.title,
          url: v.url,
          requestedBy: interaction.user.tag,
          guildId: interaction.guild.id,
          channelId: interaction.member.voice.channel.id,
          textChannelId: interaction.channelId,
        })
      );
      await interaction.editReply(`➕ เพิ่มเพลย์ลิสต์: **${pl.title}** (${vids.length} เพลง)`);
      logPretty("COMMAND", `🎮 /playlist by ${interaction.user.tag}`, {
        rtt,
        tail: `playlist="${pl.title}" added=${vids.length} queue_len=${queue.length}`,
      });

      if (!current) {
        await playNext({ guild: interaction.guild, textChannelId: interaction.channelId });
      }
    } catch (e) {
      await interaction.editReply("❌ โหลดเพลย์ลิสต์ไม่ได้");
      logPretty("ERROR", `Playlist load error: ${e?.message || e}`, { tail: `url=${url}` });
    }
  }
});

client.login(process.env.TOKEN);
