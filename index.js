import fs from "fs";
import fetch from "node-fetch";
import express from "express";
import { Client, GatewayIntentBits, AttachmentBuilder } from "discord.js";

// --- Global Error Handlers ---
process.on("unhandledRejection", (err) => console.error("Unhandled promise rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- Creator ID ---
const CREATOR_ID = "1167751946577379339"; // Your Discord ID

// --- Environment Variables ---
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = "tngtech/deepseek-r1t2-chimera:free";
const MEMORY_FILE = "./memory.json";

if (!process.env.DISCORD_TOKEN) console.error("⚠️ DISCORD_TOKEN missing!");
if (!OPENROUTER_KEY) console.error("⚠️ OPENROUTER_API_KEY missing!");

// --- Memory Load & Safe Tracking ---
let memory = { messages: [], players: {} };
try {
  if (fs.existsSync(MEMORY_FILE)) {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") memory = parsed;
  }
} catch (err) {
  console.error("Failed to read/parse memory.json — starting fresh. Error:", err);
  memory = { messages: [], players: {} };
}

if (!memory || typeof memory !== "object") memory = { messages: [], players: {} };
if (!Array.isArray(memory.messages)) memory.messages = [];
if (!memory.players || typeof memory.players !== "object") memory.players = {};

function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (err) {
    console.error("Failed to save memory.json:", err);
  }
}

function safeTrackPlayer(id, username, message = "") {
  if (!id || !username) return;
  const idStr = String(id);
  if (!memory.players[idStr]) memory.players[idStr] = { name: username, interactions: 0, messages: [] };
  else memory.players[idStr].name = username;
  const p = memory.players[idStr];
  p.interactions = (p.interactions || 0) + 1;
  if (message) p.messages.push(message);
  if (p.messages.length > 50) p.messages = p.messages.slice(-50);
  saveMemory();
}

function trackUser(id, username, message = "") {
  if (!id || !username) return;
  safeTrackPlayer(String(id), username, message);
}

// --- Emotion Detection ---
function detectEmotion(text) {
  const t = (text || "").toLowerCase();
  if (t.match(/\b(happy|yay|love|good|excited|cute|sweet)\b/)) return "happy";
  if (t.match(/\b(sad|cry|unhappy|lonely|sorry|bad|tear)\b/)) return "sad";
  if (t.match(/\b(angry|mad|furious|annoy|rage|hate)\b/)) return "angry";
  return "neutral";
}

// --- AI Chat ---
async function askAI(userMsg, isCreator = false) {
  const messages = [{ role: "system", content: `You are OCbot1, a gyaru tomboy anime girl. Playful, teasing, confident, SFW. ${isCreator ? "You know this user is your creator and treat them specially." : ""}` }];
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
  } catch (err) {
    console.error("Error fetching AI response:", err);
    return "Hmm… something went wrong 😖";
  }
}

// --- AI Opinion ---
async function askOpinion(botName, player, isCreatorMentioned = false) {
  const history = (player && player.messages) ? player.messages.join("\n") : "No past messages yet.";
  const prompt = `
You are ${botName}, a gyaru tomboy anime girl.
${isCreatorMentioned ? "This is about your creator." : ""}
Someone asked what you think of ${player?.name || "them"}.
Form an opinion based on this chat history, sassy/flirty but SFW, under 3 sentences.
Chat history:
${history}
`;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json().catch(() => null);
    return data?.choices?.[0]?.message?.content || `Hmm… I don’t know much about ${player?.name || "them"} 😅`;
  } catch (err) {
    console.error("Error fetching opinion:", err);
    return "Hmm… couldn’t think of an opinion 😖";
  }
}

// --- Action GIFs ---
const actionGifs = { nom:["nom1.gif","nom2.gif"], hug:["hug1.gif","hug2.gif"], pat:["pat1.gif"], kiss:["kiss1.gif"], slap:["slap1.gif"] };
function getActionGif(action){ const gifs = actionGifs[action]; if(!gifs) return null; return gifs[Math.floor(Math.random()*gifs.length)]; }
function getActionMessage(action, actor, target){ const templates = {
  nom:[`${actor} noms on ${target} 🍴`,`${actor} bites ${target} playfully 😋`],
  hug:[`${actor} hugs ${target} 💖`,`${actor} wraps ${target} in a warm hug 🤗`],
  pat:[`${actor} pats ${target} 🥰`],
  kiss:[`${actor} kisses ${target} 😘`],
  slap:[`${actor} slaps ${target} 😳`]
}; const choices = templates[action] || [`${actor} interacts with ${target}.`]; return choices[Math.floor(Math.random()*choices.length)]; }

