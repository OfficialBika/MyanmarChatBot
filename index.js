// Nora AI Girl Bot — Gemini + MongoDB + Webhook (Render friendly) — FINAL (AI + Templates + MLBB Data)
// --------------------------------------------------------------------------------------------------
// ✅ Webhook (Render) correct mount
// ✅ Group: reply ONLY if (reply to Nora) OR (mention @bot) OR (name-call "Nora")
// ✅ Mongo memory: per chat-user session
// ✅ Long message splitter (avoid Telegram 4096 cut)
// ✅ Fallback Templates (templates.js) when Gemini quota/error OR AI_MODE=off
// ✅ /admin + /broadcast (Owner only) + chat registry for broadcast
//
// Required files:
// - index.js
// - templates.js (the FINAL one I sent)
// - data/hero-meta-final.txt
// - data/item-meta-final.txt
// - data/emblem-meta-final.txt
//
// .env required:
// BOT_TOKEN=...
// MONGODB_URI=...
// WEBHOOK_DOMAIN=https://your-service.onrender.com
// Optional:
// GEMINI_API_KEY=... (if you want AI on)
// AI_MODE=auto|off        (default: auto)
// GEMINI_MODEL=gemini-2.5-flash-lite (default)
// BOT_NAME=Nora
// LOVER_NAME=Bika
// OWNER_ID=123456789      (for /admin, /broadcast)
// GROUP_REPLY_ONLY_WHEN_MENTIONED=true
// MAX_HISTORY=16
// MONGODB_DB_NAME=nora_bot
// MONGODB_COLLECTION=sessions
// MONGODB_CHATS_COLLECTION=chats

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { MongoClient } = require("mongodb");
const express = require("express");
const { templateReply } = require("./templates");

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MONGODB_URI = process.env.MONGODB_URI;
const WEBHOOK_DOMAIN = (process.env.WEBHOOK_DOMAIN || "").replace(/\/+$/, "");

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in .env");
if (!WEBHOOK_DOMAIN) throw new Error("Missing WEBHOOK_DOMAIN in .env (Render domain)");

// Optional AI
const AI_MODE = String(process.env.AI_MODE || "auto").toLowerCase(); // auto | off
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const BOT_NAME = process.env.BOT_NAME || "Nora";
const LOVER_NAME = process.env.LOVER_NAME || "Bika";

const OWNER_ID =
  parseInt(process.env.OWNER_ID || "0", 10) > 0 ? parseInt(process.env.OWNER_ID, 10) : null;

const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "nora_bot";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "sessions";
const MONGODB_CHATS_COLLECTION = process.env.MONGODB_CHATS_COLLECTION || "chats";

const MAX_HISTORY = clampInt(process.env.MAX_HISTORY, 16, 4, 40);
const GROUP_REPLY_ONLY_WHEN_MENTIONED =
  String(process.env.GROUP_REPLY_ONLY_WHEN_MENTIONED || "true") === "true";

// ===== CORE OBJECTS =====
const bot = new Telegraf(BOT_TOKEN);
const mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });

let sessionsCollection;
let chatsCollection;

// ===== HELPERS =====
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function nowMs() {
  return Date.now();
}

function isGroupChat(ctx) {
  const t = ctx.chat?.type;
  return t === "group" || t === "supergroup";
}

function extractText(ctx) {
  return (
    ctx.message?.text ||
    ctx.message?.caption ||
    ctx.update?.message?.text ||
    ctx.update?.message?.caption ||
    ""
  ).trim();
}

function getUserId(ctx) {
  return ctx.from?.id;
}

function getDisplayName(ctx) {
  const u = ctx.from || {};
  const full = (u.first_name || "") + (u.last_name ? ` ${u.last_name}` : "");
  return full || (u.username ? `@${u.username}` : "friend");
}

async function setTyping(ctx) {
  try {
    await ctx.sendChatAction("typing");
  } catch (_) {}
}

// ===== LONG MESSAGE SENDER (avoid Telegram 4096 cut) =====
const TELEGRAM_LIMIT = 3900;

async function sendLongMessage(ctx, text, extra = {}) {
  if (!text) return;
  let remaining = String(text);

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_LIMIT) {
      await ctx.reply(remaining, { disable_web_page_preview: true, ...extra });
      break;
    }

    let sliceIndex = remaining.lastIndexOf("\n\n", TELEGRAM_LIMIT);
    if (sliceIndex === -1) sliceIndex = remaining.lastIndexOf("\n", TELEGRAM_LIMIT);
    if (sliceIndex === -1) sliceIndex = remaining.lastIndexOf(" ", TELEGRAM_LIMIT);
    if (sliceIndex === -1) sliceIndex = TELEGRAM_LIMIT;

    const chunk = remaining.slice(0, sliceIndex).trimEnd();
    remaining = remaining.slice(sliceIndex).trimStart();

    if (chunk) {
      await ctx.reply(chunk, { disable_web_page_preview: true, ...extra });
    }
  }
}

