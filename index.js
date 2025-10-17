import { Client, GatewayIntentBits } from "discord.js";
import fetch from "node-fetch";
import fs from "fs";
import express from "express";

// === BOT CONFIG ===
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

// === Load memory ===
let memory = { messages: [], players: {}, appearance: {} };
try {
  if (fs.existsSync(MEMORY_FILE)) memory = JSON.parse(fs.readFileSync(MEMORY_FILE));
} catch (err) {
  console.error("Error reading memory.json:", err);
}

// === Load keys ===
let userKeys = {};
try {
  if (fs.existsSync(KEYS_FILE)) userKeys = JSON.parse(fs.readFileSync(KEYS_FILE));
} catch (err) {
  console.error("Error reading keys.json:", err);
}

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}
function saveKeys() {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(userKeys, null, 2));
}

// === Daily reset ===
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
setInterval(resetDailyCounts, 60 * 60 * 1000); // hourly

// === Helpers ===
function randomFile(folderPath, type = ".gif") {
  try {
    const files = fs.readdirSync(folderPath).filter((f) => f.endsWith(type));
    if (!files || files.length === 0) return null;
    return `${folderPath}/${files[Math.floor(Math.random() * files.length)]}`;
  } catch {
    return null;
  }
}

async function getAIResponse(message, userKey, username) {
  try {
    const body = {
      model: "tngtech/deepseek-r1t2-chimera:free",
      messages: [
        {
          role: "system",
          content:
            "You are OCbot1, a tomboyish gyaru anime girl with short blonde hair, pink eyes, tanned skin, and a black hoodie. You’re confident, teasing, and loyal to your creator Xander.",
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
      const txt = await res.text().catch(() => "");
      console.error("OpenRouter API error:", res.status, txt);
      return "Hmm… something went wrong 😖";
    }

    const data = await res.json().catch(() => null);
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) {
      console.error("OpenRouter returned no content:", data);
      return "Hmm… something went wrong 😖";
    }

    memory.messages.push({ role: "assistant", content: reply });
    if (memory.messages.length > 300) memory.messages = memory.messages.slice(-300);
    saveMemory();
    return reply;
  } catch (error) {
    console.error("askAI error:", error);
    return "Uhh... my brain blanked out.";
  }
}

// === Core commands / flow ===
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot || !msg.content) return;
    const content = msg.content.trim();
    const userId = msg.author.id;
    const lc = content.toLowerCase();

    // 1) !key
    if (lc.startsWith("!key ")) {
      const parts = content.split(/\s+/);
      const key = parts[1];
      if (!key || !key.startsWith("sk-")) {
        await msg.reply("❌ Invalid key format. Please provide a valid OpenRouter key (starts with `sk-`).");
        return;
      }
      userKeys[userId] = { apiKey: key, messagesUsed: 0, lastReset: new Date().toDateString() };
      saveKeys();
      await msg.reply("✅ Your OpenRouter key has been securely saved!");
      return;
    }

    // 2) !info
    if (lc === "!info") {
      const k = userKeys[userId];
      if (!k) {
        await msg.reply("🔑 You don’t have a key set! Use `!key <yourkey>` first. See `!keyhelp` for steps.");
        return;
      }
      const used = k.messagesUsed || 0;
      const remaining = Math.max(DAILY_LIMIT - used, 0);
      await msg.reply(`💬 You've used **${used}** messages today. You have **${remaining}** messages left today.`);
      return;
    }

    // 3) !keyhelp
    if (lc === "!keyhelp") {
      await msg.reply(
        "**🔑 How to get an OpenRouter API key:**\n\n" +
          "1. Go to https://openrouter.ai/keys\n" +
          "2. Log in (Google/Discord). 3. Create a new key (name it e.g. 'OCbot1').\n" +
          "4. Copy the key (starts with `sk-`) and paste it here: `!key sk-...`\n\n" +
          "After that, use `!chat <message>` to talk."
      );
      return;
    }

    // 4) !delkey
    if (lc === "!delkey") {
      if (userKeys[userId]) {
        delete userKeys[userId];
        saveKeys();
        await msg.reply("🗝️ Your key has been deleted.");
      } else {
        await msg.reply("You don't have a saved key.");
      }
      return;
    }

    // 5) !commands
    if (lc === "!commands") {
      await msg.reply(
        "**OCbot1 Commands**\n" +
          "`!chat <message>` — Talk with OCbot1\n" +
          "`!key <key>` — Register your OpenRouter key\n" +
          "`!info` — Shows used & remaining messages today\n" +
          "`!keyhelp` — How to get your API key\n" +
          "`!delkey` — Delete your saved key\n" +
          "`!bonk @user` / `!kiss @user` — Actions\n" +
          "`!memory` — Bot memory stats"
      );
      return;
    }

    // 6) !memory
    if (lc === "!memory") {
      await msg.reply(`🧠 Memory size: ${memory.messages.length} messages. Tracked players: ${Object.keys(memory.players).length}`);
      return;
    }

    // 7) Actions: !bonk / !kiss
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

    // 8) !chat
    if (lc.startsWith("!chat") || lc.startsWith("!hi")) {
      const userKeyData = userKeys[userId];
      if (!userKeyData) {
        await msg.reply("🔑 Please register your OpenRouter key first with `!key <yourkey>`. Use `!keyhelp` for steps.");
        return;
      }

      const today = new Date().toDateString();
      if (userKeyData.lastReset !== today) {
        userKeyData.messagesUsed = 0;
        userKeyData.lastReset = today;
      }

      if ((userKeyData.messagesUsed || 0) >= DAILY_LIMIT) {
        await msg.reply(`🚫 You've reached the daily limit of ${DAILY_LIMIT} messages. Try again tomorrow!`);
        return;
      }

      const userMessage = content.replace(/^!chat\s*/i, "").replace(/^!hi\s*/i, "").trim();
      if (!userMessage) {
        await msg.reply("What did you want to say?");
        return;
      }

      // Check first if someone (another instance) already replied (quick guard)
      // We use channel messages fetch to look for replies referencing this message id.
      try {
        const recent = await msg.channel.messages.fetch({ limit: 30 });
        for (const m of recent.values()) {
          if (m.author?.id === client.user?.id && m.reference?.messageId === msg.id) {
            // another reply exists; abort to avoid duplicate
            return;
          }
        }
      } catch (e) {
        // ignore fetch errors, continue
      }

      await msg.channel.sendTyping();
      const aiReply = await getAIResponse(userMessage, userKeyData.apiKey, msg.author.username);

      // send reply and increment usage
      await msg.reply(aiReply);
      userKeyData.messagesUsed = (userKeyData.messagesUsed || 0) + 1;
      saveKeys();
      return;
    }

    // ignore any other messages
  } catch (err) {
    console.error("messageCreate handler error:", err);
  }
});

// === Ready ===
client.once("ready", () => {
  console.log(`✅ OCbot1 is online as ${client.user.tag}`);
});

// === Express dummy server for Render ===
const app = express();
app.get("/", (req, res) => res.send("OCbot1 is running."));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 Express listening on port ${PORT}`));

// === Login ===
client.login(process.env.TOKEN).catch((e) => console.error("Login failed:", e));
        
