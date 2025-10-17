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
let memory = { messages: [], players: {}, appearance: {} };
try {
  if (fs.existsSync(MEMORY_FILE)) {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    memory = raw ? JSON.parse(raw) : memory;
  }
} catch (e) { console.error("Error reading memory.json:", e); }

function saveMemory() {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2)); }
  catch (e) { console.error("Failed to save memory.json:", e); }
}

// ---------- TRACKING ----------
function trackPlayer(id, username, message = "") {
  if (!id || !username) return;
  if (!memory.players[id]) memory.players[id] = { name: username, interactions: 0, messages: [] };
  const p = memory.players[id];
  p.name = username;
  p.interactions++;
  if (message) p.messages.push(message);
  if (p.messages.length > 30) p.messages = p.messages.slice(-30);
  saveMemory();
}

// ---------- FILE DETECTION ----------
function listRepoFiles() {
  try { return fs.readdirSync("./").filter(f => fs.statSync(f).isFile()); }
  catch (e) { console.error("listRepoFiles error:", e); return []; }
}
function detectEmotionImages() { return listRepoFiles().filter(f => f.toLowerCase().endsWith(".jpg") || f.toLowerCase().endsWith(".jpeg")); }
function detectGifsByAction() {
  const files = listRepoFiles().filter(f => f.toLowerCase().endsWith(".gif"));
  const map = {};
  for (const g of files) {
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
  for (const m of recent) {
    messages.push({ role: "user", content: m.user });
    messages.push({ role: "assistant", content: m.bot });
  }
  messages.push({ role: "user", content: userMsg });

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages }),
    });

    if (!res.ok) {
      console.error("API call failed:", await res.text());
      return "Hmm… something went wrong 😖";
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) return "Hmm… something went wrong 😖";

    memory.messages.push({ user: userMsg, bot: reply });
    if (memory.messages.length > 300) memory.messages = memory.messages.slice(-300);
    saveMemory();

    return reply;
  } catch (e) {
    console.error("askAI error:", e);
    return "Hmm… something went wrong 😖";
  }
}

// ---------- SEND ONCE ----------
const recentMessages = new Set();
const MESSAGE_TTL_MS = 30000;
const DEDUPE_DELAY_MS = 8000;

async function hasBotRepliedToMessage(msg) {
  if (recentMessages.has(msg.id)) return true;
  try {
    const messages = await msg.channel.messages.fetch({ limit: 50 });
    for (const m of messages.values()) {
      if (m.author?.id === client.user?.id && (m.reference?.messageId || m.reference?.messageId) === msg.id) return true;
    }
  } catch (e) { console.error("hasBotRepliedToMessage error:", e); }
  return false;
}

async function sendOnce(msg, options) {
  try {
    if (await hasBotRepliedToMessage(msg)) return;
    await new Promise(r => setTimeout(r, DEDUPE_DELAY_MS));
    if (await hasBotRepliedToMessage(msg)) return;

    recentMessages.add(msg.id);
    setTimeout(() => recentMessages.delete(msg.id), MESSAGE_TTL_MS);

    return await msg.reply(options);
  } catch (e) { console.error("sendOnce failed:", e); }
}

// ---------- COMMAND LIST ----------
function buildCommandsList() {
  const actions = Object.keys(detectGifsByAction()).sort();
  const actionList = actions.length ? actions.join(", ") : "No actions uploaded yet";
  return `💬 OCbot1 Commands:
!chat OCbot1 <message> — Talk with OCbot1
!chat OCbot1 <action> @user — Perform an action (auto-detected from GIFs)
!emotion <emotion> — Send a specific emotion image
!memory — Show memory usage and top players
!commands — Show this list

Available actions: ${actionList}`;
}