// ===== GROUP reply logic =====
// Group: reply ONLY if (reply to Nora) OR (mention @bot) OR (name-call "Nora")
function shouldReplyInGroup(ctx, text) {
  if (!isGroupChat(ctx)) return true;

  const lower = (text || "").toLowerCase();
  const me = ctx.botInfo?.username;

  // (1) Reply to Nora message ONLY
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from && ctx.botInfo && replyTo.from.id === ctx.botInfo.id) return true;

  // (2) Mention @botusername
  if (me && lower.includes("@" + me.toLowerCase())) return true;

  // (3) Name call: "Nora"
  if (BOT_NAME && lower.includes(BOT_NAME.toLowerCase())) return true;

  // (4) If env allows all
  if (!GROUP_REPLY_ONLY_WHEN_MENTIONED) return true;

  return false;
}

// ===== Rate limit (simple in-memory) =====
const rateState = new Map(); // userId -> { t: [], blockedUntil? }
function rateLimitOk(userId) {
  const windowMs = 20_000;
  const limit = 6;

  const s = rateState.get(userId) || { t: [] };
  const now = nowMs();

  if (s.blockedUntil && now < s.blockedUntil) {
    return { ok: false, waitMs: s.blockedUntil - now };
  }

  s.t = s.t.filter((x) => now - x < windowMs);
  s.t.push(now);

  if (s.t.length > limit) {
    s.blockedUntil = now + 10_000;
    rateState.set(userId, s);
    return { ok: false, waitMs: 10_000 };
  }

  rateState.set(userId, s);
  return { ok: true };
}

// ===== Mongo =====
async function initMongo() {
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB_NAME);
  sessionsCollection = db.collection(MONGODB_COLLECTION);
  chatsCollection = db.collection(MONGODB_CHATS_COLLECTION);

  // sessions TTL 30 days
  await sessionsCollection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
  await chatsCollection.createIndex({ lastSeen: 1 });

  console.log("MongoDB connected ✅");
}

function getSessionId(ctx) {
  const uid = getUserId(ctx);
  const cid = ctx.chat?.id;
  return `${cid}:${uid}`;
}

async function loadSession(sessionId) {
  const doc = await sessionsCollection.findOne({ _id: sessionId });
  if (!doc) return { _id: sessionId, history: [] };
  doc.history = doc.history || [];
  return doc;
}

async function saveSession(session) {
  session.updatedAt = new Date();
  await sessionsCollection.updateOne(
    { _id: session._id },
    {
      $set: {
        history: (session.history || []).slice(-MAX_HISTORY),
        updatedAt: session.updatedAt,
      },
    },
    { upsert: true }
  );
}

// track chats for /broadcast
async function touchChat(ctx) {
  if (!chatsCollection) return;
  const chat = ctx.chat;
  if (!chat || !chat.id) return;

  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const title = isGroup ? (chat.title || "") : getDisplayName(ctx);

  await chatsCollection.updateOne(
    { _id: chat.id },
    {
      $setOnInsert: { firstSeen: new Date() },
      $set: {
        type: chat.type,
        title,
        isGroup,
        lastSeen: new Date(),
      },
    },
    { upsert: true }
  );
}

// ===== Gemini =====
function buildSystemPrompt(ctx) {
  const userName = getDisplayName(ctx);
  const isGroup = isGroupChat(ctx);

  return `
You are ${BOT_NAME}, a cute Myanmar AI girl chatbot.
${LOVER_NAME} is your boyfriend. The current user talking to you is "${userName}" (their Telegram name).

STYLE:
- Speak mostly in Burmese (Myanmar language), mix a bit of casual English.
- Tone: warm, playful, friendly girlfriend style but respectful and non-explicit.
- ALWAYS call the user by their Telegram name at least once in each reply.
  For example: "Ko ${userName}", "${userName}လေး", etc. Choose naturally.
- Use 0–3 emojis like 😄🥹✨.
- In group chats, keep replies short (1–3 short paragraphs).
- In private chats, you can be a bit more chatty (max 6 short paragraphs).
- Often ask a small follow-up question in Burmese to keep the conversation alive.

SAFETY:
- Never produce explicit sexual content, pornographic details, self-harm instructions, or guidance for illegal/dangerous activities.
- If the user requests something unsafe, gently refuse in Burmese and suggest safe topics instead.

CONTEXT:
- This chat is a ${isGroup ? "group chat" : "private chat"}.
- If user only calls your name (like "Nora" or "Nora?"), answer like a girlfriend greeting them by name and asking what's up.
`.trim();
}

