import fs from "fs";
import fetch from "node-fetch";
import { Client, GatewayIntentBits, AttachmentBuilder } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = "tngtech/deepseek-r1t2-chimera:free"; // change if you prefer another OpenRouter-hosted model

// Shared memory file (server-wide)
const MEMORY_FILE = "./memory.json";

// ensure memory file exists
if (!fs.existsSync(MEMORY_FILE)) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify({ messages: [] }, null, 2));
}

function loadMemory() {
  try {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return { messages: [] };
  }
}

function saveMemory(mem) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2));
  } catch (e) {
    console.error("Failed to save memory:", e);
  }
}

function detectEmotion(text) {
  const t = text.toLowerCase();
  if (t.match(/\b(happy|joy|yay|love|good|excited|great|cute)\b/)) return "happy";
  if (t.match(/\b(sad|cry|unhappy|lonely|sorry|bad|tear)\b/)) return "sad";
  if (t.match(/\b(angry|mad|furious|annoy|rage|hate)\b/)) return "angry";
  return "neutral";
}

async function askAI(userMsg) {
  const mem = loadMemory();
  // create messages array for OpenRouter chat completion
  const messages = [
    { role: "system", content: "You are OCbot1, a gyaru-style tomboy anime girl. You are playful, teasing, casual, and friendly. Speak like a close friend — use light slang and playful teasing, but stay SFW. Keep replies concise and expressive." },
  ];

  // add recent shared memory (max 10 exchanges)
  const recent = mem.messages.slice(-10);
  for (const m of recent) {
    messages.push({ role: "user", content: m.user });
    messages.push({ role: "assistant", content: m.bot });
  }
  messages.push({ role: "user", content: userMsg });

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, messages }),
  });

  const data = await res.json().catch(() => null);
  const reply = data?.choices?.[0]?.message?.content || "Uhh... I couldn't think of a reply just now!";

  // update shared memory
  mem.messages = [...mem.messages, { user: userMsg, bot: reply }].slice(-50); // keep up to 50 turns
  saveMemory(mem);

  return reply;
}

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith("!chat")) return;

  const userMsg = msg.content.replace("!chat", "").trim();
  if (!userMsg) return msg.reply("Try saying `!chat Hi OCbot1!` 🙂");

  await msg.channel.sendTyping();

  let aiReply = await askAI(userMsg);
  // trim long replies
  if (aiReply.length > 1900) aiReply = aiReply.slice(0, 1900) + "...";

  const emotion = detectEmotion(aiReply);
  const path = `./images/${emotion}.png`;

  try {
    const file = fs.readFileSync(path);
    const attachment = new AttachmentBuilder(file, { name: `${emotion}.png` });
    await msg.reply({ content: aiReply, files: [attachment] });
  } catch (e) {
    console.error("Image send failed:", e);
    await msg.reply(aiReply);
  }
});

client.once("ready", () => console.log(`OCbot1 is online as ${client.user?.tag || "[unknown]"}`));
client.login(process.env.DISCORD_TOKEN);

import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("OCbot1 is online and running!"));

app.listen(PORT, () => console.log(`✅ Dummy server running on port ${PORT}`));
