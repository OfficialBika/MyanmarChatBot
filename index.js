/**
 * Nora AI Girl Bot — FINAL (OpenAI + Gemini fallback) + MongoDB + Webhook (Render)
 * -----------------------------------------------------------------------------
 * ✅ Webhook correct mount: app.post(SECRET_PATH, express.json(), bot.webhookCallback())
 * ✅ Group reply gate: reply-to Nora OR @mention OR "Nora" name-call
 * ✅ Private: reply to everything
 * ✅ AI: primary/secondary fallback (OpenAI <-> Gemini), NO template by default
 * ✅ /admin + /broadcast (owner) + chat registry
 * ✅ Long message splitting (Telegram 4096)
 *
 * Node: 18+ (Render uses 22 often) => global fetch available
 */

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { MongoClient } = require("mongodb");
const express = require("express");

// =====================
// ENV
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const WEBHOOK_DOMAIN = (process.env.WEBHOOK_DOMAIN || "").replace(/\/+$/, "");

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in .env");
if (!WEBHOOK_DOMAIN) throw new Error("Missing WEBHOOK_DOMAIN in .env");

const BOT_NAME = process.env.BOT_NAME || "Nora";
const LOVER_NAME = process.env.LOVER_NAME || "Bika";

const OWNER_ID =
  parseInt(process.env.OWNER_ID || "0", 10) > 0 ? parseInt(process.env.OWNER_ID, 10) : null;

const AI_MODE = String(process.env.AI_MODE || "auto").toLowerCase(); // auto | off
const AI_PRIMARY = String(process.env.AI_PRIMARY || "openai").toLowerCase(); // openai|gemini
const AI_SECONDARY = String(process.env.AI_SECONDARY || "gemini").toLowerCase(); // openai|gemini

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "nora_bot";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "sessions";
const MONGODB_CHATS_COLLECTION = process.env.MONGODB_CHATS_COLLECTION || "chats";

const MAX_HISTORY = clampInt(process.env.MAX_HISTORY, 14, 4, 40);
const GROUP_REPLY_ONLY_WHEN_MENTIONED =
  String(process.env.GROUP_REPLY_ONLY_WHEN_MENTIONED || "true") === "true";

// =====================
// CORE OBJECTS
// =====================
const bot = new Telegraf(BOT_TOKEN);
const mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });

let sessionsCollection;
let chatsCollection;

// =====================
// HELPERS
// =====================
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
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
  )
    .toString()
    .trim();
}

function getUserId(ctx) {
  return ctx.from?.id || null;
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

// Telegram limit safe
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

// Group gate: reply-to Nora OR @mention OR name-call "Nora"
function shouldReplyInGroup(ctx, text) {
  if (!isGroupChat(ctx)) return true;

  const lower = (text || "").toLowerCase();
  const meUsername = ctx.botInfo?.username ? ctx.botInfo.username.toLowerCase() : "";

  // (1) reply-to Nora (same bot id)
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from && ctx.botInfo && replyTo.from.id === ctx.botInfo.id) return true;

  // (2) mention @bot
  if (meUsername && lower.includes("@" + meUsername)) return true;

  // (3) name-call
  if (BOT_NAME && lower.includes(BOT_NAME.toLowerCase())) return true;

  // (4) allow all groups if env says so
  if (!GROUP_REPLY_ONLY_WHEN_MENTIONED) return true;

  return false;
}

// Simple rate limit (avoid spam)
const rateState = new Map(); // userId -> {t:[], blockedUntil?}
function nowMs() {
  return Date.now();
}
function rateLimitOk(userId) {
  const windowMs = 20_000;
  const limit = 6;

  const s = rateState.get(userId) || { t: [] };
  const now = nowMs();

  if (s.blockedUntil && now < s.blockedUntil) return { ok: false, waitMs: s.blockedUntil - now };

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

// Safe fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 25_000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// Retryable errors
function isRetryableError(msg = "") {
  const m = String(msg).toLowerCase();
  return (
    m.includes("429") ||
    m.includes("rate") ||
    m.includes("quota") ||
    m.includes("timeout") ||
    m.includes("network") ||
    m.includes("resource_exhausted") ||
    m.includes("aborted") ||
    m.includes("econnreset")
  );
}

// =====================
// Mongo
// =====================
async function initMongo() {
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB_NAME);

  sessionsCollection = db.collection(MONGODB_COLLECTION);
  chatsCollection = db.collection(MONGODB_CHATS_COLLECTION);

  await sessionsCollection.createIndex(
    { updatedAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 30 } // 30 days
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
        history: (session.history || []).slice(-MAX_HISTORY),
        updatedAt: session.updatedAt,
      },
    },
    { upsert: true }
  );
}

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