// --- Dedup helpers ---
async function hasBotRepliedToMessage(originalMsg) {
  try {
    const messages = await originalMsg.channel.messages.fetch({ limit: 50 });
    for (const m of messages.values()) {
      if (m.author?.id === client.user?.id) {
        const refId = m.reference?.messageId || (m.reference && m.reference.messageId);
        if (refId === originalMsg.id) return true;
      }
    }
  } catch (e) { console.error("hasBotRepliedToMessage error:", e); }
  return false;
}
async function sendOnce(originalMsg, replyOptions) {
  try {
    if (await hasBotRepliedToMessage(originalMsg)) return null;
    await new Promise(res=>setTimeout(res,250));
    if (await hasBotRepliedToMessage(originalMsg)) return null;
    return await originalMsg.reply(replyOptions);
  } catch (e) { console.error("sendOnce failed:", e); try { return await originalMsg.reply(replyOptions); } catch { return null; } }
}

// --- Discord Message Handler ---
client.on("messageCreate", async (msg)=>{
  if (!msg.author?.id || msg.author.bot) return;
  if (!msg.content.startsWith("!chat") && !msg.content.startsWith("!hi")) return;

  let userMsg = msg.content.replace(/!chat|!hi/i, "").trim();
  if (!userMsg) return await sendOnce(msg, { content: "Try saying `!chat Hey OCbot1!` 🙂" });

  const isCreator = msg.author.id === CREATOR_ID;
  if (isCreator) userMsg = "[CREATOR] " + userMsg;

  await msg.channel.sendTyping();
  trackUser(msg.author.id, msg.author.username, msg.content);

  // --- Action Commands ---
  const actionMatch = userMsg.match(/ocbot1\s+(\w+)\s+<@!?(\d+)>/i);
  if (actionMatch) {
    const action = actionMatch[1]?.toLowerCase();
    const targetId = actionMatch[2];
    let targetUser = null;
    try { targetUser = await msg.client.users.fetch(targetId); } catch {}
    if (targetUser) trackUser(targetUser.id, targetUser.username);

    const gifFile = getActionGif(action);
    const messageText = getActionMessage(action, msg.author.username, targetUser?.username || "someone");
    if (gifFile && fs.existsSync(`./${gifFile}`)) return await sendOnce(msg, { content: messageText, files: [new AttachmentBuilder(`./${gifFile}`)] });
    return await sendOnce(msg, { content: messageText });
  }

  // --- Player Opinion ---
  const mentioned = msg.mentions.users.first();
  if (mentioned && /think of|opinion|feel about/i.test(userMsg)) {
    const isCreatorMentioned = mentioned.id === CREATOR_ID;
    let targetUser = null;
    try { targetUser = await msg.client.users.fetch(mentioned.id); } catch {}
    if (targetUser) trackUser(targetUser.id, targetUser.username);
    const player = targetUser ? memory.players[String(targetUser.id)] : null;
    if (!player) return await sendOnce(msg, { content: "I don’t know that player yet 😅" });
    const opinion = await askOpinion("OCbot1", player, isCreatorMentioned);
    return await sendOnce(msg, { content: opinion });
  }

  // --- Normal Chat ---
  const aiReply = await askAI(userMsg, isCreator).catch(()=> "Hmm… something went wrong 😖");
  const replyText = (aiReply.length > 1900) ? aiReply.slice(0,1900)+"..." : aiReply;
  const emotion = detectEmotion(replyText);
  const emotionFile = `./${emotion}.jpg`;
  if (fs.existsSync(emotionFile)) return await sendOnce(msg, { content: replyText, files: [new AttachmentBuilder(fs.readFileSync(emotionFile), { name: `${emotion}.jpg` })] });
  return await sendOnce(msg, { content: replyText });
});

// --- Ready Event ---
client.once("ready", ()=> console.log(`✅ OCbot1 is online as ${client.user?.tag} (pid=${process.pid})`));

// --- Dummy Web Server for Render ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req,res)=>res.send("OCbot1 is running!"));
app.listen(PORT, ()=>console.log(`🌐 Web server active on port ${PORT}`));

// --- Start Bot ---
client.login(process.env.DISCORD_TOKEN).catch(err=>console.error("Failed to login:", err));
