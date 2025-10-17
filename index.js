// index.js - OCbot1 Final (Actions first, dedupe fixed)
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

// ---------- CLIENT ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ---------- MEMORY ----------
let memory = { messages: [], players: {}, appearance: { description: "", notes: "" } };
try {
  if (fs.existsSync(MEMORY_FILE)) {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    memory = raw ? JSON.parse(raw) : memory;
  }
} catch (e) { console.error("Error reading memory.json:", e); }
if (!Array.isArray(memory.messages)) memory.messages = [];
if (!memory.players) memory.players = {};
if (!memory.appearance) memory.appearance = { description: "", notes: "" };

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
  p.interactions++;
  if (message) p.messages.push(message);
  if (p.messages.length > 30) p.messages = p.messages.slice(-30);
  saveMemory();
}
function trackUser(id, username, message = "") { if (!id || !username) return; safeTrackPlayer(String(id), username, message); }

// ---------- FILE DETECTION ----------
function listRepoFiles() { try { return fs.readdirSync("./").filter(f => fs.statSync(f).isFile()); } catch (e) { return []; } }
function detectEmotionImages() { return listRepoFiles().filter(f => f.toLowerCase().endsWith(".jpg") || f.toLowerCase().endsWith(".jpeg")); }
function detectGifsByAction() {
  const files = listRepoFiles();
  const gifs = files.filter(f => f.toLowerCase().endsWith(".gif"));
  const map = {};
  for (const g of gifs) {
    const name = g.split(".gif")[0];
    const action = name.replace(/[_\-\s]+/g, "").replace(/\d+$/, "").toLowerCase();
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
    return reply;
  } catch (e) { console.error("askAI error:", e); return "Hmm… something went wrong 😖"; }
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

// ---------- SEND ONCE / DEDUPE ----------
const recentMessages = new Set();
const MESSAGE_TTL_MS = Number(process.env.MESSAGE_TTL_MS || 20000);

async function hasBotRepliedToMessage(originalMsg) {
  try {
    if (recentMessages.has(originalMsg.id)) return true;
    const messages = await originalMsg.channel.messages.fetch({ limit: 50 });
    for (const m of messages.values()) {
      if (m.author?.id === client.user?.id) {
        const refId = m.reference?.messageId;
        if (refId === originalMsg.id) return true;
      }
    }
  } catch {}
  return false;
}

async function sendOnce(originalMsg, replyOptions) {
  const delayMs = Number(process.env.DEDUPE_DELAY_MS || 3000);
  if (await hasBotRepliedToMessage(originalMsg)) return null;
  await new Promise((r) => setTimeout(r, delayMs));
  if (await hasBotRepliedToMessage(originalMsg)) return null;

  recentMessages.add(originalMsg.id);
  setTimeout(() => recentMessages.delete(originalMsg.id), MESSAGE_TTL_MS);

  try { return await originalMsg.reply(replyOptions); } 
  catch (e) { console.error("sendOnce failed:", e); }
}

// ---------- STARTUP APPEARANCE ----------
if (!memory.appearance.description) {
  memory.appearance = {
    description: "Short blonde hair, pink eyes, tanned skin, curvy body, wears a black cap and oversized black hoodie.",
    notes: "Tomboyish, teasing, confident voice; loyal to creator (Xander)."
  };
  saveMemory();
}

// ---------- MESSAGE HANDLER ----------
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.author?.id || msg.author.bot || !msg.content) return;
    const content = msg.content.trim();
    const lc = content.toLowerCase();

    // ---------- ACTIONS FIRST ----------
    const actionMatch = content.match(/^!chat\s*ocbot1\s+([a-zA-Z]+)\s*(<@!?\d+>)?/i) 
                     || content.match(/^ocbot1\s+([a-zA-Z]+)\s*(<@!?\d+>)?/i);
    const actionMap = detectGifsByAction();
    if (actionMatch) {
      const action = actionMatch[1]?.toLowerCase();
      if (action && actionMap[action]) {
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

    // ---------- CHAT ----------
    if (!(lc.startsWith("!chat") || lc.startsWith("!hi"))) return;

    let userMsg = content.replace(/^!chat\s*/i,"").replace(/^!hi\s*/i,"").trim();
    if (!userMsg) return await sendOnce(msg, { content: "Try saying `!chat Hey OCbot1!` 🙂" });

    const isCreator = msg.author.id === CREATOR_ID;
    if (isCreator) userMsg = "[CREATOR] " + userMsg;

    trackUser(msg.author.id, msg.author.username, msg.content);
    await msg.channel.sendTyping();

    const aiReply = await askAI(userMsg, isCreator);
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
    console.error("messageCreate handler error:", err);
  }
});

// ---------- READY ----------
client.once("ready", async () => {
  console.log(`✅ OCbot1 is online as ${client.user?.tag}`);
  client.user.setActivity("with anime vibes", { type: ActivityType.Playing });
});

// ---------- EXPRESS ----------
const app = express();
app.get("/", (req,res)=>res.send("OCbot1 is running."));
app.listen(EXPRESS_PORT, ()=>console.log(`🌐 Express listening on port ${EXPRESS_PORT}`));

// ---------- LOGIN ----------
client.login(DISCORD_TOKEN).catch(e=>console.error("Failed to login:", e));
  
