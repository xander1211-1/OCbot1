// index.js
import fs from "fs";
import path from "path";
import express from "express";
import { Client, GatewayIntentBits, Partials } from "discord.js";

// --- Express server to keep Render Web Service alive ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("OCbot1 is running!"));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

// --- Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel],
});

// --- JSON files for persistent memory and keys ---
const MEMORY_FILE = "./memory.json";
const KEYS_FILE = "./keys.json";

let memory = fs.existsSync(MEMORY_FILE) ? JSON.parse(fs.readFileSync(MEMORY_FILE)) : {};
let keys = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE)) : {};

const saveJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// --- Dynamic actions ---
const fetchActions = () => fs.readdirSync("./").filter(f => f.endsWith(".gif")).map(f => f.toLowerCase());
let dynamicActions = fetchActions();

// --- Prevent multiple messages per command ---
const sendingMessages = new Set();

// --- Main message handler ---
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (sendingMessages.has(message.id)) return;
  sendingMessages.add(message.id);

  try {
    const content = message.content.trim();
    const authorId = message.author.id;

    // --- Chat command ---
    if (content.startsWith("!chat")) {
      const text = content.split(" ").slice(2).join(" ");
      if (!keys[authorId]) {
        await message.reply("You need to add your OpenRouter key with !key <yourkey>");
      } else {
        const userKey = keys[authorId].key;

        // --- OpenRouter API call ---
        try {
          const response = await fetch("https://api.openrouter.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${userKey}`
            },
            body: JSON.stringify({
              model: "tngtech/deepseek-r1t2-chimera:free",
              messages: [{ role: "user", content: text }]
            })
          });

          const data = await response.json();
          const aiResponse = data.choices?.[0]?.message?.content || "Uhh... my brain blanked out.";

          // Increment messages used
          keys[authorId].messagesUsed = (keys[authorId].messagesUsed || 0) + 1;
          saveJSON(KEYS_FILE, keys);

          await message.reply(aiResponse);

        } catch (err) {
          console.error(err);
          await message.reply("Uhh... something went wrong with your AI key.");
        }
      }
    }

    // --- Add or update OpenRouter key ---
    if (content.startsWith("!key")) {
      const userKey = content.split(" ")[1];
      if (!userKey) return message.reply("Please provide a key: !key <yourkey>");
      keys[authorId] = { key: userKey, messagesUsed: 0 };
      saveJSON(KEYS_FILE, keys);
      await message.reply("Your key has been added!");
    }

    // --- Info command ---
    if (content.startsWith("!info")) {
      const userData = keys[authorId];
      if (!userData) return message.reply("You have not added a key yet!");
      const messagesLeft = 50 - (userData.messagesUsed || 0);
      await message.reply(`You have ${messagesLeft} messages left today.`);
    }

    // --- Actions ---
    const actionCommand = dynamicActions.find(a => content.startsWith("!" + a.split(".")[0]));
    if (actionCommand) {
      const userTarget = message.mentions.users.first();
      await message.channel.send({
        content: userTarget ? `${message.author.username} ${actionCommand.split(".")[0]}s ${userTarget.username}!` : `${message.author.username} ${actionCommand.split(".")[0]}s!`,
        files: [actionCommand]
      });
    }

    // --- Commands list ---
    if (content.startsWith("!commands")) {
      dynamicActions = fetchActions(); // refresh action list dynamically
      const availableActions = dynamicActions.map(a => `!${a.split(".")[0]}`).join(", ");
      await message.reply(`Available commands:\n!chat <text>\n!key <yourkey>\n!info\nActions: ${availableActions}`);
    }

  } catch (err) {
    console.error(err);
    await message.reply("Uhh... something went wrong.");
  } finally {
    sendingMessages.delete(message.id);
  }
});

// --- Login Discord bot ---
client.login(process.env.TOKEN);
