// Nora AI Girl Bot — Gemini + MongoDB + Webhook (Render friendly) — FINAL
// ---------------------------------------------------------------------
// ✅ Webhook (Render) + Healthcheck /
// ✅ Gemini 2.5 Flash-Lite (AI)
// ✅ MongoDB: sessions (memory for private only) + chats (for broadcast)
// ✅ Group: reply ONLY if (1) reply-to Nora OR (2) mention @bot OR (3) says "Nora"
// ✅ Group: cleans prompt (removes Nora/@bot prefix) => more natural replies
// ✅ Long message splitter (Telegram 4096 cut proof)
// ✅ /admin + /broadcast (owner only)

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { MongoClient } = require("mongodb");
const express = require("express");

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in .env");

const BOT_NAME = process.env.BOT_NAME || "Nora";
const LOVER_NAME = process.env.LOVER_NAME || "Bika";

const OWNER_ID = (() => {
  const n = parseInt(process.env.OWNER_ID || "0", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "nora_bot";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "sessions";
const MONGODB_CHATS_COLLECTION = process.env.MONGODB_CHATS_COLLECTION || "chats";

const MAX_HISTORY = clampInt(process.env.MAX_HISTORY, 16, 4, 40);
const GROUP_REPLY_ONLY_WHEN_MENTIONED =
  String(process.env.GROUP_REPLY_ONLY_WHEN_MENTIONED || "true") === "true";

const WEBHOOK_DOMAIN = (process.env.WEBHOOK_DOMAIN || "").replace(/\/+$/, ""); // no trailing slash

// ===== GEMINI CONFIG =====
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ===== CORE =====
const bot = new Telegraf(BOT_TOKEN);

// ===== MONGO =====
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

/**
 * Group policy:
 * - Reply only if:
 *   (1) user replied to Nora message
 *   (2) user mentioned @botusername
 *   (3) user wrote "Nora ..."
 * - Otherwise ignore all group chats.
 */
function shouldReplyInGroup(ctx, text) {
  if (!isGroupChat(ctx)) return true;

  // (1) reply to Nora message ONLY
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from && ctx.botInfo && replyTo.from.id === ctx.botInfo.id) {
    return true;
  }

  const me = ctx.botInfo?.username;
  const lower = (text || "").toLowerCase();

  // (2) mention @bot
  if (me && lower.includes("@" + me.toLowerCase())) return true;

  // (3) name call "Nora"
  if (BOT_NAME && lower.includes(BOT_NAME.toLowerCase())) return true;

  // (optional) allow all in group if env says so
  if (!GROUP_REPLY_ONLY_WHEN_MENTIONED) return true;

  return false;
}

/**
 * Clean group prompt:
 * - remove @botusername
 * - remove leading "Nora" call
 * - if empty => default greeting
 */
function cleanGroupPrompt(ctx, text) {
  let t = (text || "").trim();
  if (!t) return t;

  const me = ctx.botInfo?.username;
  if (me) {
    const re = new RegExp("@" + me + "\\b", "ig");
    t = t.replace(re, "").trim();
  }

  const bn = (BOT_NAME || "Nora").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  t = t.replace(new RegExp("^" + bn + "\\b[\\s,:-]*", "i"), "").trim();

  if (!t) t = "ဟယ်လို Nora လေး";
  return t;
}

// ===== RATE LIMIT =====
const rateState = new Map(); // userId -> { t: [], blockedUntil? }

function rateLimitOk(userId) {
  // max 6 msgs / 20s (simple anti-spam)
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

// ===== MONGO: SESSIONS / CHATS =====
async function initMongo() {
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB_NAME);
  sessionsCollection = db.collection(MONGODB_COLLECTION);
  chatsCollection = db.collection(MONGODB_CHATS_COLLECTION);

  // TTL 30 days for sessions
  await sessionsCollection.createIndex(
    { updatedAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 30 }
  );

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
        history: session.history.slice(-MAX_HISTORY),
        updatedAt: session.updatedAt,
      },
    },
    { upsert: true }
  );
}

async function touchChat(ctx) {
  const chat = ctx.chat;
  if (!chat || !chat.id) return;

  const group = chat.type === "group" || chat.type === "supergroup";
  let title = chat.title || "";

  if (!group) title = getDisplayName(ctx);

  await chatsCollection.updateOne(
    { _id: chat.id },
    {
      $setOnInsert: { firstSeen: new Date() },
      $set: {
        type: chat.type,
        title,
        isGroup: group,
        lastSeen: new Date(),
      },
    },
    { upsert: true }
  );
}