// ---------- MESSAGE HANDLER ----------
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.author?.id || msg.author.bot || !msg.content) return;

    const lc = msg.content.toLowerCase().trim();
    let replyOptions = null;

    // ---------- ACTIONS ----------
    const actionMatch = msg.content.match(/^!chat\s*ocbot1\s+([a-zA-Z]+)\s*(<@!?\d+>)?/i)
                     || msg.content.match(/^ocbot1\s+([a-zA-Z]+)\s*(<@!?\d+>)?/i);
    const actionMap = detectGifsByAction();
    if (actionMatch) {
      const action = actionMatch[1]?.toLowerCase();
      if (action && actionMap[action]) {
        let targetUser = null;
        if (actionMatch[2]) {
          const idMatch = actionMatch[2].match(/\d+/);
          if (idMatch) {
            try { targetUser = await msg.client.users.fetch(idMatch[0]); } catch {}
          }
        }

        const actor = msg.author.id === CREATOR_ID ? "Boss" : msg.author.username;
        const targetName = targetUser ? targetUser.username : "someone";
        const templates = [
          `${actor} does a move on ${targetName}!`,
          `Heh, lemme at 'em — ${actor} -> ${targetName}!`,
          `${actor} shows no mercy to ${targetName} 😏`
        ];
        const text = templates[Math.floor(Math.random() * templates.length)];
        const gifs = actionMap[action];
        const pick = gifs[Math.floor(Math.random() * gifs.length)];

        if (pick && fs.existsSync(`./${pick}`)) {
          const buf = fs.readFileSync(`./${pick}`);
          replyOptions = { content: text, files: [new AttachmentBuilder(buf, { name: pick })] };
        } else replyOptions = { content: text };
      }
    }

    // ---------- COMMANDS ----------
    else if (lc.startsWith("!commands")) replyOptions = { content: buildCommandsList() };
    else if (lc.startsWith("!memory")) {
      const playerCount = Object.keys(memory.players).length;
      const top = Object.entries(memory.players).sort((a,b)=> (b[1].interactions||0)-(a[1].interactions||0))
        .slice(0,5).map(([id,p])=> `${p.name} (${p.interactions||0})`);
      replyOptions = { content: `Memory: ${playerCount} players stored.\nTop interactions: ${top.join(", ") || "none"}\nAppearance: ${memory.appearance.description}` };
    }
    else if (lc.startsWith("!emotion")) {
      const parts = msg.content.split(/\s+/);
      if (parts.length < 2) replyOptions = { content: "Usage: !emotion <name>" };
      else {
        const want = parts[1].toLowerCase();
        const emotions = detectEmotionImages();
        const pick = emotions.find(e=>e.toLowerCase().includes(want));
        if (!pick) replyOptions = { content: `No emotion image matching "${want}" found.` };
        else {
          const buf = fs.readFileSync(`./${pick}`);
          replyOptions = { files: [new AttachmentBuilder(buf, { name: pick })] };
        }
      }
    }

    // ---------- CHAT ----------
    else if (lc.startsWith("!chat") || lc.startsWith("!hi")) {
      let userMsg = msg.content.replace(/^!chat\s*/i,"").replace(/^!hi\s*/i,"").trim();
      if (!userMsg) userMsg = "Hey!";
      const isCreator = msg.author.id === CREATOR_ID;
      if (isCreator) userMsg = "[CREATOR] " + userMsg;

      trackPlayer(msg.author.id, msg.author.username, msg.content);
      await msg.channel.sendTyping();
      const aiReply = await askAI(userMsg, isCreator);
      const replyText = aiReply.length > 1900 ? aiReply.slice(0,1900)+"..." : aiReply;

      const emotion = detectEmotionFromText(replyText);
      const emotions = detectEmotionImages();
      let pick = emotions.find(e=>e.toLowerCase().includes(emotion));
      if (!pick && emotions.length) pick = emotions[Math.floor(Math.random()*emotions.length)];

      if (pick && fs.existsSync(`./${pick}`)) {
        const buf = fs.readFileSync(`./${pick}`);
        replyOptions = { content: replyText, files: [new AttachmentBuilder(buf, { name: pick })] };
      } else replyOptions = { content: replyText };
    }

    if (replyOptions) await sendOnce(msg, replyOptions);
  } catch (err) { console.error("messageCreate handler error:", err); }
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