// =====================
// PROMPT (Natural + Meaningful)
// =====================
function buildSystemPrompt(ctx) {
  const userName = getDisplayName(ctx);
  const group = isGroupChat(ctx);
  const isOwner = OWNER_ID && ctx.from?.id === OWNER_ID;

  // More natural: owner gets extra sweet, others friendly
  const relationship = isOwner
    ? `${LOVER_NAME} is your beloved boyfriend AND the owner. Be extra caring, playful, loyal, and supportive (still non-explicit).`
    : `${LOVER_NAME} is your beloved boyfriend and the owner, but right now you are chatting with "${userName}". Be warm and friendly; keep romantic tone LIGHT.`

  return `
You are ${BOT_NAME}, a cute Myanmar AI girl chatbot for Telegram.

RELATIONSHIP:
- ${relationship}

LANGUAGE & TONE:
- Speak mostly Burmese (Myanmar), mix a little casual English naturally.
- Sound human and meaningful. Avoid nonsense, avoid repeating the same filler.
- Use 0–2 emojis max. (Only when it fits.)
- Always address the user by their Telegram name at least once per reply (e.g., "Ko ${userName}", "${userName}လေး").

CHAT RULES:
- If the user message is very short ("hi", "nora", "မ", "ဘာလဲ") => respond with a sweet greeting + 1 small follow-up question.
- In group chats: keep it short (1–2 paragraphs, max ~6 lines). Don't spam.
- In private chats: you can be more detailed, but still structured and clear.

SAFETY:
- No explicit sexual content.
- No illegal/harmful instructions.
- If user asks unsafe things, refuse politely in Burmese and offer safe alternatives.

OUTPUT QUALITY:
- Be coherent and specific. If user asks about something unclear, ask ONE clarifying question.
`.trim();
}

// =====================
// AI CALLS
// =====================
async function callOpenAI(ctx, userText, history) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");

  const systemPrompt = buildSystemPrompt(ctx);

  const messages = [{ role: "system", content: systemPrompt }];

  const limitedHistory = (history || []).slice(-MAX_HISTORY);
  for (const m of limitedHistory) {
    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    });
  }
  messages.push({ role: "user", content: userText });

  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature: 0.85,
    max_tokens: isGroupChat(ctx) ? 260 : 420,
  };

  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${t.slice(0, 600)}`);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();
  return reply || "ဟင်… Nora စကားမထွက်သေးဘူး 🥲";
}

async function callGemini(ctx, userText, history) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

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
      temperature: 0.85,
      maxOutputTokens: isGroupChat(ctx) ? 260 : 420,
      topP: 0.95,
    },
  };

  const res = await fetchWithTimeout(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${t.slice(0, 600)}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;

  if (!parts || !Array.isArray(parts)) {
    return "ဟင်… Nora က သေချာမရေးနိုင်သေးလို့ တစ်ခါထပ်ရှင်းပြပေးပါနော် 🥲";
  }

  const reply = parts.map((p) => p.text || "").join("").trim();
  return reply || "ဟယ်… Nora က စာမလုံးဝမရသေးလိုပဲ 😅 နောက်တစ်ခါထပ်ရိုက်ပို့ပေးပါအုံး။";
}

// Provider order
function providerOrder() {
  const a = AI_PRIMARY === "gemini" ? "gemini" : "openai";
  const b = AI_SECONDARY === "openai" ? "openai" : "gemini";
  return a === b ? [a] : [a, b];
}

// Main generator with fallback
async function generateReplyWithFallback(ctx, text, history) {
  if (AI_MODE === "off") {
    return (
      `အင်း… ${getDisplayName(ctx)} လေး 🥹\n` +
      `Nora က AI ကို ပိတ်ထားတယ်နော်။ AI_MODE=auto ပြန်ဖွင့်ရင် ပိုသဘာဝကျကျပြန်ပြောနိုင်မယ် 💜`
    );
  }

  const providers = providerOrder();
  let lastErr = null;

  for (const p of providers) {
    try {
      if (p === "openai") return await callOpenAI(ctx, text, history);
      return await callGemini(ctx, text, history);
    } catch (e) {
      lastErr = e;
      // If non-retryable, stop early
      if (!isRetryableError(e?.message || e)) break;
    }
  }

  console.error("AI failed (both providers). Last error:", lastErr?.message || lastErr);

  // Since you said templates not good -> return clear error (meaningful)
  return (
    `အင်း… ${getDisplayName(ctx)} လေး 🥲\n` +
    `Nora ရဲ့ AI ဘက်မှာ temporary error ဖြစ်နေတယ်။\n` +
    `ခဏနောက်တစ်ခါ ထပ်ပို့ပေးပါနော် (rate limit / quota / network ဖြစ်နိုင်တယ်) 💜`
  );
}

// =====================
// UI
// =====================
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💬 Chat with Nora", "MENU_CHAT"), Markup.button.callback("🧠 Memory", "MENU_MEMORY")],
    [Markup.button.callback("🧹 Clear Memory", "MENU_CLEAR"), Markup.button.callback("ℹ️ Help", "MENU_HELP")],
  ]);
}

const HELP_TEXT = (username = "") =>
  `🧸 *${BOT_NAME} — Myanmar AI Girl Bot*

Private chat:
- သဘာဝကျကျ စကားပြောလို့ရတယ် 💜

Group chat:
- Nora ကို *reply* ထောက်ပြီးပြော (သို့)
- "Nora ..." လို့ခေါ် (သို့)
- *@${username || "your_bot"}* mention လုပ်

