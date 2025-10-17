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

const MEMORY_FILE = "./memory.json";
const KEYS_FILE = "./keys.json";
const ACTIONS_FOLDER = "./actions";
const EMOTIONS_FOLDER = "./emotions";
const DAILY_LIMIT = 50;

// === Load memory and keys ===
let memory = { messages: [], players: {}, appearance: {} };
let userKeys = {};
try {
  if (fs.existsSync(MEMORY_FILE)) memory = JSON.parse(fs.readFileSync(MEMORY_FILE));
  if (fs.existsSync(KEYS_FILE)) userKeys = JSON.parse(fs.readFileSync(KEYS_FILE));
} catch (err) {
  console.error("Error reading files:", err);
}

// === Save helpers ===
const saveMemory = () => fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
const saveKeys = () => fs.writeFileSync(KEYS_FILE, JSON.stringify(userKeys, null, 2));

// === Reset daily usage ===
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

// === Small cache to prevent double replies ===
const recentMessages = new Set();
function addRecent(id) {
  recentMessages.add(id);
  setTimeout(() => recentMessages.delete(id), 15000); // 15s cache
}

// === Random file helper ===
function randomFile(folderPath, type = ".gif") {
  try {
    const files = fs.readdirSync(folderPath).filter(f => f.endsWith(type));
    if (!files || files.length === 0) return null;
    return `${folderPath}/${files[Math.floor(Math.random() * files.length)]}`;
  } catch {
    return null;
  }
}

// === AI response ===
async function getAIResponse(message, userKey, username) {
  try {
    const body = {
      model: "tngtech/deepseek-r1t2-chimera:free",
      messages: [
        {
          role: "system",
          content:
            "You are OCbot1, a tomboyish gyaru anime girl with short blonde hair, pink eyes, tanned skin, and a black hoodie. You are teasing but caring, with a playful tone. Speak casually, like a tomboy friend.",
        },
        ...memory.messages.slice(-20),
        { role: "user", content: `${username}: ${message}` },
      ],
    };

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error("OpenRouter API error:", res.status);
      return "Hmm… something went wrong 😖";
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) return "Hmm… something went wrong 😖";

    memory.messages.push({ role: "assistant", content: reply });
    if (memory.messages.length > 300) memory.messages = memory.messages.slice(-300);
    saveMemory();
    return reply;
  } catch (error) {
    console.error("AI error:", error);
    return "Uhh... my brain blanked out.";
  }
}

// === Command handler ===
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot || !msg.content) return;
    if (recentMessages.has(msg.id)) return;
    addRecent(msg.id);

    const content = msg.content.trim();
    const userId = msg.author.id;
    const lc = content.toLowerCase();

    // --- KEY COMMANDS ---
    if (lc.startsWith("!key ")) {
      const parts = content.split(/\s+/);
      const key = parts[1];
      if (!key || !key.startsWith("sk-")) {
        return msg.reply("❌ Invalid key format. Must start with `sk-`.");
      }
      userKeys[userId] = { apiKey: key, messagesUsed: 0, lastReset: new Date().toDateString() };
      saveKeys();
      return msg.reply("✅ Key saved! You can now use `!chat <message>` to talk to me.");
    }

    if (lc === "!delkey") {
      if (userKeys[userId]) {
        delete userKeys[userId];
        saveKeys();
        return msg.reply("🗝️ Your key has been deleted.");
      }
      return msg.reply("You don’t have a saved key.");
    }

    if (lc === "!info") {
      const k = userKeys[userId];
      if (!k) return msg.reply("🔑 Use `!key <yourkey>` first.");
      const used = k.messagesUsed || 0;
      const remaining = Math.max(DAILY_LIMIT - used, 0);
      return msg.reply(`💬 You've used **${used}** messages today. You have **${remaining}** left.`);
    }

    if (lc === "!commands") {
      return msg.reply(
        "**OCbot1 Commands**\n" +
          "`!chat <message>` — Talk to OCbot1\n" +
          "`!key <key>` — Register your OpenRouter key\n" +
          "`!info` — Shows used & remaining messages\n" +
          "`!delkey` — Delete your key\n" +
          "`!bonk @user` / `!kiss @user` — Actions\n" +
          "`!memory` — Memory stats"
      );
    }

    if (lc === "!memory") {
      return msg.reply(
        `🧠 Memory size: ${memory.messages.length} messages. Tracked players: ${Object.keys(memory.players).length}`
      );
    }

    // --- ACTION COMMANDS ---
    if (lc.startsWith("!bonk") || lc.startsWith("!kiss")) {
      const mentioned = msg.mentions.users.first();
      const actionType = lc.startsWith("!bonk") ? "bonk" : "kiss";
      const gifFile = randomFile(ACTIONS_FOLDER, ".gif");
      const replyText = mentioned
        ? `*${msg.author.username} ${actionType}s ${mentioned.username}!*`
        : `*${msg.author.username} ${actionType}s the air!*`;

      if (gifFile) {
        await msg.channel.send({ content: replyText, files: [gifFile] });
      } else {
        await msg.reply(`${replyText} (No GIF found.)`);
      }
      return;
    }

    // --- CHAT COMMAND ---
    if (lc.startsWith("!chat") || lc.startsWith("!hi")) {
      const userKeyData = userKeys[userId];
      if (!userKeyData) {
        return msg.reply("🔑 Please register your key first with `!key <yourkey>`.");
      }

      const today = new Date().toDateString();
      if (userKeyData.lastReset !== today) {
        userKeyData.messagesUsed = 0;
        userKeyData.lastReset = today;
      }

      if ((userKeyData.messagesUsed || 0) >= DAILY_LIMIT) {
        return msg.reply(`🚫 You've hit the ${DAILY_LIMIT} message limit for today.`);
      }

      const userMessage = content.replace(/^!chat\s*/i, "").replace(/^!hi\s*/i, "").trim();
      if (!userMessage) return msg.reply("What do you want to say?");

      await msg.channel.sendTyping();
      const aiReply = await getAIResponse(userMessage, userKeyData.apiKey, msg.author.username);
      await msg.reply(aiReply);

      userKeyData.messagesUsed = (userKeyData.messagesUsed || 0) + 1;
      saveKeys();
    }
  } catch (err) {
    console.error("Handler error:", err);
  }
});

// === Ready Event ===
client.once("ready", () => {
  console.log(`✅ OCbot1 is online as ${client.user.tag}`);
});

// === Dummy Express Server ===
const app = express();
app.get("/", (req, res) => res.send("OCbot1 is alive!"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 Listening on port ${PORT}`));

client.login(process.env.TOKEN).catch(e => console.error("Login failed:", e));
    