async function callGemini(ctx, userText, history) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set");
  }

  const systemPrompt = buildSystemPrompt(ctx);
  const contents = [];
  const limitedHistory = (history || []).slice(-MAX_HISTORY);

  for (const m of limitedHistory) {
    const role = m.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text: m.content }] });
  }

  contents.push({ role: "user", parts: [{ text: userText }] });

  const body = {
    contents,
    systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: isGroupChat(ctx) ? 260 : 380,
      topP: 0.95,
    },
  };

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${text.slice(0, 600)}`);
  }

  const data = await res.json();
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts;

  if (!parts || !Array.isArray(parts)) {
    return "ဟင်… Nora က သေချာမရေးနိုင်သေးလို့ တစ်ခါထပ်ရှင်းပြပေးပါနော် 🥲";
  }

  const reply = parts.map((p) => p.text || "").join("").trim();
  return reply || "ဟယ်… Nora က စာမလုံးဝမရသေးလိုပဲ 😅 နောက်တစ်ခါထပ်ရိုက်ပို့ပေးပါအုံး။";
}

// ===== UI / COMMANDS =====
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💬 Chat with Nora", "MENU_CHAT"), Markup.button.callback("🧠 Memory", "MENU_MEMORY")],
    [Markup.button.callback("🧹 Clear Memory", "MENU_CLEAR"), Markup.button.callback("ℹ️ Help", "MENU_HELP")],
  ]);
}

const HELP_TEXT = (username = "") =>
  `🧸 *${BOT_NAME} — Myanmar AI Girl Bot*

Group chat:
- Nora ကို reply ထောက်ပြီးပြော (သို့) "Nora ..." လို့ခေါ် (သို့)
- *@${username || "your_bot"}* mention လုပ်

Commands:
/start
/help
/clear
/admin (owner only)
/broadcast (owner only)
`.trim();

bot.start(async (ctx) => {
  await touchChat(ctx);

  const name = getDisplayName(ctx);
  const txt = `ဟယ်လို ${name} 👋  
ကျမက *${BOT_NAME}* ပါ 💜  
${LOVER_NAME} ရည်းစားလေးလည်း ဖြစ်တယ် 😏

