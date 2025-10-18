/**
 * OCbot1 - Supabase-backed index.js
 * - Uses Supabase Postgres for keys + memory persistence
 * - Keeps dedupe protections, dynamic repo GIF actions, chat + voice keys, quotas, TTS via OpenAI
 *
 * Required env vars:
 * - TOKEN (Discord bot token)
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_KEY (service role key for writes)
 * - GITHUB_REPO (owner/repo)
 * - GITHUB_TOKEN (optional, for higher rate limit)
 * - DEDUPE_DELAY_MS (optional, default 3000)
 * - DAILY_VOICE_LIMIT (optional, default 50)
 * - DAILY_CHAT_LIMIT (optional, default 50)
 * - AVG_TOKENS_PER_MESSAGE (optional, default 500)
 */

import fs from "fs";
import path from "path";
import os from "os";
import fetch from "node-fetch";
import express from "express";
import { Client, GatewayIntentBits, AttachmentBuilder } from "discord.js";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------ Config & env ------------------ */
const TOKEN = process.env.TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;

if (!TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("ERROR: TOKEN, SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in env.");
  process.exit(1);
}

const DEDUPE_DELAY_MS = Number(process.env.DEDUPE_DELAY_MS || 3000);
const DAILY_VOICE_LIMIT = Number(process.env.DAILY_VOICE_LIMIT || 50);
const DAILY_CHAT_LIMIT = Number(process.env.DAILY_CHAT_LIMIT || 50);
const AVG_TOKENS_PER_MESSAGE = Number(process.env.AVG_TOKENS_PER_MESSAGE || 500);
const PORT = process.env.PORT || 10000;

/* ------------------ Supabase client ------------------ */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

/* ------------------ Express (dummy port) ------------------ */
const app = express();
app.get("/", (_, res) => res.send("OCbot1 (Supabase) running"));
app.listen(PORT, () => console.log(`HTTP listening on ${PORT}`));

/* ------------------ Discord client ------------------ */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

/* ------------------ Repo/GIF helpers ------------------ */
let cachedRepoFiles = null;
let cachedRepoFetchedAt = 0;
const REPO_CACHE_TTL_MS = 60 * 1000;

async function listRepoFilesRoot() {
  if (!GITHUB_REPO) return [];
  const now = Date.now();
  if (cachedRepoFiles && (now - cachedRepoFetchedAt) < REPO_CACHE_TTL_MS) return cachedRepoFiles;
  const api = `https://api.github.com/repos/${GITHUB_REPO}/contents/`;
  const headers = { "User-Agent": "OCbot1" };
  if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;
  try {
    const res = await fetch(api, { headers });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("GitHub list error", res.status, txt);
      cachedRepoFiles = [];
      cachedRepoFetchedAt = now;
      return [];
    }
    const data = await res.json();
    cachedRepoFiles = data.filter(f => f.type === "file").map(f => f.name);
    cachedRepoFetchedAt = now;
    return cachedRepoFiles;
  } catch (e) {
    console.error("listRepoFilesRoot error", e);
    cachedRepoFiles = [];
    cachedRepoFetchedAt = now;
    return [];
  }
}
function rawUrlFor(filename) {
  return `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${filename}`;
}
async function detectActionsFromRepo() {
  const files = await listRepoFilesRoot();
  const gifs = files.filter(n => n.toLowerCase().endsWith(".gif"));
  const map = {};
  for (const name of gifs) {
    const base = name.replace(/\.gif$/i, "");
    const actionKey = base.replace(/[_\-\s\d]+/g, "").toLowerCase();
    if (!actionKey) continue;
    if (!map[actionKey]) map[actionKey] = [];
    map[actionKey].push(name);
  }
  return map;
}

/* ------------------ Supabase persistence helpers ------------------ */

/*
We create two tables in Supabase:
1) keys (user_id text PRIMARY KEY, data jsonb) -- stores per-user keys and counters
2) memory (id serial PRIMARY KEY, user_id text, role text, content text, created_at timestamptz default now())
SQL schema provided in setup steps below.
*/

async function getUserRow(userId) {
  // returns JS object or null
  const { data, error } = await supabase.from("keys").select("data").eq("user_id", userId).limit(1).single();
  if (error && error.code !== "PGRST116") { console.error("Supabase getUserRow error:", error); }
  return data?.data || null;
}
async function upsertUserRow(userId, dataObj) {
  const payload = { user_id: userId, data: dataObj };
  const { error } = await supabase.from("keys").upsert(payload, { onConflict: "user_id" });
  if (error) console.error("Supabase upsert error:", error);
}
async function deleteUserRow(userId) {
  const { error } = await supabase.from("keys").delete().eq("user_id", userId);
  if (error) console.error("Supabase delete error:", error);
}

