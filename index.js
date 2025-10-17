// index.js - OCbot1 (final)
// Requirements: node 18+, discord.js v14, node-fetch, express
import fs from "fs";
import fetch from "node-fetch";
import express from "express";
import { Client, GatewayIntentBits, AttachmentBuilder, ActivityType } from "discord.js";

// ---------- CONFIG ----------
const CREATOR_ID = "1167751946577379339"; // Xander (creator)
const MODEL = "tngtech/deepseek-r1t2-chimera:free";
const MEMORY_FILE = "./memory.json";
const EXPRESS_PORT = 10000; // Render requires a bound port

// ---------- ENV CHECK ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
if (!DISCORD_TOKEN) console.error("⚠️ DISCORD_TOKEN missing!");
if (!OPENROUTER_KEY) console.error("⚠️ OPENROUTER_API_KEY missing!");

// ---------- CLIENT ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ---------- GLOBAL ERROR HANDLING ----------
process.on("unhandledRejection", (err) => console.error("Unhandled promise rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

// ---------- MEMORY LOADING ----------
let memory = { messages: [], players: {}, appearance: { description: "", notes: "" } };
try {
  if (fs.existsSync(MEMORY_FILE)) {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") memory = parsed;
  }
} catch (e) {
  console.error("Error reading memory.json, starting fresh:", e);
  memory = { messages: [], players: {}, appearance: { description: "", notes: "" } };
}
// Ensure valid shapes
if (!Array.isArray(memory.messages)) memory.messages = [];
if (!memory.players || typeof memory.players !== "object") memory.players = {};
if (!memory.appearance || typeof memory.appearance !== "object") memory.appearance = { description: "", notes: "" };

function saveMemory() {
  try {
    if (!memory || typeof memory !== "object") memory = { messages: [], players: {}, appearance: { description: "", notes: "" } };
    if (!Array.isArray(memory.messages)) memory.messages = [];
    if (!memory.players || typeof memory.players !== "object") memory.players = {};
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (e) {
    console.error("Failed to save memory.json:", e);
  }
}

// ---------- TRACKING / MEMORY HELPERS ----------
function safeTrackPlayer(id, username, message = "") {
  if (!id || !username) return;
  const idStr = String(id);
  if (!memory.players[idStr]) memory.players[idStr] = { name: username, interactions: 0, messages: [] };
  else memory.players[idStr].name = username;
  const p = memory.players[idStr];
  p.interactions = (p.interactions || 0) + 1;
  if (message) p.messages.push(message);
  if (p.messages.length > 30) p.messages = p.messages.slice(-30); // keep recent 20-30 messages per user
  saveMemory();
}
function trackUser(id, username, message = "") { if (!id || !username) return; safeTrackPlayer(String(id), username, message); }

// ---------- FILE AUTO-DETECT HELPERS ----------
function listRepoFiles() {
  try {
    return fs.readdirSync("./").filter((f) => fs.statSync(f).isFile());
  } catch (e) {
    console.error("Failed to read repo root:", e);
    return [];
  }
}
function detectEmotionImages() {
  const files = listRepoFiles();
  return files.filter((f) => f.toLowerCase().endsWith(".jpg") || f.toLowerCase().endsWith(".jpeg"));
}
function detectGifsByAction() {
  // Returns map: action -> [file1.gif,...]
  const files = listRepoFiles();
  const gifs = files.filter((f) => f.toLowerCase().endsWith(".gif"));
  const map = {};
  for (const g of gifs) {
    // derive action name: take leading letters before first digit or underscore, e.g. hug1.gif -> 'hug'
    const name = g.split(".gif")[0];
    // normalize: remove trailing digits and non-alpha
    const action = name.replace(/[_\-\s]+/g, "").replace(/\d+$/, "").toLowerCase();
    if (!action) continue;
    if (!map[action]) map[action] = [];
    map[action].push(g);
  }
  return map;
}

// ---------- EMOTION DETECTION (text) ----------
function detectEmotionFromText(text) {
  const t = (text || "").toLowerCase();
  if (t.match(/\b(happy|yay|love|good|excited|cute|sweet)\b/)) return "happy";
  if (t.match(/\b(sad|cry|unhappy|lonely|sorry|bad|tear)\b/)) return "sad";
  if (t.match(/\b(angry|mad|furious|annoy|rage|hate)\b/)) return "angry";
  return "neutral";
}

// ---------- OPENROUTER / MODEL ASK ----------
async function askAI(userMsg, isCreator = false) {
  const system = isCreator
    ? "You are OCbot1, a tomboyish gyaru anime girl. Playful, teasing, confident. Treat this user as your creator (respectful & slightly affectionate). Keep content SFW."
    : "You are OCbot1, a tomboyish gyaru anime girl. Playful, teasing, confident, SFW.";
  const messages = [{ role: "system", content: system }];
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
  } catch (e) {
    console.error("askAI error:", e);
    return "Hmm… something went wrong 😖";
  }
}

// ---------- OPINION (about a player) ----------
async function askOpinion(botName, player, isCreatorMentioned = false) {
  const history = player && player.messages ? player.messages.join("\n") : "No past messages yet.";
  const prompt = `${isCreatorMentioned ? "[ABOUT CREATOR] " : ""}You are ${botName}, a tomboyish gyaru anime girl. Someone asked what you think of ${player?.name || "them"}. Form a sassy, playful, SFW opinion in 1-3 sentences. History:\n${history}`;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json().catch(() => null);
    return data?.choices?.[0]?.message?.content || `Hmm… I don’t know much about ${player?.name || "them"} 😅`;
  } catch (e) {
    console.error("askOpinion error:", e);
    return "Hmm… couldn’t think of an opinion 😖";
  }
}

// ---------- DEDUP + RACE-SAFE SENDER ----------
async function hasBotRepliedToMessage(originalMsg) {
  try {
    const messages = await originalMsg.channel.messages.fetch({ limit: 50 });
    for (const m of messages.values()) {
      if (m.author?.id === client.user?.id) {
        const refId = m.reference?.messageId || (m.reference && m.reference.messageId);
        if (refId === originalMsg.id) return true;
      }
    }
  } catch (e) { console.error("hasBotRepliedToMessage error:", e); }
  return false;
}
async function sendOnce(originalMsg, replyOptions) {
  try {
    if (await hasBotRepliedToMessage(originalMsg)) return null;
    await new Promise((r) => setTimeout(r, 300)); // small delay to avoid races
    if (await hasBotRepliedToMessage(originalMsg)) return null;
    return await originalMsg.reply(replyOptions);
  } catch (e) {
    console.error("sendOnce failed:", e);
    try { return await originalMsg.reply(replyOptions); } catch (err) { console.error("Fallback reply failed:", err); return null; }
  }
}

// ---------- UTILITY: build commands listing ----------
function buildCommandsList() {
  const actionMap = detectGifsByAction();
  const actionNames = Object.keys(actionMap).sort();
  const actionsLine = actionNames.length ? actionNames.join(", ") : "No actions uploaded yet";
  return `💬 OCbot1 Commands:
!chat OCbot1 <message> — Talk with OCbot1
!chat OCbot1 <action> @user — Perform an action (auto-detected from GIFs)
!emotion <emotion> — Send a specific emotion image (by name)
!memory — Show memory usage and top players
!commands — Show this list

Available actions: ${actionsLine}`;
}

// ---------- STARTUP: set appearance into memory if absent ----------
if (!memory.appearance || !memory.appearance.description) {
  memory.appearance = {
    description: "Short blonde hair, pink eyes, tanned skin, curvy body, wears a black cap and an oversized black hoodie.",
    notes: "Tomboyish, teasing, confident voice; loyal to creator (Xander)."
  };
  saveMemory();
}

// ---------- MESSAGE HANDLER ----------
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.author?.id || msg.author.bot) return;
    if (!msg.content) return;
    const content = msg.content.trim();
    // commands accepted: !chat ... or !commands or !emotion or !memory
    const lc = content.toLowerCase();
    if (!(lc.startsWith("!chat") || lc.startsWith("!hi") || lc.startsWith("!commands") || lc.startsWith("!emotion") || lc.startsWith("!memory"))) return;

    // dynamic command: !commands
    if (lc.startsWith("!commands")) {
      return await sendOnce(msg, { content: buildCommandsList() });
    }

    // !memory -> report memory stats
    if (lc.startsWith("!memory")) {
      const playerCount = Object.keys(memory.players).length;
      const top = Object.entries(memory.players).sort((a,b)=> (b[1].interactions||0)-(a[1].interactions||0)).slice(0,5).map(([id,p])=>`${p.name} (${p.interactions||0})`);
      const lines = [`Memory: ${playerCount} players stored.`, `Top interactions: ${top.join(", ") || "none"}`, `Appearance: ${memory.appearance.description}`];
      return await sendOnce(msg, { content: lines.join("\n") });
    }

    // !emotion name -> send specific emotion
    if (lc.startsWith("!emotion")) {
      const parts = content.split(/\s+/);
      if (parts.length < 2) return await sendOnce(msg, { content: "Usage: !emotion <name> — e.g. !emotion happy" });
      const want = parts[1].toLowerCase();
      const emotions = detectEmotionImages();
      const pick = emotions.find(e => e.toLowerCase().includes(want));
      if (!pick) return await sendOnce(msg, { content: `No emotion image matching "${want}" found.` });
      try {
        const buf = fs.readFileSync(`./${pick}`);
        return await sendOnce(msg, { files: [new AttachmentBuilder(buf, { name: pick })] });
      } catch (e) {
        console.error("sending emotion failed:", e);
        return await sendOnce(msg, { content: "Could not send that emotion file." });
      }
    }

    // else: !chat / !hi
    // strip prefix
    let userMsg = content.replace(/^!chat\s*/i, "").replace(/^!hi\s*/i, "").trim();
    if (!userMsg) return await sendOnce(msg, { content: "Try saying `!chat Hey OCbot1!` 🙂" });

    const isCreator = msg.author.id === CREATOR_ID;
    if (isCreator) {
      // small tagging for AI context
      userMsg = "[CREATOR] " + userMsg;
    }

    await msg.channel.sendTyping();
    trackUser(msg.author.id, msg.author.username, msg.content);

    // action pattern: !chat OCbot1 <action> @user  OR !chat OCbot1 dance
    // We'll accept "ocbot1" token optionally present
    const actionMatch = userMsg.match(/ocbot1\s+(\w+)\s*(<@!?\d+>)?/i) || userMsg.match(/^(\w+)\s*(<@!?\d+>)?/i);
    const actionMap = detectGifsByAction();

    if (actionMatch) {
      const action = actionMatch[1]?.toLowerCase();
      const mentionRaw = actionMatch[2];
      // if action exists in detected map -> perform action
      if (action && actionMap[action]) {
        // resolve mention (if any)
        let targetUser = null;
        if (mentionRaw) {
          const idMatch = mentionRaw.match(/\d+/);
          if (idMatch) {
            try { targetUser = await msg.client.users.fetch(idMatch[0]); } catch {}
            if (targetUser) trackUser(targetUser.id, targetUser.username);
          }
        }
        // form message text variations (tomboyish)
        const actor = isCreator ? "Boss" : msg.author.username;
        const targetName = targetUser ? targetUser.username : "someone";
        const templates = [
          `${actor} does a move on ${targetName}!`,
          `Heh, lemme at 'em — ${actor} -> ${targetName}!`,
          `${actor} shows no mercy to ${targetName} 😏`
        ];
        const messageText = templates[Math.floor(Math.random()*templates.length)];
        const gifs = actionMap[action];
        const pick = gifs[Math.floor(Math.random()*gifs.length)];
        if (pick && fs.existsSync(`./${pick}`)) {
          try {
            const buf = fs.readFileSync(`./${pick}`);
            return await sendOnce(msg, { content: messageText, files: [new AttachmentBuilder(buf, { name: pick })] });
          } catch (e) {
            console.error("send action gif failed:", e);
            return await sendOnce(msg, { content: messageText });
          }
        } else {
          return await sendOnce(msg, { content: messageText });
        }
      }
      // if action word present but no gifs for it, continue to normal chat below
    }

    // Normal chat flow
    const aiReply = await askAI(userMsg, isCreator).catch((e) => { console.error("AI error:", e); return "Hmm… something went wrong 😖"; });
    const replyText = aiReply.length > 1900 ? aiReply.slice(0,1900) + "..." : aiReply;

    // emotion jpg selection
    const emotion = detectEmotionFromText(replyText);
    const emotions = detectEmotionImages();
    // try to find a jpg that includes the emotion name
    let pick = emotions.find(e => e.toLowerCase().includes(emotion));
    if (!pick && emotions.length) pick = emotions[Math.floor(Math.random()*emotions.length)]; // fallback random
    if (pick && fs.existsSync(`./${pick}`)) {
      try {
        const buf = fs.readFileSync(`./${pick}`);
        return await sendOnce(msg, { content: replyText, files: [new AttachmentBuilder(buf, { name: pick })] });
      } catch (e) {
        console.error("send emotion image failed:", e);
        return await sendOnce(msg, { content: replyText });
      }
    } else {
      return await sendOnce(msg, { content: replyText });
    }
  } catch (err) {
    console.error("messageCreate handler error:", err);
  }
});

// ---------- READY: presence + optional channel startup message ----------
client.once("ready", async () => {
  console.log(`✅ OCbot1 is online as ${client.user?.tag} (pid=${process.pid})`);
  try {
    // set presence
    client.user.setActivity("with anime vibes", { type: ActivityType.Playing });

    // send a startup message to each guild's system channel if available
    const startupMsg = "Yo! OCbot1's up and ready to cause some chaos 😎";
    for (const guild of client.guilds.cache.values()) {
      try {
        if (guild.systemChannel) {
          await guild.systemChannel.send(startupMsg).catch(() => {});
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error("ready hook error:", e);
  }
});

// ---------- EXPRESS (Render) ----------
const app = express();
app.get("/", (req, res) => res.send("OCbot1 is running."));
app.listen(EXPRESS_PORT, () => console.log(`🌐 Express listening on port ${EXPRESS_PORT}`));

// ---------- LOGIN ----------
client.login(DISCORD_TOKEN).catch((e) => console.error("Failed to login:", e));
    
