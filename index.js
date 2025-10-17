import fs from "fs";
import fetch from "node-fetch";
import express from "express";
import { Client, GatewayIntentBits, AttachmentBuilder } from "discord.js";

// --- Global Error Handlers ---
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// --- Discord Setup ---
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

if (!process.env.DISCORD_TOKEN) console.error("⚠️ DISCORD_TOKEN is missing!");
if (!OPENROUTER_KEY) console.error("⚠️ OPENROUTER_API_KEY is missing!");

// --- Load Memory ---
let memory = { messages: [], players: {} };
if (fs.existsSync(MEMORY_FILE)) {
  try { memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8")); } catch (err) {
    console.error("Failed to parse memory.json:", err);
  }
}
function saveMemory() {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2)); } catch (err) {
    console.error("Failed to save memory:", err);
  }
}

// --- Track Players ---
function trackPlayer(id, name, message = "") {
  if (!memory.players[id]) {
    memory.players[id] = {
      name,
      interactions: 0,
      messages: [],
    };
  }
  const p = memory.players[id];
  p.interactions++;
  if (message) p.messages.push(message);
  if (p.messages.length > 50) p.messages = p.messages.slice(-50);
  saveMemory();
}

// --- Detect Emotion ---
function detectEmotion(text) {
  const t = text.toLowerCase();
  if (t.match(/\b(happy|yay|love|good|excited|cute|sweet)\b/)) return "happy";
  if (t.match(/\b(sad|cry|unhappy|lonely|sorry|bad|tear)\b/)) return "sad";
  if (t.match(/\b(angry|mad|furious|annoy|rage|hate)\b/)) return "angry";
  return "neutral";
}

// --- Ask AI for Chat ---
async function askAI(userMsg) {
  const messages = [
    {
      role: "system",
      content: "You are OCbot1, a gyaru-style tomboy anime girl. Playful, teasing, confident, expressive, fun slang, emojis, affectionate humor, SFW.",
    },
  ];

  const recent = memory.messages.slice(-300);
  for (const m of recent) {
    messages.push({ role: "user", content: m.user });
    messages.push({ role: "assistant", content: m.bot });
  }
  messages.push({ role: "user", content: userMsg });

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, messages }),
    });

    const data = await res.json().catch(() => null);
    const reply = data?.choices?.[0]?.message?.content || "Uhh, my brain just blanked out 😅";

    memory.messages.push({ user: userMsg, bot: reply });
    if (memory.messages.length > 300) memory.messages = memory.messages.slice(-300);
    saveMemory();
    return reply;
  } catch (err) {
    console.error("Error fetching AI response:", err);
    return "Hmm… something went wrong while I was thinking 😖";
  }
}

// --- Ask AI for Opinion ---
async function askOpinionAboutPlayer(botName, player) {
  const history = player.messages.join("\n") || "No past messages yet.";
  const prompt = `
You are ${botName}, a gyaru-style tomboy anime girl.
Someone asked what you think of ${player.name}.
Form an opinion based on this chat history, be flirty, teasing, or sassy but stay SFW.
Keep it under 3 sentences.

Chat history:
${history}
`;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }] }),
    });

    const data = await res.json().catch(() => null);
    return data?.choices?.[0]?.message?.content || `Hmm… I dunno much about ${player.name} yet 😅`;
  } catch (err) {
    console.error("Error fetching opinion:", err);
    return "Hmm… I couldn’t think of an opinion 😖";
  }
}