async function appendMemory(userId, role, content) {
  const row = { user_id: userId, role, content };
  const { error } = await supabase.from("memory").insert(row);
  if (error) console.error("Supabase appendMemory error:", error);
}
async function fetchRecentMemory(limit = 300) {
  const { data, error } = await supabase.from("memory").select("user_id,role,content,created_at").order("created_at", { ascending: false }).limit(limit);
  if (error) { console.error("Supabase fetchRecentMemory error:", error); return []; }
  return data.reverse(); // return in chronological order
}

/* ------------------ Token estimation ------------------ */
function estimateTokensFromText(text) {
  const chars = text ? text.length : 0;
  return Math.max(1, Math.ceil(chars / 4));
}
function estimateTokensForCall(promptText, responseText) {
  return estimateTokensFromText(promptText) + estimateTokensFromText(responseText);
}

/* ------------------ Chat & Voice API helpers ------------------ */

async function callChatAPI(userMsg, apiKey, username) {
  const MODEL = "tngtech/deepseek-r1t2-chimera:free";
  const recent = await fetchRecentMemory(20);
  const messages = [{ role: "system", content: "You are OCbot1, a tomboyish gyaru anime girl: tomboyish speech, teasing, loyal to creator." }];
  for (const r of recent) {
    if (r.role && r.content) messages.push({ role: r.role === "assistant" ? "assistant" : "user", content: r.content });
  }
  messages.push({ role: "user", content: `${username}: ${userMsg}` });

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=> "");
      console.error("chat API error", res.status, txt);
      return { ok: false, error: `chat API error ${res.status}: ${txt}` };
    }
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content || null;
    return { ok: true, reply, raw: data };
  } catch (e) {
    console.error("callChatAPI exception", e);
    return { ok: false, error: e.message || "call failed" };
  }
}

async function generateVoiceOpenAI(text, openaiKey) {
  const tmp = path.join(os.tmpdir(), `ocbot_tts_${Date.now()}.mp3`);
  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text }),
    });
    if (!res.ok) {
      const t = await res.text().catch(()=>"");
      console.error("openai tts error", res.status, t);
      return { ok: false, error: `OpenAI TTS error ${res.status}: ${t}` };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmp, buffer);
    return { ok: true, path: tmp };
  } catch (e) {
    console.error("generateVoiceOpenAI error", e);
    return { ok: false, error: e.message || "tts failed" };
  }
}

/* ------------------ Dedupe & sendOnce ------------------ */
const replyReserved = new Set();
async function hasBotRepliedToMessage(originalMsg) {
  if (replyReserved.has(originalMsg.id)) return true;
  try {
    const msgs = await originalMsg.channel.messages.fetch({ limit: 50 });
    for (const m of msgs.values()) {
      if (m.author?.id === client.user?.id) {
        const ref = m.reference?.messageId || (m.reference && m.reference.messageId);
        if (ref === originalMsg.id) return true;
      }
    }
  } catch (e) {
    console.error("hasBotRepliedToMessage error:", e);
  }
  return false;
}
function reserveReply(msgId) {
  replyReserved.add(msgId);
  setTimeout(() => replyReserved.delete(msgId), 30_000);
}
async function sendOnce(originalMsg, replyOptions) {
  try {
    if (await hasBotRepliedToMessage(originalMsg)) return null;
    await new Promise(r => setTimeout(r, DEDUPE_DELAY_MS));
    if (await hasBotRepliedToMessage(originalMsg)) return null;
    reserveReply(originalMsg.id);
    return await originalMsg.reply(replyOptions);
  } catch (e) {
    console.error("sendOnce failed:", e);
    try { return await originalMsg.reply(replyOptions); } catch (err) { console.error("sendOnce fallback failed:", err); return null; }
  }
}

/* ------------------ Main message handler (single attach) ------------------ */
let listenerAttached = false;
let processing = new Set();