Group မှာတော့ Nora ကို reply ထောက်ပြီးပြော၊ ဒါမှမဟုတ် "Nora ..." လို့ခေါ်/mention လုပ်ပေးနော်။`;

  await ctx.replyWithMarkdown(txt, mainMenu());
});

bot.command("help", async (ctx) => {
  await touchChat(ctx);
  const h = HELP_TEXT(ctx.botInfo?.username || "");
  await ctx.replyWithMarkdown(h, mainMenu());
});

bot.command("clear", async (ctx) => {
  await touchChat(ctx);
  const sessionId = getSessionId(ctx);
  await saveSession({ _id: sessionId, history: [] });
  await ctx.reply("🧹 ဒီ chat အတွက် Nora memory ကို အကုန်ဖျက်လိုက်ပြီနော် 💙");
});

// /admin — owner only
bot.command("admin", async (ctx) => {
  await touchChat(ctx);

  if (!OWNER_ID || ctx.from?.id !== OWNER_ID) {
    return ctx.reply(`ဒီ command က ${LOVER_NAME} (Owner) လေးပဲ သုံးလို့ရမယ်နော် 😌`);
  }

  const chatsTotal = await chatsCollection.countDocuments({});
  const groups = await chatsCollection.countDocuments({ isGroup: true });
  const privates = await chatsCollection.countDocuments({ isGroup: false });
  const sessions = await sessionsCollection.countDocuments({});

  const msg =
    `👑 *${BOT_NAME} Admin Dashboard*\n\n` +
    `Owner: ${LOVER_NAME} (ID: ${OWNER_ID})\n` +
    `AI_MODE: ${AI_MODE}\n` +
    `Gemini model: ${GEMINI_MODEL}\n\n` +
    `Chats: ${chatsTotal}\n- Private: ${privates}\n- Groups: ${groups}\n\n` +
    `Sessions (memory docs): ${sessions}`;

  await ctx.replyWithMarkdown(msg);
});

// /broadcast — owner only
bot.command("broadcast", async (ctx) => {
  await touchChat(ctx);

  if (!OWNER_ID || ctx.from?.id !== OWNER_ID) {
    return ctx.reply(`ဒီ command က ${LOVER_NAME} (Owner) လေးပဲ သုံးလို့ရမယ်နော် 😌`);
  }

  const raw = ctx.message?.text || "";
  const cleaned = raw.replace(/\/broadcast(@\w+)?/i, "").trim();

  if (!cleaned) {
    return ctx.reply("Broadcast စာကို ဒီလိုသုံးပါနော်:\n\n/broadcast မင်္ဂလာပါ Nora fan တွေ 🌸");
  }

  const message = `📢 *${BOT_NAME} Broadcast*\n\n${cleaned}`;
  let sent = 0;
  let failed = 0;

  const cursor = chatsCollection.find({});
  while (await cursor.hasNext()) {
    const chat = await cursor.next();
    try {
      await bot.telegram.sendMessage(chat._id, message, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      sent++;
    } catch (_) {
      failed++;
    }
  }

  await ctx.reply(`Broadcast ပြီးပါပြီ ✅\n\nပို့နိုင်သမျှ: ${sent}\nပျက်သွားသမျှ: ${failed}`);
});

// inline menu actions
bot.action("MENU_CHAT", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  await ctx.reply("Chat mode ✅ စာရိုက်လိုက်… Nora ပြန်ဖြေမယ်နော် 😌");
});

bot.action("MENU_MEMORY", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  const sessionId = getSessionId(ctx);
  const s = await loadSession(sessionId);
  const n = s.history?.length || 0;
  await ctx.reply(`🧠 ဒီ chat memory items: ${n}`);
});

bot.action("MENU_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  const sessionId = getSessionId(ctx);
  await saveSession({ _id: sessionId, history: [] });
  await ctx.reply("OK နော် 🧹 Memory cleared ✅");
});

bot.action("MENU_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  const h = HELP_TEXT(ctx.botInfo?.username || "");
  await ctx.replyWithMarkdown(h, mainMenu());
});

// ===== MAIN MESSAGE HANDLER =====
bot.on(["text", "caption"], async (ctx) => {
  await touchChat(ctx);

  const userId = getUserId(ctx);
  if (!userId) return;

  const text = extractText(ctx);
  if (!text) return;

  // ignore group noise
  if (!shouldReplyInGroup(ctx, text)) return;

  // rate limit
  const rl = rateLimitOk(userId);
  if (!rl.ok) return;

  await setTyping(ctx);

  const isGroup = isGroupChat(ctx);
  const replyExtra = isGroup
    ? { reply_to_message_id: ctx.message?.message_id, allow_sending_without_reply: true }
    : {};

  // AI OFF → always template
  if (AI_MODE === "off") {
    const fb = templateReply(text, { userName: getDisplayName(ctx), isGroup });
    return sendLongMessage(ctx, fb, replyExtra);
  }

  // Load session for memory (only for AI path)
  const sessionId = getSessionId(ctx);
  const session = await loadSession(sessionId);
  const history = session.history || [];

  try {
    const reply = await callGemini(ctx, text, history);

    // Save memory
    history.push({ role: "user", content: text, at: new Date() });
    history.push({ role: "assistant", content: reply, at: new Date() });
    session.history = history.slice(-MAX_HISTORY);
    await saveSession(session);

    await sendLongMessage(ctx, reply, replyExtra);
  } catch (e) {
    // Fallback to templates (very important for quota 429 / billing issues)
    console.error("AI error, fallback to template:", e?.message || e);

    const fb = templateReply(text, { userName: getDisplayName(ctx), isGroup });
    await sendLongMessage(ctx, fb, replyExtra);
  }
});

// ===== WEBHOOK SERVER (Render) =====
const SECRET_PATH = `/telegraf/${BOT_TOKEN}`;

(async () => {
  try {
    await initMongo();

    const me = await bot.telegram.getMe();
    bot.botInfo = me;
    console.log(`Bot @${me.username} (${BOT_NAME}) initialized ✅`);

    const app = express();
    app.use(express.json());

    app.get("/", (req, res) => {
      res.send(`${BOT_NAME} is running ✅ | AI_MODE=${AI_MODE} | model=${GEMINI_MODEL}`);
    });

    // ✅ Correct: mount ONLY at SECRET_PATH
    app.use(SECRET_PATH, bot.webhookCallback(SECRET_PATH));
    
    const PORT = process.env.PORT || 10000;
    app.listen(PORT, async () => {
      console.log(`HTTP server listening on port ${PORT} ✅`);

      const hookUrl = WEBHOOK_DOMAIN + SECRET_PATH;
      await bot.telegram.setWebhook(hookUrl);
      console.log(`Webhook set to ${hookUrl} ✅`);
    });
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();