// --- Action GIFs ---
const actionGifs = {
  nom: ["nom1.gif","nom2.gif","nom3.gif"],
  hug: ["hug1.gif","hug2.gif","hug3.gif"],
  pat: ["pat1.gif","pat2.gif"],
  kiss: ["kiss1.gif","kiss2.gif"],
  slap: ["slap1.gif","slap2.gif"],
};
function getActionGif(action){const gifs=actionGifs[action];if(!gifs)return null;return gifs[Math.floor(Math.random()*gifs.length)];}
function getActionMessage(action,actor,target){const templates={nom:[`${actor} noms on ${target} playfully 🍴`,`${
actor} takes a lil bite of ${target} 😋`,`${
actor} can’t resist and noms ${target}~ ❤️`],hug:[`${actor} hugs ${target} tightly 💖`,`${
actor} wraps ${target} in a warm hug 🤗`,`${
actor} gives ${target} a big ol’ squeeze 💞`],pat:[`${actor} pats ${target}'s head gently 🥰`,`${
actor} ruffles ${target}'s hair 💫`,`${
actor} gives ${target} a soft pat~ ✨`],kiss:[`${actor} plants a quick kiss on ${target} 💋`,`${
actor} kisses ${target} sweetly 😘`,`${
actor} sneaks a kiss from ${target} 💞`],slap:[`${actor} slaps ${target}! 😳`,`${
actor} smacks ${target} lightly 💥`,`${
actor} gives ${target} a dramatic anime slap 😤`]};const choices=templates[action]||[`${actor} interacts with ${target}.`];return choices[Math.floor(Math.random()*choices.length)];}

// --- Discord Message Handler ---
client.on("messageCreate", async (msg)=>{
  if(msg.author.bot) return;
  if(!msg.content.startsWith("!chat")) return;

  const userMsg = msg.content.replace("!chat","").trim();
  if(!userMsg) return msg.reply("Try saying `!chat Hey OCbot1!` 🙂");

  await msg.channel.sendTyping();
  trackPlayer(msg.author.id,msg.author.username,msg.content);

  // --- Action Commands ---
  const actionMatch = userMsg.match(/ocbot1\s+(\w+)\s+<@!?(\d+)>/i);
  if(actionMatch){
    const action=actionMatch[1].toLowerCase();
    const targetId=actionMatch[2];
    const gifFile=getActionGif(action);

    const actorName=msg.author.username;
    const targetUser=await msg.client.users.fetch(targetId);
    const targetName=targetUser.username;

    const messageText=getActionMessage(action,actorName,targetName);

    if(gifFile && fs.existsSync(`./${gifFile}`)){
      const attachment=new AttachmentBuilder(`./${gifFile}`);
      return msg.reply({content:messageText,files:[attachment]});
    }else{
      return msg.reply(messageText);
    }
  }

  // --- Player Opinion ---
  const mentioned=msg.mentions.users.first();
  if(mentioned && /think of|opinion|feel about/i.test(userMsg)){
    trackPlayer(mentioned.id,mentioned.username);
    const player=memory.players[mentioned.id];
    const opinion=await askOpinionAboutPlayer("OCbot1",player);
    return msg.reply(opinion);
  }

  // --- Normal Chat ---
  let aiReply=await askAI(userMsg);
  if(aiReply.length>1900) aiReply=aiReply.slice(0,1900)+"...";

  const emotion=detectEmotion(aiReply);
  const emotionFile=`./${emotion}.jpg`;

  try{
    const file=fs.readFileSync(emotionFile);
    const attachment=new AttachmentBuilder(file,{name:`${emotion}.jpg`});
    await msg.reply({content:aiReply,files:[attachment]});
  }catch{
    await msg.reply(aiReply);
  }
});

// --- Ready Event ---
client.once("ready",()=>console.log(`✅ OCbot1 is online as ${client.user?.tag}`));

// --- Dummy Web Server for Render ---
const app=express();
const PORT=process.env.PORT||3000;
app.get("/",(req,res)=>res.send("OCbot1 is running and connected to Discord!"));
app.listen(PORT,()=>console.log(`🌐 Web server active on port ${PORT}`));

// --- Start Bot ---
client.login(process.env.DISCORD_TOKEN).catch(err=>{
  console.error("Failed to login to Discord:",err);
});
      
