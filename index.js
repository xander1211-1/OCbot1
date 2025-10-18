import { Client, GatewayIntentBits } from "discord.js";
import fetch from "node-fetch";
import fs from "fs";
import express from "express";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// === Constants ===
const MEMORY_FILE = "./memory.json";
const KEYS_FILE = "./keys.json";
const ACTIONS_FOLDER = "./actions";
const DAILY_LIMIT = 50;
const PORT = process.env.PORT || 10000;

// === Ensure Files Exist ===
if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, JSON.stringify({ messages: [] }, null, 2));
if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, JSON.stringify({}, null, 2));

// === Load Files ===
let memory = JSON.parse(fs.readFileSync(MEMORY_FILE));
let userKeys = JSON.parse(fs.readFileSync(KEYS_FILE));

// === Save Helpers ===
const saveMemory = () => fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
const saveKeys = () => fs.writeFileSync(KEYS_FILE, JSON.stringify(userKeys, null, 2));

// === Reset Daily Limits ===
function resetDailyCounts() {
  const today = new Date().toDateString();
  let changed = false;
  for (const userId in userKeys) {
    if (userKeys[userId].lastReset !== today) {
      userKeys[userId].messagesUsed = 0;
      userKeys[userId].lastReset = today;
      changed = true;
    }
  }
  if (changed) saveKeys();
}
setInterval(resetDailyCounts, 60 * 60 * 1000);

// === Anti-Duplicate Protection ===
let listenerAttached = false;
const processingMessages = new Set();

// === Helper: pick random gif ===
function randomFile(folder) {
  try {
    const files = fs.readdirSync(folder).filter(f => f.endsWith(".gif"));
    if (files.length === 0) return null;
    return `${folder}/${files[Math.floor(Math.random() * files.length)]}`;
  } catch {
    return null;
  }
}

// === AI Reply ===
async function getAIResponse(msg, key, username) {
  try {
    const payload = {
      model: "tngtech/deepseek-r1t2-chimera:free",
      messages: [
        {
          role: "system",
          content:
            "You are OCbot1, a tomboyish gyaru with short blonde hair, pink eyes, tanned skin, and an oversized black hoodie. Speak casually, tease lightly, and act like a cool tomboy friend.",
        },
        ...memory.messages.slice(-20),
        { role: "user", content: `${username}: ${msg}` },
      ],
    };

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error("API error:", res.status);
      return "Hmm... something went wrong.";
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content || "Uhh... my brain blanked out.";
    memory.messages.push({ role: "assistant", content: reply });
    if (memory.messages.length > 300) memory.messages = memory.messages.slice(-300);
    saveMemory();
    return reply;
  } catch (err) {
    console.error("AI Error:", err);
    return "Uhh... my brain blanked out.";
  }
}

// === COMMAND HANDLER ===
function attachListenerOnce() {
  if (listenerAttached) return; // Prevent duplicate listener
  listenerAttached = true;

  client.on("messageCreate", async (msg) => {
    try {
      if (msg.author.bot || !msg.content) return;
      const userId = msg.author.id;
      const content = msg.content.trim();
      const lc = content.toLowerCase();

      // === prevent re-entry ===
      if (processingMessages.has(msg.id)) return;
      processingMessages.add(msg.id);
      setTimeout(() => processingMessages.delete(msg.id), 10000);

      // === !key command ===
      if (lc.startsWith("!key ")) {
        const key = content.split(/\s+/)[1];
        if (!key?.startsWith("sk-")) return msg.reply("❌ Invalid key format.");
        userKeys[userId] = { apiKey: key, messagesUsed: 0, lastReset: new Date().toDateString() };
        saveKeys();
        return msg.reply("✅ Your key was saved!");
      }

      // === !info ===
      if (lc === "!info") {
        const k = userKeys[userId];
        if (!k) return msg.reply("🔑 You haven’t added a key yet. Use `!key <yourkey>` first.");
        const used = k.messagesUsed || 0;
        const left = Math.max(DAILY_LIMIT - used, 0);
        return msg.reply(`💬 You've used **${used}** messages today. You have **${left}** left.`);
      }

      // === !commands ===
      if (lc === "!commands") {
        return msg.reply(
          "**OCbot1 Commands:**\n" +
            "`!key <key>` — Add your OpenRouter key\n" +
            "`!info` — Check your usage\n" +
            "`!chat <message>` — Talk to OCbot1\n" +
            "`!bonk @user` / `!kiss @user` — Fun actions"
        );
      }

      // === !bonk or !kiss ===
      if (lc.startsWith("!bonk") || lc.startsWith("!kiss")) {
        const type = lc.startsWith("!bonk") ? "bonk" : "kiss";
        const gif = randomFile(ACTIONS_FOLDER);
        const mentioned = msg.mentions.users.first();
        const replyText = mentioned
          ? `*${msg.author.username} ${type}s ${mentioned.username}!*`
          : `*${msg.author.username} ${type}s the air!*`;
        return gif
          ? msg.channel.send({ content: replyText, files: [gif] })
          : msg.reply(`${replyText} (No GIF found.)`);
      }

      // === !chat ===
      if (lc.startsWith("!chat")) {
        const k = userKeys[userId];
        if (!k) return msg.reply("🔑 Please register your key first with `!key <yourkey>`.");

        const today = new Date().toDateString();
        if (k.lastReset !== today) {
          k.messagesUsed = 0;
          k.lastReset = today;
        }

        if (k.messagesUsed >= DAILY_LIMIT)
          return msg.reply(`🚫 You’ve hit your ${DAILY_LIMIT} message limit for today.`);

        const text = content.replace(/^!chat\s*/i, "").trim();
        if (!text) return msg.reply("What do you want to say?");
        await msg.channel.sendTyping();

        const reply = await getAIResponse(text, k.apiKey, msg.author.username);
        await msg.reply(reply);

        k.messagesUsed++;
        saveKeys();
      }
    } catch (err) {
      console.error("Handler error:", err);
    }
  });
}

attachListenerOnce();

client.once("ready", () => {
  console.log(`✅ OCbot1 is online as ${client.user.tag}`);
});

// === Dummy Express Server (for Render) ===
const app = express();
app.get("/", (req, res) => res.send("OCbot1 is alive!"));
app.listen(PORT, () => console.log(`🌐 Listening on port ${PORT}`));

client.login(process.env.TOKEN);
      
