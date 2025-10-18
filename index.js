/**
 * OCbot1 - index.js
 * - per-user chat API keys saved via: !key <chatKey>
 * - per-user TTS keys saved via: !voice key <ttsKey>
 * - per-user TTS voice id via: !voice setvoice <voiceId>
 * - !voice <text> generates an audio clip (ElevenLabs if key set, else TTSOpen fallback)
 * - dedupe protections: single listener guard + processing cache + single sendOnce
 *
 * NOTES:
 * - Keep keys.json in project root but add keys.json to .gitignore
 * - Make sure Render runs one instance (set instances = 1)
 */

import { Client, GatewayIntentBits, AttachmentBuilder } from "discord.js";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import express from "express";
import os from "os";

// --- CONFIG ---
const TOKEN_ENV = process.env.TOKEN; // Discord bot token (set in Render)
const MEMORY_FILE = "./memory.json";
const KEYS_FILE = "./keys.json";
const ACTIONS_FOLDER = "./actions";
const EMOTIONS_FOLDER = "./emotions";
const DAILY_LIMIT = 50;
const PORT = process.env.PORT || 10000;

// --- CLIENT ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// --- Ensure files exist ---
if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, JSON.stringify({ messages: [], players: {}, appearance: {} }, null, 2));
if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, JSON.stringify({}, null, 2));

// --- Load memory & keys ---
let memory = JSON.parse(fs.readFileSync(MEMORY_FILE));
let userKeys = JSON.parse(fs.readFileSync(KEYS_FILE)); // structure: { userId: { apiKey, messagesUsed, lastReset, ttsKey, ttsProvider, ttsVoiceId } }

// --- Helpers to save ---
const saveMemory = () => fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
const saveKeys = () => fs.writeFileSync(KEYS_FILE, JSON.stringify(userKeys, null, 2));

// --- Reset daily counts hourly ---
function resetDailyCounts() {
  const today = new Date().toDateString();
  let changed = false;
  for (const id in userKeys) {
    if (!userKeys[id].lastReset || userKeys[id].lastReset !== today) {
      userKeys[id].messagesUsed = 0;
      userKeys[id].lastReset = today;
      changed = true;
    }
  }
  if (changed) saveKeys();
}
setInterval(resetDailyCounts, 60 * 60 * 1000);

// --- Small caches for dedupe / re-entry prevention ---
let listenerAttached = false;
const processingMessages = new Set();     // prevents same instance re-entry
const replyReserved = new Set();         // prevents duplicated replies across quick successive code paths

function reserveReply(msgId) {
  replyReserved.add(msgId);
  setTimeout(() => replyReserved.delete(msgId), 30_000); // keep for 30s
}

// --- Utility: random file finder ---
function randomFile(folder, ext = ".gif") {
  try {
    const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith(ext.toLowerCase()));
    if (!files || files.length === 0) return null;
    return path.join(folder, files[Math.floor(Math.random() * files.length)]);
  } catch {
    return null;
  }
}

// --- Central sendOnce (dedupe + small delay + existence check) ---
async function hasBotRepliedToMessage(originalMsg) {
  // quick local guard
  if (replyReserved.has(originalMsg.id)) return true;
  try {
    // fetch recent messages in the channel and see if bot already replied referencing this message
    const messages = await originalMsg.channel.messages.fetch({ limit: 50 });
    for (const m of messages.values()) {
      if (m.author?.id === client.user?.id) {
        const ref = m.reference?.messageId || (m.reference && m.reference.messageId);
        if (ref === originalMsg.id) return true;
      }
    }
  } catch (e) {
    console.error("hasBotRepliedToMessage fetch error:", e);
  }
  return false;
}

async function sendOnce(originalMsg, replyOptions) {
  try {
    // quick pre-check
    if (await hasBotRepliedToMessage(originalMsg)) return null;
    // small delay to allow other instances to reply first
    await new Promise(r => setTimeout(r, Number(process.env.DEDUPE_DELAY_MS || 2000)));
    if (await hasBotRepliedToMessage(originalMsg)) return null;
    // reserve locally
    reserveReply(originalMsg.id);
    // send
    return await originalMsg.reply(replyOptions);
  } catch (e) {
    console.error("sendOnce failed:", e);
    try { return await originalMsg.reply(replyOptions); } catch (err) { console.error("Fallback reply failed:", err); return null; }
  }
}

