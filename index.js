// index.js
import fs from "fs";
import path from "path";
import express from "express";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import OpenRouter from "openrouter"; // replace with the correct import if using a library

const app = express();
const PORT = process.env.PORT || 3000;

// Dummy web server to keep Render Web Service alive
app.get("/", (req, res) => res.send("OCbot1 is running!"));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// Persistent JSON files
const MEMORY_FILE = "./memory.json";
const KEYS_FILE = "./keys.json";

let memory = fs.existsSync(MEMORY_FILE) ? JSON.parse(fs.readFileSync(MEMORY_FILE)) : {};
let keys = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE)) : {};

// Helper to save memory and keys
const saveJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// Fetch dynamic action GIFs from the GitHub repo
const fetchActions = () => {
  // Replace this URL with your raw GitHub repo folder URL if needed
  // For now, assume all GIFs are listed in keys memory or uploaded to repo
  return fs.readdirSync("./").filter(f => f.endsWith(".gif")).map(f => f.toLowerCase());
};

const dynamicActions = fetchActions();

// Ensure single message per command
const sendingMessages = new Set();

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Prevent multiple sends for same message
  if (sendingMessages.has(message.id)) return;
  sendingMessages.add(message.id);

  try {
    const content = message.content.trim();

    // Chat command
    if (content.startsWith("!chat")) {
      const text = content.split(" ").slice(2).join(" ");
      if (!keys[message.author.id]) {
        await message.reply("You need to add your OpenRouter key with !key <yourkey>");
      } else {
        // Call your AI model here (Deepseek / tngtech)
        const aiResponse = "This is a placeholder response."; // replace with real call
        await message.reply(aiResponse);
      }
    }

    // Add or check key
    if (content.startsWith("!key")) {
      const userKey = content.split(" ")[1];
      if (!userKey) return message.reply("Please provide a key: !key <yourkey>");
      keys[message.author.id] = { key: userKey, messagesUsed: 0 };
      saveJSON(KEYS_FILE, keys);
      await message.reply("Your key has been added!");
    }

    if (content.startsWith("!info")) {
      const userData = keys[message.author.id];
      if (!userData) return message.reply("You have not added a key yet!");
      const messagesLeft = 50 - (userData.messagesUsed || 0);
      await message.reply(`You have ${messagesLeft} messages left today.`);
    }

    // Actions (!nom, !bonk, !kiss, etc.)
    const actionCommand = dynamicActions.find(a => content.startsWith("!" + a.split(".")[0]));
    if (actionCommand) {
      const userTarget = message.mentions.users.first();
      const gif = actionCommand;
      await message.channel.send({ content: userTarget ? `${message.author.username} ${actionCommand.split(".")[0]}s ${userTarget.username}!` : `${message.author.username} ${actionCommand.split(".")[0]}s!`, files: [gif] });
    }

    // Commands list
    if (content.startsWith("!commands")) {
      const availableActions = dynamicActions.map(a => `!${a.split(".")[0]}`).join(", ");
      await message.reply(`Available commands:\n!chat <text>\n!key <yourkey>\n!info\nActions: ${availableActions}`);
    }

  } catch (err) {
    console.error(err);
    await message.reply("Uhh, something went wrong.");
  } finally {
    sendingMessages.delete(message.id);
  }
});

// Dummy port ping for Render
client.login(process.env.TOKEN);
    
