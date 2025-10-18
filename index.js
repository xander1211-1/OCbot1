import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import express from "express";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("OCbot1 is running fine!"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

/* -------------------- Discord Setup -------------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const BOT_NAME = "OCbot1";
const OWNER_ID = "1167751946577379339"; // Your Discord ID

/* -------------------- Memory / Key Storage -------------------- */
const memoryPath = path.join(__dirname, "memory.json");
const voiceKeyPath = path.join(__dirname, "voicekeys.json");

let memory = {};
let voiceKeys = {};

try {
  if (fs.existsSync(memoryPath)) memory = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
} catch {
  memory = {};
}

try {
  if (fs.existsSync(voiceKeyPath)) voiceKeys = JSON.parse(fs.readFileSync(voiceKeyPath, "utf8"));
} catch {
  voiceKeys = {};
}

/* -------------------- Helper Functions -------------------- */
const saveMemory = () => fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
const saveVoiceKeys = () => fs.writeFileSync(voiceKeyPath, JSON.stringify(voiceKeys, null, 2));

function isOwner(userId) {
  return userId === OWNER_ID;
}

/* -------------------- Dynamic Action Fetching -------------------- */
async function getDynamicGif(actionName) {
  try {
    const repo = "USERNAME/REPO_NAME"; // Replace with your GitHub username/repo
    const apiUrl = `https://api.github.com/repos/${repo}/contents/`;

    const response = await fetch(apiUrl);
    const data = await response.json();
    const gifs = data.filter(file => file.name.toLowerCase().startsWith(actionName) && file.name.endsWith(".gif"));

    if (gifs.length === 0) return null;
    const randomGif = gifs[Math.floor(Math.random() * gifs.length)];
    return `https://raw.githubusercontent.com/${repo}/main/${randomGif.name}`;
  } catch (err) {
    console.error("Error fetching dynamic GIFs:", err);
    return null;
  }
}

/* -------------------- Core Commands -------------------- */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const userId = message.author.id;
  const msg = message.content.trim();

  // --- Prevent multiple responses ---
  if (message._handled) return;
  message._handled = true;

  try {
    /* ----- !commands ----- */
    if (msg === "!commands") {
      return message.reply({
        content:
          "**OCbot1 Commands:**\n" +
          "`!chat <message>` → Chat with OCbot1.\n" +
          "`!actions <user> <action>` → Perform actions (auto-detects GIFs).\n" +
          "`!voicekey <your_openai_key>` → Set your OpenAI TTS key.\n" +
          "`!voice <text>` → Generate custom voice clip.\n" +
          "`!info` → Check your message/voice usage.\n",
      });
    }

    /* ----- !voicekey <key> ----- */
    if (msg.startsWith("!voicekey ")) {
      const key = msg.replace("!voicekey ", "").trim();
      if (!key) return message.reply("❌ Please provide a valid OpenAI API key.");
      voiceKeys[userId] = { key, used: 0, date: new Date().toISOString() };
      saveVoiceKeys();
      return message.reply("✅ Your OpenAI voice key has been set!");
    }

    /* ----- !voice <text> ----- */
    if (msg.startsWith("!voice ")) {
      const text = msg.replace("!voice ", "").trim();
      if (!text) return message.reply("❌ Please provide text for me to say.");

      const userKey = voiceKeys[userId]?.key;
      if (!userKey)
        return message.reply("❌ You need to add your OpenAI key first using `!voicekey <your_key>`");

      try {
        const res = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${userKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini-tts",
            voice: "alloy",
            input: text,
          }),
        });

        if (!res.ok) throw new Error(`OpenAI API error: ${res.statusText}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const filePath = path.join(__dirname, `voice_${userId}.mp3`);
        fs.writeFileSync(filePath, buffer);

        await message.reply({
          content: `🎤 **OCbot1 says:** ${text}`,
          files: [filePath],
        });

        fs.unlinkSync(filePath); // cleanup
      } catch (err) {
        console.error("Voice generation failed:", err);
        message.reply("❌ Voice generation failed. Check your OpenAI key.");
      }
      return;
    }

    /* ----- !actions <user> <action> ----- */
    if (msg.startsWith("!actions ")) {
      const parts = msg.split(" ");
      const target = parts[1];
      const actionName = parts[2]?.toLowerCase();
      if (!target || !actionName) return message.reply("❌ Usage: `!actions <user> <action>`");

      const gifUrl = await getDynamicGif(actionName);
      if (!gifUrl) return message.reply("❌ Couldn't find a matching action GIF on the repo.");

      return message.reply({
        content: `*${message.author.username} ${actionName}s ${target}* 💥`,
        files: [gifUrl],
      });
    }

    /* ----- !chat <message> ----- */
    if (msg.startsWith("!chat ")) {
      const userMessage = msg.replace("!chat ", "").trim();
      if (!userMessage) return message.reply("❌ Please provide a message.");

      // Save user message to memory
      if (!memory[userId]) memory[userId] = [];
      memory[userId].push({ role: "user", content: userMessage });
      saveMemory();

      // Simulated bot response (you can replace with your model API)
      const responses = [
        "Yo, what’s up?",
        "Heh, didn’t expect that one.",
        "You sure about that?",
        "Hah, classic you.",
        "Mhm. Sounds like you.",
      ];
      const reply = responses[Math.floor(Math.random() * responses.length)];

      memory[userId].push({ role: "assistant", content: reply });
      saveMemory();

      return message.reply(reply);
    }

    /* ----- !info ----- */
    if (msg === "!info") {
      const voiceInfo = voiceKeys[userId]
        ? `🔑 Voice Key Set: ✅\n🗓️ Added: ${new Date(voiceKeys[userId].date).toLocaleString()}`
        : "🔑 Voice Key Set: ❌";
      const memoryCount = memory[userId]?.length || 0;

      return message.reply(
        `📊 **Your Info:**\n🧠 Messages Stored: ${memoryCount}\n${voiceInfo}`
      );
    }
  } catch (err) {
    console.error("Command Error:", err);
    message.reply("❌ Uhh... something broke. Try again later.");
  }
});

client.once("ready", () => {
  console.log(`${BOT_NAME} is online and ready!`);
});

client.login(process.env.TOKEN);