// --- AI Chat (uses user's chat API key set by !key, else tells them to add one) ---
async function callChatAPI(userMsg, chatKey, username) {
  // chatKey expected to be an OpenRouter-style key (or user-provided model key)
  const MODEL = "tngtech/deepseek-r1t2-chimera:free";
  const messages = [
    { role: "system", content: "You are OCbot1, a tomboyish gyaru anime girl. Playful, teasing, confident; loyal to your creator." },
    ...memory.messages.slice(-50),
    { role: "user", content: `${username}: ${userMsg}` },
  ];

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${chatKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("Chat API error:", res.status, txt);
      return { ok: false, text: null, error: `Chat API error ${res.status}` };
    }
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content || null;
    if (!reply) return { ok: false, text: null, error: "No reply from chat API" };

    // save memory
    memory.messages.push({ user: userMsg, bot: reply });
    if (memory.messages.length > 300) memory.messages = memory.messages.slice(-300);
    saveMemory();

    return { ok: true, text: reply };
  } catch (e) {
    console.error("callChatAPI error:", e);
    return { ok: false, text: null, error: e.message || "chat call failed" };
  }
}

// --- Voice generation ---
// Supports two flows:
// - If user has ttsKey & ttsProvider 'eleven' -> call ElevenLabs TTS
// - Else -> fallback to TTSOpen.ai (no key) for free generation
async function generateVoiceAudio(text, userKeyData) {
  // returns { ok, path, error }
  // produce a temporary filename
  const tmpName = path.join(os.tmpdir(), `ocbot1_tts_${Date.now()}.mp3`);

  try {
    // prefer ElevenLabs if user has provided ttsKey and provider set to 'eleven'
    if (userKeyData?.ttsKey && (userKeyData.ttsProvider === "eleven" || userKeyData.ttsKey.startsWith("eleven") || userKeyData.ttsKey.startsWith("sk-"))) {
      // ElevenLabs usage:
      // user should set userKeyData.ttsVoiceId (voice id). If not provided we default to a common id placeholder.
      const voiceId = userKeyData.ttsVoiceId || "21m00Tcm4TlvDq8ikWAM"; // default example id; user can set real id with !voice setvoice <id>
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
      // request body
      const body = { text, model_id: "eleven_monolingual_v1" };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Accept": "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": userKeyData.ttsKey
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.error("ElevenLabs error", res.status, t);
        return { ok: false, error: `ElevenLabs error ${res.status}` };
      }
      const arrayBuffer = await res.arrayBuffer();
      fs.writeFileSync(tmpName, Buffer.from(arrayBuffer));
      return { ok: true, path: tmpName };
    }

    // Fallback: TTSOpen.ai (public free endpoint)
    // TTSOpen's simple API accepts POST /api/tts with JSON { text, voice } and returns audio (some deployments)
    // We'll try the official TTSOpen endpoint which often returns mp3 binary directly
    try {
      const ttsopenRes = await fetch("https://ttsopen.ai/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: userKeyData?.ttsVoiceId || "alloy" })
      });
      if (!ttsopenRes.ok) {
        const t = await ttsopenRes.text().catch(()=>"");
        console.error("TTSOpen error", ttsopenRes.status, t);
        return { ok: false, error: `TTSOpen error ${ttsopenRes.status}` };
      }
      const arr = await ttsopenRes.arrayBuffer();
      fs.writeFileSync(tmpName, Buffer.from(arr));
      return { ok: true, path: tmpName };
    } catch (e) {
      console.error("TTSOpen fallback failed:", e);
      return { ok: false, error: "No TTS provider available" };
    }

  } catch (e) {
    console.error("generateVoiceAudio error:", e);
    return { ok: false, error: e.message || "tts failed" };
  }
}

