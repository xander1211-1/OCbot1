// index.js - OCbot1 (race-reduction + logging)
import fs from "fs";
import fetch from "node-fetch";
import express from "express";
import { Client, GatewayIntentBits, AttachmentBuilder, ActivityType } from "discord.js";

// ---------- CONFIG ----------
const CREATOR_ID = "1167751946577379339";
const MODEL = "tngtech/deepseek-r1t2-chimera:free";
const MEMORY_FILE = "./memory.json";
const EXPRESS_PORT = 10000;

// ---------- ENV ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
if (!DISCORD_TOKEN) console.error("⚠️ DISCORD_TOKEN missing!");
if (!OPENROUTER_KEY) console.error("⚠️ OPENROUTER_API_KEY missing!");

// ---------- CLIENT ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ---------- GLOBAL ERROR HANDLING ----------
process.on("unhandledRejection", (err) => console.error("Unhandled promise rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

// ---------- MEMORY ----------
let memory = { messages: [], players: {}, appearance: { description: "", notes: "" } };
try {
  if (fs.existsSync(MEMORY_FILE)) {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") memory = parsed;
  }
} catch (e) { console.error("Error reading memory.json:", e); }
if (!Array.isArray(memory.messages)) memory.messages = [];
if (!memory.players || typeof memory.players !== "object") memory.players = {};
if (!memory.appearance || typeof memory.appearance !== "object") memory.appearance = { description: "", notes: "" };

function saveMemory() {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2)); }
  catch (e) { console.error("Failed to save memory.json:", e); }
}

// ---------- TRACKING ----------
function safeTrackPlayer(id, username, message = "") {
  if (!id || !username) return;
  const idStr = String(id);
  if (!memory.players[idStr]) memory.players[idStr] = { name: username, interactions: 0, messages: [] };
  const p = memory.players[idStr];
  p.name = username;
  p.interactions = (p.interactions || 0) + 1;
  if (message) p.messages.push(message);
  if (p.messages.length > 30) p.messages = p.messages.slice(-30);
  saveMemory();
}
function trackUser(id, username, message = "") { if (!id || !username) return; safeTrackPlayer(String(id), username, message); }

// ---------- FILE DETECTION ----------
function listRepoFiles() { try { return fs.readdirSync("./").filter(f => fs.statSync(f).isFile()); } catch (e) { console.error("listRepoFiles error:", e); return []; } }
function detectEmotionImages() { return listRepoFiles().filter(f => f.toLowerCase().endsWith(".jpg") || f.toLowerCase().endsWith(".jpeg")); }
function detectGifsByAction() {
  const files = listRepoFiles();
  const gifs = files.filter(f => f.toLowerCase().endsWith(".gif"));
  const map = {};
  for (const g of gifs) {
    const name = g.split(".gif")[0];
    const action = name.replace(/[_\-\s]+/g, "").replace(/\d+$/, "").toLowerCase();
    if (!action) continue;
    if (!map[action]) map[action] = [];
    map[action].push(g);
  }
  return map;
}

// ---------- EMOTION DETECTION ----------
function detectEmotionFromText(text) {
  const t = (text || "").toLowerCase();
  if (t.match(/\b(happy|yay|love|good|excited|cute|sweet)\b/)) return "happy";
  if (t.match(/\b(sad|cry|unhappy|lonely|sorry|bad|tear)\b/)) return "sad";
  if (t.match(/\b(angry|mad|furious|annoy|rage|hate)\b/)) return "angry";
  return "neutral";
}

// ---------- OPENROUTER ----------
async function askAI(userMsg, isCreator = false) {
  const system = isCreator
    ? "You are OCbot1, a tomboyish gyaru anime girl. Playful, teasing, confident. Treat this user as your creator respectfully."
    : "You are OCbot1, a tomboyish gyaru anime girl. Playful, teasing, confident, SFW.";
  const messages = [{ role: "system", content: system }];
  const recent = memory.messages.slice(-300);
  for (const m of recent) { messages.push({ role: "user", content: m.user }); messages.push({ role: "assistant", content: m.bot }); }
  messages.push({ role: "user", content: userMsg });

  try {
    console.log(`[pid ${process.pid}] calling AI for msg snippet: "${userMsg.slice(0,60)}"`);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages }),
    });
    const data = await res.json().catch(() => null);
    const reply = data?.choices?.[0]?.message?.content || "Uhh, my brain blanked out 😅";
    memory.messages.push({ user: userMsg, bot: reply });
    if (memory.messages.length > 300) memory.messages = memory.messages.slice(-300);
    saveMemory();
    console.log(`[pid ${process.pid}] AI replied (len ${reply.length})`);
    return reply;
  } catch (e) {
    console.error(`[pid ${process.pid}] askAI error:`, e);
    return "Hmm… something went wrong 😖";
  }
}

