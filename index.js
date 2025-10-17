import { Client, GatewayIntentBits } from "discord.js";
import fetch from "node-fetch";
import fs from "fs";

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

// === Memory / Keys ===
let memory = { messages: [], players: {}, appearance: {} };
try {
  if (fs.existsSync(MEMORY_FILE)) {
    memory = JSON.parse(fs.readFileSync(MEMORY_FILE));
  }
} catch (err) {
  console.error("Error reading memory.json:", err);
}

let userKeys = {};
try {
  if (fs.existsSync(KEYS_FILE)) {
    userKeys = JSON.parse(fs.readFileSync(KEYS_FILE));
  }
} catch (err) {
  console.error("Error reading keys.json:", err);
}

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}
function saveKeys() {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(userKeys, null, 2));
}

// === Reset daily message counts ===
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

// === Helper ===
function randomFile(folderPath, type = ".gif") {
  try {
    const files = fs.readdirSync(folderPath).filter((f) => f.endsWith(type));
    if (files.length === 0) return null;
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

    const data = await res.json();

    if (!data.choices || !data.choices[0]?.message?.content)
      return "Uhh... something went wrong.";

    const aiMessage = data.choices[0].message.content;
    memory.messages.push({ role: "assistant", content: aiMessage });
    saveMemory();

    return aiMessage;
  } catch (error) {
    console.error("AI error:", error);
    return "Uhh... my brain blanked out.";
  }
}

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.trim();
  const userId = msg.author.id;

  // === !key ===
  if (content.startsWith("!key ")) {
    const key = content.split(" ")[1];
    if (!key.startsWith("sk-")) {
      msg.reply("❌ Invalid key format. Please provide a valid OpenRouter key.");
      return;
    }
    userKeys[userId] = {
      apiKey: key,
      messagesUsed: 0,
      lastReset: new Date().toDateString(),
    };
    saveKeys();
    msg.reply("✅ Your OpenRouter key has been securely saved!");
    return;
  }

  // === !info ===
  if (content === "!info") {
    if (!userKeys[userId]) {
      msg.reply("🔑 You don’t have a key set! Use `!key <yourkey>` first.");
      return;
    }
    const used = userKeys[userId].messagesUsed || 0;
    const remaining = Math.max(DAILY_LIMIT - used, 0);
    msg.reply(
      `💬 You’ve sent **${used}** messages today.\n📆 You have **${remaining}** messages left before your daily limit resets.`
    );
    return;
  }

  // === !keyhelp ===
  if (content === "!keyhelp") {
    msg.reply(
      "**🔑 How to get your OpenRouter key:**\n\n" +
        "1️⃣ Go to [https://openrouter.ai/keys](https://openrouter.ai/keys)\n" +
        "2️⃣ Log in with Google or Discord.\n" +
        "3️⃣ Click **'New Key'**, give it a name (like 'OCbot1').\n" +
        "4️⃣ Copy the key (starts with `sk-`).\n" +
        "5️⃣ Use it here: `!key sk-yourkeyhere`\n\n" +
        "After that, you can chat with the bot using `!chat <message>` 🎉"
    );
    return;
  }

  // === !delkey ===
  if (content === "!delkey") {
    if (userKeys[userId]) {
      delete userKeys[userId];
      saveKeys();
      msg.reply("🗝️ Your key has been deleted.");
    } else {
      msg.reply("You don’t have a saved key.");
    }
    return;
  }

  // === !commands ===
  if (content === "!commands") {
    msg.reply(
      "**OCbot1 Commands**\n\n" +
        "`!chat <message>` — Talk with OCbot1\n" +
        "`!key <key>` — Register your OpenRouter key\n" +
        "`!info` — Check message usage\n" +
        "`!keyhelp` — How to get your API key\n" +
        "`!delkey` — Delete your saved key\n" +
        "`!bonk @user` — Bonk someone\n" +
        "`!kiss @user` — Kiss someone\n" +
        "`!memory` — View bot memory info"
    );
    return;
  }

  // === !memory ===
  if (content === "!memory") {
    msg.reply(
      `🧠 Memory size: ${memory.messages.length} messages.\nTracked players: ${Object.keys(memory.players).length}`
    );
    return;
  }

  // === !bonk / !kiss ===
  if (content.startsWith("!bonk") || content.startsWith("!kiss")) {
    const mentioned = msg.mentions.users.first();
    const actionType = content.startsWith("!bonk") ? "bonk" : "kiss";
    const gifFile = randomFile(ACTIONS_FOLDER, ".gif");

    const replyText = mentioned
      ? `*${msg.author.username} ${actionType}s ${mentioned.username}!*`
      : `*${msg.author.username} ${actionType}s the air!*`;

    if (gifFile) {
      await msg.channel.send({ content: replyText, files: [gifFile] });
    } else {
      msg.reply(`${replyText} (No GIF found.)`);
    }
    return;
  }

  // === !chat ===
  if (content.startsWith("!chat")) {
    const userKeyData = userKeys[userId];
    if (!userKeyData) {
      msg.reply("🔑 Please register your OpenRouter key first with `!key <yourkey>`.");
      return;
    }

    const today = new Date().toDateString();
    if (userKeyData.lastReset !== today) {
      userKeyData.messagesUsed = 0;
      userKeyData.lastReset = today;
    }

    if (userKeyData.messagesUsed >= DAILY_LIMIT) {
      msg.reply("🚫 You’ve reached your daily limit of 50 messages. Try again tomorrow!");
      return;
    }

    const userMessage = content.slice(6).trim();
    if (!userMessage) {
      msg.reply("What did you want to say?");
      return;
    }

    msg.channel.sendTyping();
    const response = await getAIResponse(userMessage, userKeyData.apiKey, msg.author.username);

    await msg.reply(response);
    userKeyData.messagesUsed++;
    saveKeys();
    return;
  }
});

client.once("ready", () => {
  console.log(`✅ OCbot1 is online as ${client.user.tag}`);
});
client.login(process.env.TOKEN);
    