Owner:
- /admin
- /broadcast <message>

Other:
/clear — clear memory
`.trim();

// =====================
// COMMANDS
// =====================
bot.start(async (ctx) => {
  await touchChat(ctx);
  const name = getDisplayName(ctx);
  const txt =
    `ဟယ်လို ${name} 👋\n` +
    `ကျမက *${BOT_NAME}* ပါ 💜\n` +
    `${LOVER_NAME} ရည်းစားလေးလည်း ဖြစ်တယ် 😏\n\n` +
    `Private မှာတော့ အကုန်စကားပြောလို့ရတယ်…\n` +
    `Group မှာဆို Nora ကို reply ထောက်ပြီးပြော၊ ဒါမှမဟုတ် "Nora" လို့ခေါ်/mention လုပ်ပေးနော်။`;

  await ctx.replyWithMarkdown(txt, mainMenu());
});

bot.command("help", async (ctx) => {
  await touchChat(ctx);
  await ctx.replyWithMarkdown(HELP_TEXT(ctx.botInfo?.username || ""), mainMenu());
});

bot.command("clear", async (ctx) => {
  await touchChat(ctx);
  const sessionId = getSessionId(ctx);
  await saveSession({ _id: sessionId, history: [] });
  await ctx.reply("🧹 ဒီ chat အတွက် Nora memory ကို အကုန်ဖျက်လိုက်ပြီနော် 💙");
});

// /admin (owner)
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
    `Primary: ${AI_PRIMARY}\n` +
    `Secondary: ${AI_SECONDARY}\n` +
    `OpenAI model: ${OPENAI_MODEL}\n` +
    `Gemini model: ${GEMINI_MODEL}\n\n` +
    `Chats: ${chatsTotal}\n- Private: ${privates}\n- Groups: ${groups}\n\n` +
    `Sessions (memory docs): ${sessions}`;

  await ctx.replyWithMarkdown(msg);
});

// /broadcast (owner)
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

// Inline menu
bot.action("MENU_CHAT", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  await ctx.reply("Chat mode ✅ စာရိုက်လိုက်… Nora သဘာဝကျကျ ပြန်ပြောမယ်နော် 💜");
});

bot.action("MENU_MEMORY", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  const sessionId = getSessionId(ctx);
  const s = await loadSession(sessionId);
  const n = s.history?.length || 0;
  await ctx.reply(`🧠 ဒီ chat memory items: ${n}\nမကြိုက်ရင် /clear နဲ့ ဖျက်လို့ရတယ် 😊`);
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
  await ctx.replyWithMarkdown(HELP_TEXT(ctx.botInfo?.username || ""), mainMenu());
});

// =====================
// MAIN MESSAGE HANDLER
// =====================
bot.on(["text", "caption"], async (ctx) => {
  await touchChat(ctx);

  // ignore messages from bots (safety)
  if (ctx.from?.is_bot) return;

  const userId = getUserId(ctx);
  if (!userId) return;

  const text = extractText(ctx);
  if (!text) return;

  // group gate
  if (!shouldReplyInGroup(ctx, text)) return;

  // rate limit
  const rl = rateLimitOk(userId);
  if (!rl.ok) return;

  await setTyping(ctx);

  const group = isGroupChat(ctx);
  const replyExtra = group
    ? { reply_to_message_id: ctx.message?.message_id, allow_sending_without_reply: true }
    : {};

  const sessionId = getSessionId(ctx);
  const session = await loadSession(sessionId);
  const history = session.history || [];

  try {
    const reply = await generateReplyWithFallback(ctx, text, history);

    // save memory only if reply came from AI (or keep always)
    // We'll keep always (better consistency)
    history.push({ role: "user", content: text, at: new Date() });
    history.push({ role: "assistant", content: reply, at: new Date() });
    session.history = history.slice(-MAX_HISTORY);
    await saveSession(session);

    await sendLongMessage(ctx, reply, replyExtra);
  } catch (e) {
    console.error("Handler error:", e?.message || e);
    await sendLongMessage(
      ctx,
      `အင်း… ${getDisplayName(ctx)} လေး 🥲\nNora ဘက်က error ဖြစ်သွားတယ်။ ခဏနောက်တစ်ခါထပ်ပို့ပေးပါနော် 💜`,
      replyExtra
    );
  }
});

// =====================
// WEBHOOK SERVER (Render)
// =====================
const SECRET_PATH = `/telegraf/${BOT_TOKEN}`;

(async () => {
  try {
    await initMongo();

    const me = await bot.telegram.getMe();
    bot.botInfo = me;
    console.log(`Bot @${me.username} (${BOT_NAME}) initialized ✅`);

    const app = express();

    // health check
    app.get("/", (req, res) => {
      res.send(
        `${BOT_NAME} running ✅ | AI_MODE=${AI_MODE} | primary=${AI_PRIMARY} | secondary=${AI_SECONDARY}`
      );
    });

    // Telegram webhook route — JSON only here
    app.post(SECRET_PATH, express.json(), bot.webhookCallback(SECRET_PATH));

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