// ---------- COMMAND LIST ----------
function buildCommandsList() {
  const actionMap = detectGifsByAction();
  const actionNames = Object.keys(actionMap).sort();
  const actionsLine = actionNames.length ? actionNames.join(", ") : "No actions uploaded yet";
  return `💬 OCbot1 Commands:
!chat OCbot1 <message> — Talk with OCbot1
!chat OCbot1 <action> @user — Perform an action (auto-detected from GIFs)
!emotion <emotion> — Send a specific emotion image
!memory — Show memory usage and top players
!commands — Show this list

Available actions: ${actionsLine}`;
}

// ---------- SEND ONCE / DEDUPE + LOGGING ----------
const recentMessages = new Set();
const MESSAGE_TTL_MS = Number(process.env.MESSAGE_TTL_MS || 30000); // 30s default
async function hasBotRepliedToMessage(originalMsg) {
  try {
    // local quick-check
    if (recentMessages.has(originalMsg.id)) {
      console.log(`[pid ${process.pid}] hasBotRepliedToMessage: local cache TRUE for ${originalMsg.id}`);
      return true;
    }

    // fetch recent messages in channel and check for a reply referencing this message
    const messages = await originalMsg.channel.messages.fetch({ limit: 50 });
    for (const m of messages.values()) {
      if (m.author?.id === client.user?.id) {
        const refId = m.reference?.messageId || (m.reference && m.reference.messageId);
        if (refId === originalMsg.id) {
          console.log(`[pid ${process.pid}] hasBotRepliedToMessage: found channel reply by bot for ${originalMsg.id}`);
          return true;
        }
      }
    }
  } catch (e) {
    console.error(`[pid ${process.pid}] hasBotRepliedToMessage error:`, e);
  }
  return false;
}

async function sendOnce(originalMsg, replyOptions) {
  const delayMs = Number(process.env.DEDUPE_DELAY_MS || 8000); // 8s default
  try {
    console.log(`[pid ${process.pid}] sendOnce: pre-check for ${originalMsg.id}`);
    if (await hasBotRepliedToMessage(originalMsg)) {
      console.log(`[pid ${process.pid}] sendOnce: skipping because already replied ${originalMsg.id}`);
      return null;
    }

    // wait to give other instances time to reply first (configurable)
    console.log(`[pid ${process.pid}] sendOnce: waiting ${delayMs}ms before sending ${originalMsg.id}`);
    await new Promise(r => setTimeout(r, delayMs));

    if (await hasBotRepliedToMessage(originalMsg)) {
      console.log(`[pid ${process.pid}] sendOnce: skipping after delay because found reply ${originalMsg.id}`);
      return null;
    }

    // mark handled locally (so this instance won't double-process)
    recentMessages.add(originalMsg.id);
    setTimeout(() => recentMessages.delete(originalMsg.id), MESSAGE_TTL_MS);

    const sent = await originalMsg.reply(replyOptions);
    console.log(`[pid ${process.pid}] sendOnce: sent reply for ${originalMsg.id}`);
    return sent;
  } catch (e) {
    console.error(`[pid ${process.pid}] sendOnce failed:`, e);
    try { return await originalMsg.reply(replyOptions); } catch (err) { console.error(`[pid ${process.pid}] fallback reply failed:`, err); return null; }
  }
}

// ---------- STARTUP APPEARANCE ----------
if (!memory.appearance || !memory.appearance.description) {
  memory.appearance = {
    description: "Short blonde hair, pink eyes, tanned skin, curvy body, wears a black cap and oversized black hoodie.",
    notes: "Tomboyish, teasing, confident voice; loyal to creator (Xander)."
  };
  saveMemory();
}