// --- Attach listener once (prevents multiple listeners on hot reload) ---
function attachListenerOnce() {
  if (listenerAttached) return;
  listenerAttached = true;

  client.on("messageCreate", async (msg) => {
    try {
      if (!msg || !msg.content) return;
      if (msg.author?.bot) return;

      // prevent re-entry for same message id (same instance)
      if (processingMessages.has(msg.id)) return;
      processingMessages.add(msg.id);
      setTimeout(() => processingMessages.delete(msg.id), 10_000);

      // if already replied recently, skip
      if (replyReserved.has(msg.id)) return;

      const content = msg.content.trim();
      const lc = content.toLowerCase();
      const uid = msg.author.id;

      // ---------- KEY / INFO commands ----------
      if (lc.startsWith("!key ")) {
        const parts = content.split(/\s+/);
        const key = parts[1];
        if (!key) return sendOnce(msg, { content: "Provide your chat API key: `!key <yourKey>`" });
        if (!userKeys[uid]) userKeys[uid] = {};
        userKeys[uid].apiKey = key;
        userKeys[uid].messagesUsed = userKeys[uid].messagesUsed || 0;
        userKeys[uid].lastReset = userKeys[uid].lastReset || new Date().toDateString();
        saveKeys();
        return sendOnce(msg, { content: "✅ Chat API key saved! Use `!chat <message>`." });
      }

      if (lc === "!info") {
        const k = userKeys[uid];
        if (!k) return sendOnce(msg, { content: "🔑 No keys found. Use `!key <chatKey>` and/or `!voice key <ttsKey>`." });
        const used = k.messagesUsed || 0;
        const remaining = Math.max(DAILY_LIMIT - used, 0);
        const voiceSet = k.ttsKey ? `Yes (provider=${k.ttsProvider || "eleven"})` : "No";
        const voiceId = k.ttsVoiceId || "(default)";
        return sendOnce(msg, { content: `💬 Chat used: ${used} / ${DAILY_LIMIT} today\n🔊 Voice key set: ${voiceSet}\n🎙 Voice id: ${voiceId}\nRemaining chat messages today: ${remaining}` });
      }

      // ---------- Voice key management ----------
      if (lc.startsWith("!voice key ")) {
        const parts = content.split(/\s+/);
        const key = parts.slice(2).join(" ").trim();
        if (!key) return sendOnce(msg, { content: "Usage: `!voice key <your-tts-key>`" });
        if (!userKeys[uid]) userKeys[uid] = {};
        userKeys[uid].ttsKey = key;
        // default provider guess: if key starts with 'sk-' treat as 'eleven'
        userKeys[uid].ttsProvider = userKeys[uid].ttsProvider || (key.startsWith("sk-") ? "eleven" : "eleven");
        userKeys[uid].ttsVoiceId = userKeys[uid].ttsVoiceId || null;
        saveKeys();
        return sendOnce(msg, { content: "✅ Voice key saved. Set a voice id with `!voice setvoice <voiceId>` (optional)." });
      }

      if (lc.startsWith("!voice setvoice ")) {
        const parts = content.split(/\s+/);
        const vid = parts.slice(2).join(" ").trim();
        if (!vid) return sendOnce(msg, { content: "Usage: `!voice setvoice <voiceId>` — e.g. ElevenLabs voice id" });
        if (!userKeys[uid]) userKeys[uid] = {};
        userKeys[uid].ttsVoiceId = vid;
        saveKeys();
        return sendOnce(msg, { content: `✅ Voice id set to \`${vid}\`. Use \`!voice <text>\` to speak.` });
      }

      if (lc === "!voice info") {
        const k = userKeys[uid];
        if (!k || !k.ttsKey) return sendOnce(msg, { content: "No voice key set. Use `!voice key <yourKey>`." });
        const provider = k.ttsProvider || "eleven";
        const vid = k.ttsVoiceId || "(default)";
        return sendOnce(msg, { content: `🔊 Provider: ${provider}\nVoice id: ${vid}` });
      }

      // ---------- Delete keys ----------
      if (lc === "!delkey") {
        if (userKeys[uid]) {
          delete userKeys[uid];
          saveKeys();
          return sendOnce(msg, { content: "🗑️ All your keys/settings deleted." });
        }
        return sendOnce(msg, { content: "You had no saved keys." });
      }

      // ---------- Commands list ----------
      if (lc === "!commands") {
        return sendOnce(msg, {
          content:
            "**OCbot1 Commands**\n" +
            "`!chat <message>` — Chat (uses your chat key set with `!key`)\n" +
            "`!key <chatKey>` — Save your chat API key\n" +
            "`!voice <text>` — Generate a voice clip (uses your voice key set with `!voice key`)\n" +
            "`!voice key <ttsKey>` — Save your personal TTS key (ElevenLabs recommended)\n" +
            "`!voice setvoice <voiceId>` — Set your ElevenLabs voice id\n" +
            "`!voice info` — Show your voice settings\n" +
            "`!info` — Show chat usage & voice key info\n" +
            "`!bonk @user` / `!kiss @user` — Fun actions"
        });
      }

      // ---------- Action commands (GIFs) ----------
      if (lc.startsWith("!bonk") || lc.startsWith("!kiss")) {
        const gif = randomFile(ACTIONS_FOLDER, ".gif");
        const mentioned = msg.mentions.users.first();
        const action = lc.startsWith("!bonk") ? "bonk" : "kiss";
        const text = mentioned ? `*${msg.author.username} ${action}s ${mentioned.username}!*` : `*${msg.author.username} ${action}s the air!*`;
        if (gif) return sendOnce(msg, { content: text, files: [new AttachmentBuilder(gif)] });
        return sendOnce(msg, { content: `${text} (No GIFs found)` });
      }

      // ---------- Chat ----------
      if (lc.startsWith("!chat")) {
        // Must have user chat key
        const k = userKeys[uid];
        if (!k || !k.apiKey) return sendOnce(msg, { content: "🔑 Add your chat key first with `!key <chatKey>`." });

        // reset daily
        const today = new Date().toDateString();
        if (k.lastReset !== today) { k.messagesUsed = 0; k.lastReset = today; }

        if ((k.messagesUsed || 0) >= DAILY_LIMIT) return sendOnce(msg, { content: `🚫 You've hit your daily limit of ${DAILY_LIMIT}.` });

        // pre-check: if already replied in channel referencing this message, abort (avoid other instances)
        if (await hasBotRepliedToMessage(msg)) return;

        const userText = content.replace(/^!chat\s*/i, "").trim() || "Hi!";
        await msg.channel.sendTyping();
        const chatResp = await callChatAPI(userText, k.apiKey, msg.author.username);
        if (!chatResp.ok) {
          return sendOnce(msg, { content: `⚠️ Chat failed: ${chatResp.error || "unknown"}` });
        }

        k.messagesUsed = (k.messagesUsed || 0) + 1;
        saveKeys();
        return sendOnce(msg, { content: chatResp.text });
      }

      // ---------- Voice speak ----------
      if (lc.startsWith("!voice ")) {
        // If user used voice subcommands above these will have returned earlier.
        const k = userKeys[uid];
        if (!k || !k.ttsKey) return sendOnce(msg, { content: "🔊 Please add your TTS API key first with `!voice key <yourKey>` (ElevenLabs recommended)." });

        // simple daily limit applies to chat keys only, but you can add limits here if wanted.

        const text = content.replace(/^!voice\s*/i, "").trim();
        if (!text) return sendOnce(msg, { content: "Usage: `!voice <text>`" });

        // check if another instance already replied
        if (await hasBotRepliedToMessage(msg)) return;

        // generate audio
        const audioRes = await generateVoiceAudio(text, k);
        if (!audioRes.ok) return sendOnce(msg, { content: `⚠️ TTS failed: ${audioRes.error || "unknown"}` });

        // send file
        try {
          const filePath = audioRes.path;
          const attach = new AttachmentBuilder(filePath);
          await sendOnce(msg, { content: `🔊 ${msg.author.username} says:`, files: [attach] });
          // cleanup
          try { fs.unlinkSync(filePath); } catch {}
        } catch (e) {
          console.error("send audio failed:", e);
          return sendOnce(msg, { content: "⚠️ Failed to send audio file." });
        }
      }

      // --- done
    } catch (err) {
      console.error("message handler error:", err);
    }
  });
}

attachListenerOnce();

// --- Ready ---
client.once("ready", () => {
  console.log(`✅ OCbot1 online as ${client.user?.tag}`);
});

// --- Express dummy server for Render ---
const app = express();
app.get("/", (req,res) => res.send("OCbot1 is running."));
app.listen(PORT, () => console.log(`🌐 listening on ${PORT}`));

// --- Login ---
client.login(TOKEN_ENV).catch(e => console.error("Login failed:", e));
        