function attachListenerOnce() {
  if (listenerAttached) return;
  listenerAttached = true;

  client.on("messageCreate", async (msg) => {
    if (!msg || !msg.content) return;
    if (msg.author?.bot) return;
    if (processing.has(msg.id)) return;
    processing.add(msg.id);
    setTimeout(() => processing.delete(msg.id), 15_000);

    try {
      const content = msg.content.trim();
      const lc = content.toLowerCase();
      const uid = msg.author.id;

      // --- !commands ---
      if (lc === "!commands") {
        const actionMap = await detectActionsFromRepo();
        const actionList = Object.keys(actionMap).length ? Object.keys(actionMap).join(", ") : "No actions detected";
        return sendOnce(msg, { content:
          `📜 OCbot1 commands:\n` +
          "`!chat <message>` — chat (use !key to set chat key)\n" +
          "`!key <chatKey>` — save chat API key\n" +
          "`!setquota <tokens>` — set token quota for chat key\n" +
          "`!voice <text>` — generate voice clip (use !voicekey to set OpenAI key)\n" +
          "`!voicekey <key>` — save OpenAI key for TTS\n" +
          "`!voice setvoice <id>` — optional voice id\n" +
          "`!voice info` — show voice usage\n" +
          "`!actions <action> @user` — perform action (auto-detected GIFs)\n" +
          "`!info` — show quota & estimated messages left\n\nAvailable actions: ${actionList}`});
      }

      // --- !key (chat) ---
      if (lc.startsWith("!key ")) {
        const parts = content.split(/\s+/);
        const key = parts[1];
        if (!key) return sendOnce(msg, { content: "Usage: `!key <chatKey>`" });
        const row = (await getUserRow(uid)) || {};
        row.apiKey = key;
        row.messagesUsed = row.messagesUsed || 0;
        row.tokensUsed = row.tokensUsed || 0;
        row.lastReset = row.lastReset || new Date().toDateString();
        await upsertUserRow(uid, row);
        return sendOnce(msg, { content: "✅ Chat key saved (for !chat usage)." });
      }

      // --- !setquota ---
      if (lc.startsWith("!setquota ")) {
        const parts = content.split(/\s+/);
        const q = Number(parts[1]);
        if (!q || q <= 0) return sendOnce(msg, { content: "Usage: `!setquota <tokens>` (e.g. 100000)" });
        const row = (await getUserRow(uid)) || {};
        row.quotaTokens = q;
        row.tokensUsed = row.tokensUsed || 0;
        await upsertUserRow(uid, row);
        return sendOnce(msg, { content: `✅ Quota set to ${q} tokens.` });
      }

      // --- !voicekey ---
      if (lc.startsWith("!voicekey ")) {
        const key = content.split(/\s+/).slice(1).join(" ").trim();
        if (!key) return sendOnce(msg, { content: "Usage: `!voicekey <openai_key>`" });
        const row = (await getUserRow(uid)) || {};
        row.ttsKey = key;
        row.ttsProvider = "openai";
        row.voiceUsedToday = row.voiceUsedToday || 0;
        row.voiceLastReset = row.voiceLastReset || new Date().toDateString();
        await upsertUserRow(uid, row);
        return sendOnce(msg, { content: "✅ Voice key saved (OpenAI TTS)." });
      }

      // --- !voice setvoice ---
      if (lc.startsWith("!voice setvoice ")) {
        const vid = content.split(/\s+/).slice(2).join(" ").trim();
        if (!vid) return sendOnce(msg, { content: "Usage: `!voice setvoice <voiceId>`" });
        const row = (await getUserRow(uid)) || {};
        row.ttsVoiceId = vid;
        await upsertUserRow(uid, row);
        return sendOnce(msg, { content: `✅ Voice id set to ${vid}` });
      }

      // --- !voice info or !voicekey info ---
      if (lc === "!voice info" || lc === "!voicekey info") {
        const row = (await getUserRow(uid)) || {};
        if (!row.ttsKey) return sendOnce(msg, { content: "🔊 No voice key set. Use `!voicekey <key>`." });
        const used = row.voiceUsedToday || 0;
        const left = Math.max(DAILY_VOICE_LIMIT - used, 0);
        return sendOnce(msg, { content: `Voice key present. Today used: ${used}. Remaining voice uses today: ${left}` });
      }

      // --- !delkey (delete all) ---
      if (lc === "!delkey") {
        await deleteUserRow(uid);
        return sendOnce(msg, { content: "✅ All your keys and settings removed from the database." });
      }

      // --- !actions (list or perform) ---
      if (lc.startsWith("!actions")) {
        const parts = content.split(/\s+/).filter(Boolean);
        if (parts.length === 1 || parts[1].toLowerCase() === "list") {
          const map = await detectActionsFromRepo();
          const names = Object.keys(map);
          if (!names.length) return sendOnce(msg, { content: "No actions detected in the repo." });
          return sendOnce(msg, { content: `Available actions: ${names.join(", ")}` });
        }
        const actionName = parts[1].toLowerCase();
        const target = msg.mentions.users.first();
        const map = await detectActionsFromRepo();
        if (!map[actionName] || map[actionName].length === 0) return sendOnce(msg, { content: `No GIFs found for "${actionName}".` });
        const fileName = map[actionName][Math.floor(Math.random() * map[actionName].length)];
        const url = rawUrlFor(fileName);
        const text = target ? `*${msg.author.username} ${actionName}s ${target.username}!*` : `*${msg.author.username} ${actionName}s the air!*`;
        return sendOnce(msg, { content: text, files: [url] });
      }

      // --- !info (quota -> estimated messages left) ---
      if (lc === "!info") {
        const row = (await getUserRow(uid)) || {};
        if (!row.apiKey) return sendOnce(msg, { content: "You have no chat key set. Use `!key <chatKey>`." });
        const tokensUsed = row.tokensUsed || 0;
        const quota = row.quotaTokens || null;
        if (!quota) {
          const estMsgs = Math.floor(tokensUsed / Math.max(1, AVG_TOKENS_PER_MESSAGE));
          return sendOnce(msg, { content: `Estimated tokens used: ${tokensUsed}. Estimated messages used: ${estMsgs}. Set a quota with \`!setquota <tokens>\`.` });
        } else {
          const remainingTokens = Math.max(0, quota - tokensUsed);
          const estMessagesLeft = Math.floor(remainingTokens / Math.max(1, AVG_TOKENS_PER_MESSAGE));
          return sendOnce(msg, { content: `Quota: ${quota} tokens. Tokens used: ${tokensUsed}. Estimated messages left: ${estMessagesLeft}.` });
        }
      }

      // --- !chat <message> ---
      if (lc.startsWith("!chat")) {
        const row = (await getUserRow(uid)) || {};
        if (!row.apiKey) return sendOnce(msg, { content: "🔑 Add a chat key first with `!key <chatKey>`." });

        const today = new Date().toDateString();
        if (row.lastReset !== today) {
          row.messagesUsed = 0;
          row.tokensUsed = row.tokensUsed || 0;
          row.lastReset = today;
        }
        if ((row.messagesUsed || 0) >= DAILY_CHAT_LIMIT) return sendOnce(msg, { content: `🚫 You've hit daily chat limit (${DAILY_CHAT_LIMIT}).` });

        if (await hasBotRepliedToMessage(msg)) return;

        const userText = content.replace(/^!chat\s*/i, "").trim();
        if (!userText) return sendOnce(msg, { content: "Please provide a message with `!chat <message>`." });

        await msg.channel.sendTyping();
        const res = await callChatAPI(userText, row.apiKey, msg.author.username);
        if (!res.ok) return sendOnce(msg, { content: `⚠️ Chat failed: ${res.error}` });

        const aiReply = res.reply || "Hmm... nothing came back.";
        const usedTokens = estimateTokensForCall(userText, aiReply);
        row.tokensUsed = (row.tokensUsed || 0) + usedTokens;
        row.messagesUsed = (row.messagesUsed || 0) + 1;
        await upsertUserRow(uid, row);
        await appendMemory(uid, "user", userText);
        await appendMemory(uid, "assistant", aiReply);

        return sendOnce(msg, { content: aiReply });
      }

      // --- !voice <text> (OpenAI TTS) ---
      if (lc.startsWith("!voice ")) {
        const row = (await getUserRow(uid)) || {};
        if (!row.ttsKey) return sendOnce(msg, { content: "🔊 Add your OpenAI key first with `!voicekey <key>`." });

        const today = new Date().toDateString();
        if (row.voiceLastReset !== today) {
          row.voiceUsedToday = 0;
          row.voiceLastReset = today;
        }
        if ((row.voiceUsedToday || 0) >= DAILY_VOICE_LIMIT) return sendOnce(msg, { content: `🚫 You've hit daily voice limit (${DAILY_VOICE_LIMIT}).` });

        if (await hasBotRepliedToMessage(msg)) return;

        const text = content.replace(/^!voice\s*/i, "").trim();
        if (!text) return sendOnce(msg, { content: "Usage: `!voice <text>`" });

        await msg.channel.sendTyping();
        const ttsRes = await generateVoiceOpenAI(text, row.ttsKey);
        if (!ttsRes.ok) return sendOnce(msg, { content: `⚠️ TTS failed: ${ttsRes.error}` });

        try {
          const attach = new AttachmentBuilder(ttsRes.path);
          await sendOnce(msg, { content: `${msg.author.username} says:`, files: [attach] });
        } catch (e) {
          console.error("send voice file failed", e);
          return sendOnce(msg, { content: "⚠️ Failed to send audio file." });
        } finally {
          try { fs.unlinkSync(ttsRes.path); } catch {}
        }

        row.voiceUsedToday = (row.voiceUsedToday || 0) + 1;
        await upsertUserRow(uid, row);
        return;
      }

      // nothing matched -> ignore
      return;

    } catch (err) {
      console.error("message handler error:", err);
    } finally {
      processing.delete(msg.id);
    }
  });
}

attachListenerOnce();

client.once("ready", () => console.log("OCbot1 (Supabase) online as", client.user?.tag));
client.login(TOKEN).catch(e => console.error("Login failed:", e));
  