// ---------- MESSAGE HANDLER (actions-first; early pre-check before AI) ----------
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.author?.id || msg.author.bot || !msg.content) return;
    console.log(`[pid ${process.pid}] messageCreate: id=${msg.id} author=${msg.author.tag} content="${msg.content.slice(0,100)}"`);

    const content = msg.content.trim();
    const lc = content.toLowerCase();

    // ---------- ACTIONS FIRST ----------
    const actionMatch = content.match(/^!chat\s*ocbot1\s+([a-zA-Z]+)\s*(<@!?\d+>)?/i)
                     || content.match(/^ocbot1\s+([a-zA-Z]+)\s*(<@!?\d+>)?/i);
    const actionMap = detectGifsByAction();
    if (actionMatch) {
      const action = actionMatch[1]?.toLowerCase();
      if (action && actionMap[action]) {
        // early check — if someone already replied, skip
        if (await hasBotRepliedToMessage(msg)) {
          console.log(`[pid ${process.pid}] action: skipping because already replied (msg ${msg.id})`);
          return;
        }

        const mentionRaw = actionMatch[2];
        let targetUser = null;
        if (mentionRaw) {
          const idMatch = mentionRaw.match(/\d+/);
          if (idMatch) {
            try { targetUser = await msg.client.users.fetch(idMatch[0]); } catch {}
            if (targetUser) trackUser(targetUser.id, targetUser.username);
          }
        }
        const actor = msg.author.id === CREATOR_ID ? "Boss" : msg.author.username;
        const targetName = targetUser ? targetUser.username : "someone";
        const templates = [
          `${actor} does a move on ${targetName}!`,
          `Heh, lemme at 'em — ${actor} -> ${targetName}!`,
          `${actor} shows no mercy to ${targetName} 😏`
        ];
        const messageText = templates[Math.floor(Math.random()*templates.length)];
        const gifs = actionMap[action];
        const pick = gifs[Math.floor(Math.random()*gifs.length)];
        if (pick && fs.existsSync(`./${pick}`)) {
          const buf = fs.readFileSync(`./${pick}`);
          return await sendOnce(msg, { content: messageText, files: [new AttachmentBuilder(buf, { name: pick })] });
        } else {
          return await sendOnce(msg, { content: messageText });
        }
      }
    }

    // ---------- CHAT / COMMANDS ----------
    if (lc.startsWith("!commands")) {
      return await sendOnce(msg, { content: buildCommandsList() });
    }
    if (lc.startsWith("!memory")) {
      const playerCount = Object.keys(memory.players).length;
      const top = Object.entries(memory.players)
        .sort((a,b)=> (b[1].interactions||0) - (a[1].interactions||0))
        .slice(0,5)
        .map(([id,p])=> `${p.name} (${p.interactions||0})`);
      return await sendOnce(msg, { content: `Memory: ${playerCount} players stored.\nTop interactions: ${top.join(", ") || "none"}\nAppearance: ${memory.appearance.description}` });
    }
    if (lc.startsWith("!emotion")) {
      const parts = content.split(/\s+/);
      if (parts.length < 2) return await sendOnce(msg, { content: "Usage: !emotion <name>" });
      const want = parts[1].toLowerCase();
      const emotions = detectEmotionImages();
      const pick = emotions.find(e => e.toLowerCase().includes(want));
      if (!pick) return await sendOnce(msg, { content: `No emotion image matching "${want}" found.` });
      try { const buf = fs.readFileSync(`./${pick}`); return await sendOnce(msg, { files: [new AttachmentBuilder(buf, { name: pick })] }); }
      catch (e) { console.error("sending emotion failed:", e); return await sendOnce(msg, { content: "Could not send that emotion file." }); }
    }

    // only process regular chat if starts with !chat or !hi
    if (!(lc.startsWith("!chat") || lc.startsWith("!hi"))) return;

    let userMsg = content.replace(/^!chat\s*/i,"").replace(/^!hi\s*/i,"").trim();
    if (!userMsg) return await sendOnce(msg, { content: "Try saying `!chat Hey OCbot1!` 🙂" });

    const isCreator = msg.author.id === CREATOR_ID;
    if (isCreator) userMsg = "[CREATOR] " + userMsg;

    // early check — if someone already replied, skip doing the AI call
    if (await hasBotRepliedToMessage(msg)) {
      console.log(`[pid ${process.pid}] chat: skipping because already replied (msg ${msg.id})`);
      return;
    }

    // track & typing
    trackUser(msg.author.id, msg.author.username, msg.content);
    await msg.channel.sendTyping();

    // --- call AI (only after we know no reply exists yet)
    console.log(`[pid ${process.pid}] chat: calling AI for ${msg.id}`);
    const aiReply = await askAI(userMsg, isCreator);
    console.log(`[pid ${process.pid}] chat: got AI reply for ${msg.id}`);

    const replyText = aiReply.length > 1900 ? aiReply.slice(0,1900)+"..." : aiReply;
    const emotion = detectEmotionFromText(replyText);
    const emotions = detectEmotionImages();
    let pick = emotions.find(e => e.toLowerCase().includes(emotion));
    if (!pick && emotions.length) pick = emotions[Math.floor(Math.random()*emotions.length)];
    if (pick && fs.existsSync(`./${pick}`)) {
      const buf = fs.readFileSync(`./${pick}`);
      return await sendOnce(msg, { content: replyText, files: [new AttachmentBuilder(buf, { name: pick })] });
    } else {
      return await sendOnce(msg, { content: replyText });
    }

  } catch (err) {
    console.error(`[pid ${process.pid}] messageCreate handler error:`, err);
  }
});

// ---------- READY ----------
client.once("ready", async () => {
  console.log(`✅ OCbot1 is online as ${client.user?.tag} (pid=${process.pid})`);
  try {
    client.user.setActivity("with anime vibes", { type: ActivityType.Playing });
    // optional: announce in system channels (safe-guarded)
    const startupMsg = "Yo! OCbot1's up and ready to cause some chaos 😎";
    for (const guild of client.guilds.cache.values()) {
      try { if (guild.systemChannel) await guild.systemChannel.send(startupMsg).catch(()=>{}); } catch {}
    }
  } catch (e) { console.error("ready hook error:", e); }
});

// ---------- EXPRESS ----------
const app = express();
app.get("/", (req,res)=>res.send("OCbot1 is running."));
app.listen(EXPRESS_PORT, ()=>console.log(`🌐 Express listening on port ${EXPRESS_PORT}`));

// ---------- LOGIN ----------
client.login(DISCORD_TOKEN).catch(e=>console.error("Failed to login:", e));
