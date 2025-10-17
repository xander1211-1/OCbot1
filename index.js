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

// Ensure proper structure
if (!memory || typeof memory !== "object") memory = { messages: [], players: {} };
if (!Array.isArray(memory.messages)) memory.messages = [];
if (!memory.players || typeof memory.players !== "object") memory.players = {};

function saveMemory() {
  try {
    if (!memory || typeof memory !== "object") memory = { messages: [], players: {} };
    if (!Array.isArray(memory.messages)) memory.messages = [];
    if (!memory.players || typeof memory.players !== "object") memory.players = {};
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
  const t = text.toLowerCase();
  if (t.match(/\b(happy|yay|love|good|excited|cute|sweet)\b/)) return "happy";
  if (t.match(/\b(sad|cry|unhappy|lonely|sorry|bad|tear)\b/)) return "sad";
  if (t.match(/\b(angry|mad|furious|annoy|rage|hate)\b/)) return "angry";
  return "neutral";
}

// --- AI Chat ---
async function askAI(userMsg) {
  const messages = [{ role: "system", content: "You are OCbot1, a gyaru tomboy anime girl. Playful, teasing, confident, SFW." }];
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
async function askOpinion(botName, player) {
  const history = player.messages.join("\n") || "No past messages yet.";
  const prompt = `
You are ${botName}, a gyaru tomboy anime girl.
Someone asked what you think of ${player.name}.
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
    return data?.choices?.[0]?.message?.content || `Hmm… I don’t know much about ${player.name} 😅`;
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

// --- Message Deduplication ---
const repliedMessages = new Set();

// --- Discord Message Handler ---
client.on("messageCreate", async msg=>{
  if(!msg.author?.id || msg.author.bot) return;
  if(repliedMessages.has(msg.id)) return; // Already replied
  repliedMessages.add(msg.id); // Mark message as handled

  if(!msg.content.startsWith("!chat") && !msg.content.startsWith("!hi")) return;

  const userMsg = msg.content.replace(/!chat|!hi/i,"").trim();
  if(!userMsg) return msg.reply("Try saying `!chat Hey OCbot1!` 🙂");

  await msg.channel.sendTyping();
  trackUser(msg.author.id, msg.author.username, msg.content);

  // --- Action Commands ---
  const actionMatch = userMsg.match(/ocbot1\s+(\w+)\s+<@!?(\d+)>/i);
  if(actionMatch){
    const action = actionMatch[1]?.toLowerCase();
    const targetId = actionMatch[2];
    let targetUser;
    try { targetUser = await msg.client.users.fetch(targetId); } catch { targetUser = null; }
    if(targetUser) trackUser(targetUser.id, targetUser.username);

    const gifFile = getActionGif(action);
    const messageText = getActionMessage(action, msg.author.username, targetUser?.username||"someone");
    if(gifFile && fs.existsSync(`./${gifFile}`)){
      return msg.reply({content:messageText, files:[new AttachmentBuilder(`./${gifFile}`)]});
    } 
    return msg.reply(messageText);
  }

  // --- Player Opinion ---
  const mentioned = msg.mentions.users.first();
  if(mentioned && /think of|opinion|feel about/i.test(userMsg)){
    let targetUser;
    try { targetUser = await msg.client.users.fetch(mentioned.id); } catch { targetUser = null; }
    if(targetUser) trackUser(targetUser.id, targetUser.username);
    const player = targetUser ? memory.players[String(targetUser.id)] : null;
    if(!player) return msg.reply("I don’t know that player yet 😅");
    const opinion = await askOpinion("OCbot1", player);
    return msg.reply(opinion);
  }

  // --- Normal Chat ---
  let aiReply = await askAI(userMsg);
  if(aiReply.length>1900) aiReply = aiReply.slice(0,1900)+"...";

  const emotion = detectEmotion(aiReply);
  const emotionFile = `./${emotion}.jpg`;
  try{
    const file = fs.readFileSync(emotionFile);
    return msg.reply({content:aiReply, files:[new AttachmentBuilder(file,{name:`${emotion}.jpg`})]});
  }catch{
    return msg.reply(aiReply);
  }
});

// --- Ready Event ---
client.once("ready",()=>console.log(`✅ OCbot1 is online as ${client.user?.tag}`));

// --- Dummy Web Server for Render ---
const app = express();
const PORT=process.env.PORT||3000;
app.get("/",(req,res)=>res.send("OCbot1 is running!"));
app.listen(PORT,()=>console.log(`🌐 Web server active on port ${PORT}`));

// --- Start Bot ---
client.login(process.env.DISCORD_TOKEN).catch(err=>console.error("Failed to login:",err));
                         