// ===== LONG MESSAGE SENDER (Telegram 4096 safe) =====
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

    if (chunk) await ctx.reply(chunk, { disable_web_page_preview: true, ...extra });
  }
}

// ===== GEMINI =====
function buildSystemPrompt(ctx) {
  const userName = getDisplayName(ctx);
  const group = isGroupChat(ctx);
  const isOwner = OWNER_ID && ctx.from && ctx.from.id === OWNER_ID;

  const relationshipLine = isOwner
    ? `${LOVER_NAME} (the current user) is your beloved boyfriend and the owner of this bot. Treat him extra sweet and caring, but still safe and non-explicit.`
    : `${LOVER_NAME} is your beloved boyfriend and the owner of this bot. You are chatting with "${userName}". Be friendly and warm. Romantic tone is lighter than with ${LOVER_NAME}.`;

  return `
You are ${BOT_NAME}, a cute Myanmar AI girl chatbot.

${relationshipLine}

STYLE:
- Speak Burmese naturally (Myanmar). You may add 0–2 short English words only if natural.
- No weird symbols, no random decorations, no repeated characters.
- Reply must be meaningful and direct.
- ALWAYS address the user by their Telegram name once (e.g., "Ko ${userName}", "${userName}လေး").
- Group chats: 1–2 short paragraphs. Private chats: max 4 short paragraphs.
- Use 0–2 emojis only.
- If unclear, ask ONE short follow-up question.

SAFETY:
- Never produce explicit sexual content, pornographic details, self-harm instructions, or illegal/dangerous guidance.
- If unsafe request, refuse politely in Burmese and offer safe alternative.

CONTEXT:
- This is a ${group ? "group chat" : "private chat"}.
- If user just calls your name, greet them and ask what's up.
`.trim();
}

async function callGemini(ctx, userText, history) {
  const systemPrompt = buildSystemPrompt(ctx);
  const group = isGroupChat(ctx);

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
      temperature: group ? 0.6 : 0.75,
      topP: 0.9,
      maxOutputTokens: group ? 220 : 320,
    },
  };

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${t.slice(0, 500)}`);
  }

  const data = await res.json();
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts;

  if (!parts || !Array.isArray(parts)) {
    return "ဟင်… Nora က မသေချာသေးလို့ နည်းနည်းထပ်ရှင်းပြပေးပါနော် 🥲";
  }

  const reply = parts.map((p) => p.text || "").join("").trim();
  return reply || "ဟယ်… Nora မရသေးလိုပဲ 😅 တစ်ခါထပ်ပြောပေးပါနော်။";
}

// ===== UI =====
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💬 Chat", "MENU_CHAT"), Markup.button.callback("🧠 Memory", "MENU_MEMORY")],
    [Markup.button.callback("🧹 Clear", "MENU_CLEAR"), Markup.button.callback("ℹ️ Help", "MENU_HELP")],
  ]);
}

const HELP_TEXT = (username = "") =>
  `🧸 *${BOT_NAME} — Myanmar AI Girl Bot*

Group:
- Nora ကို reply ထောက်ပြီးပြော (သို့) "Nora ..." လို့ခေါ် (သို့) *@${username || "your_bot"}* mention လုပ်

Commands:
/start
/help
/clear
/admin (owner)
/broadcast (owner)
`.trim();

// ===== COMMANDS =====
bot.start(async (ctx) => {
  await touchChat(ctx);
  const name = getDisplayName(ctx);
  const msg =
    `ဟယ်လို ${name} 👋\n` +
    `ကျမက *${BOT_NAME}* ပါ 💜\n` +
    `${LOVER_NAME} ရည်းစားလေးလည်း ဖြစ်တယ် 😏\n\n` +
    `Group မှာတော့ Nora ကို reply ထောက်ပြီးပြော၊ ဒါမှမဟုတ် "Nora ..." လို့ခေါ်ပေးနော်။`;

  await ctx.replyWithMarkdown(msg, mainMenu());
});

bot.command("help", async (ctx) => {
  await touchChat(ctx);
  await ctx.replyWithMarkdown(HELP_TEXT(ctx.botInfo?.username || ""), mainMenu());
});

bot.command("clear", async (ctx) => {
  await touchChat(ctx);
  const sessionId = getSessionId(ctx);
  await saveSession({ _id: sessionId, history: [] });
  await ctx.reply("🧹 ဒီ chat အတွက် memory ကို ဖျက်ပြီးပြီနော် 💙");
});

// /admin — owner only
bot.command("admin", async (ctx) => {
  await touchChat(ctx);
  if (!OWNER_ID || ctx.from?.id !== OWNER_ID) {
    return ctx.reply(`ဒီ command က ${LOVER_NAME} (Owner) လေးပဲ သုံးလို့ရမယ်နော် 😌`);
  }

  const totalChats = await chatsCollection.countDocuments({});
  const privateChats = await chatsCollection.countDocuments({ isGroup: false });
  const groupChats = await chatsCollection.countDocuments({ isGroup: true });
  const sessionsCount = await sessionsCollection.countDocuments({});

  const msg =
    `👑 *${BOT_NAME} Admin Dashboard*\n\n` +
    `Owner: ${LOVER_NAME} (ID: ${OWNER_ID})\n\n` +
    `Chats: ${totalChats}\n- Private: ${privateChats}\n- Groups: ${groupChats}\n\n` +
    `Sessions (memory docs): ${sessionsCount}`;

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
    return ctx.reply("သုံးပုံ: /broadcast မင်္ဂလာပါ Nora fan တွေ 🌸");
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

  await ctx.reply(`Broadcast ✅\nSent: ${sent}\nFailed: ${failed}`);
});

// Menu actions
bot.action("MENU_CHAT", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  await ctx.reply("OK 😊 စကားပြောလိုက်နော်—Nora ပြန်ဖြေပေးမယ် 💜");
});

bot.action("MENU_MEMORY", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  const sessionId = getSessionId(ctx);
  const s = await loadSession(sessionId);
  await ctx.reply(`🧠 Memory items: ${s.history?.length || 0}`);
});

bot.action("MENU_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  const sessionId = getSessionId(ctx);
  await saveSession({ _id: sessionId, history: [] });
  await ctx.reply("Memory cleared ✅");
});

bot.action("MENU_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  await ctx.replyWithMarkdown(HELP_TEXT(ctx.botInfo?.username || ""), mainMenu());
});

// ===== MAIN HANDLER =====
bot.on(["text", "caption"], async (ctx) => {
  await touchChat(ctx);

  const userId = getUserId(ctx);
  if (!userId) return;

  const rawText = extractText(ctx);
  if (!rawText) return;

  // group filter
  if (!shouldReplyInGroup(ctx, rawText)) return;

  // rate limit
  const rl = rateLimitOk(userId);
  if (!rl.ok) return;

  await setTyping(ctx);

  const group = isGroupChat(ctx);

  // prompt cleanup for group
  const text = group ? cleanGroupPrompt(ctx, rawText) : rawText;

  // load session (for private memory only)
  const sessionId = getSessionId(ctx);
  const session = await loadSession(sessionId);
  const history = session.history || [];

  try {
    // Group uses AI too, but no memory/history to avoid reading group chats
    const historyForModel = group ? [] : history;

    const reply = await callGemini(ctx, text, historyForModel);

    // Save memory only in private chats
    if (!group) {
      history.push({ role: "user", content: text, at: new Date() });
      history.push({ role: "assistant", content: reply, at: new Date() });
      session.history = history.slice(-MAX_HISTORY);
      await saveSession(session);
    }

    await sendLongMessage(ctx, reply);
  } catch (e) {
    console.error("Gemini error:", e?.message || e);
    await ctx.reply("အင်း… Nora ဘက်က error နည်းနည်းဖြစ်သွားတယ် 🥲 နောက်တစ်ခါထပ်စမ်းပေးပါနော်။");
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
      res.send(`${BOT_NAME} Gemini bot is running 💜`);
    });

    // IMPORTANT: no path arg here
    app.use(bot.webhookCallback(SECRET_PATH));

    const PORT = process.env.PORT || 10000;
    app.listen(PORT, async () => {
      console.log(`HTTP server listening on port ${PORT} ✅`);

      if (!WEBHOOK_DOMAIN) {
        console.warn("WEBHOOK_DOMAIN not set in .env");
        return;
      }

      const hookUrl = WEBHOOK_DOMAIN + SECRET_PATH;
      await bot.telegram.setWebhook(hookUrl);
      console.log(`Webhook set to ${hookUrl} ✅`);
    });
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();
