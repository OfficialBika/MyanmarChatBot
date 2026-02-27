// Nora AI Girl Bot — Gemini + MongoDB + Webhook (Render friendly) — FINAL (Meaningful Version)
// ------------------------------------------------------------------------------------------
// ✅ Keep original meaningful prompt + generation settings
// ✅ Fix webhook mounting for Render
// ✅ Fix JS "try:" typo
// ✅ Add long message splitter to avoid Telegram 4096 cut
// ✅ Group: reply ONLY if (reply to Nora) OR (mention @bot) OR (name-call "Nora")
// ✅ Mongo memory: keeps per chat-user session (same as your old version)

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

const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "nora_bot";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "sessions";

const MAX_HISTORY = clampInt(process.env.MAX_HISTORY, 16, 4, 40);
const GROUP_REPLY_ONLY_WHEN_MENTIONED =
  String(process.env.GROUP_REPLY_ONLY_WHEN_MENTIONED || "true") === "true";

const WEBHOOK_DOMAIN = (process.env.WEBHOOK_DOMAIN || "").replace(/\/+$/, ""); // no trailing slash

// ===== GEMINI CONFIG =====
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ===== CORE OBJECTS =====
const bot = new Telegraf(BOT_TOKEN);

const mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });
let sessionsCollection;

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
const TELEGRAM_LIMIT = 3900; // safe margin

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

// == GROUP reply logic: Reply to Nora OR mention @username OR say "Nora" ==
function shouldReplyInGroup(ctx, text) {
  if (!isGroupChat(ctx)) return true;

  const lower = (text || "").toLowerCase();
  const me = ctx.botInfo?.username;

  // (1) Reply to Nora message ONLY (not other bots)
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from && ctx.botInfo && replyTo.from.id === ctx.botInfo.id) return true;

  // (2) Mention @botusername
  if (me && lower.includes("@" + me.toLowerCase())) return true;

  // (3) Name call: "Nora"
  if (BOT_NAME && lower.includes(BOT_NAME.toLowerCase())) return true;

  // (4) If env allows all (not recommended)
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

// ===== Mongo Sessions =====
async function initMongo() {
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB_NAME);
  sessionsCollection = db.collection(MONGODB_COLLECTION);
  await sessionsCollection.createIndex(
    { updatedAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 30 }
  ); // 30 days TTL
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
    systemInstruction: {
      role: "system",
      parts: [{ text: systemPrompt }],
    },
    // keep your original settings (meaningful)
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 380,
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
    [
      Markup.button.callback("💬 Chat with Nora", "MENU_CHAT"),
      Markup.button.callback("🧠 Memory", "MENU_MEMORY"),
    ],
    [
      Markup.button.callback("🧹 Clear Memory", "MENU_CLEAR"),
      Markup.button.callback("ℹ️ Help", "MENU_HELP"),
    ],
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
`.trim();

bot.start(async (ctx) => {
  const name = getDisplayName(ctx);
  const txt = `ဟယ်လို ${name} 👋  
ကျမက *${BOT_NAME}* ပါ 💜  
${LOVER_NAME} ရည်းစားလေးလည်း ဖြစ်တယ် 😏

Group မှာတော့ Nora ကို reply ထောက်ပြီးပြော၊ ဒါမှမဟုတ် "Nora ..." လို့ခေါ်ပေးနော်။`;

  await ctx.replyWithMarkdown(txt, mainMenu());
});

bot.command("help", async (ctx) => {
  const h = HELP_TEXT(ctx.botInfo?.username || "");
  await ctx.replyWithMarkdown(h, mainMenu());
});

bot.command("clear", async (ctx) => {
  const sessionId = getSessionId(ctx);
  await saveSession({ _id: sessionId, history: [] });
  await ctx.reply("🧹 ဒီ chat အတွက် Nora memory ကို အကုန်ဖျက်လိုက်ပြီနော် 💙");
});

bot.action("MENU_CHAT", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Chat mode ✅ စာရိုက်လိုက်… Nora ပြန်ဖြေမယ်နော် 😌");
});

bot.action("MENU_MEMORY", async (ctx) => {
  await ctx.answerCbQuery();
  const sessionId = getSessionId(ctx);
  const s = await loadSession(sessionId);
  const n = s.history?.length || 0;
  await ctx.reply(`🧠 ဒီ chat memory items: ${n}`);
});

bot.action("MENU_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  const sessionId = getSessionId(ctx);
  await saveSession({ _id: sessionId, history: [] });
  await ctx.reply("OK နော် 🧹 Memory cleared ✅");
});

bot.action("MENU_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  const h = HELP_TEXT(ctx.botInfo?.username || "");
  await ctx.replyWithMarkdown(h, mainMenu());
});

// ===== MAIN MESSAGE HANDLER =====
bot.on(["text", "caption"], async (ctx) => {
  const userId = getUserId(ctx);
  if (!userId) return;

  const text = extractText(ctx);
  if (!text) return;

  if (!shouldReplyInGroup(ctx, text)) return;

  const rl = rateLimitOk(userId);
  if (!rl.ok) return;

  await setTyping(ctx);

  const sessionId = getSessionId(ctx);
  const session = await loadSession(sessionId);
  const history = session.history || [];

  try {
    const reply = await callGemini(ctx, text, history);

    // Save memory (same behavior as your old version)
    history.push({ role: "user", content: text, at: new Date() });
    history.push({ role: "assistant", content: reply, at: new Date() });
    session.history = history.slice(-MAX_HISTORY);
    await saveSession(session);

    // Send safely (no cut)
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
    // Init DB
    await initMongo();

    // Load bot info
    const me = await bot.telegram.getMe();
    bot.botInfo = me;
    console.log(`Bot @${me.username} (${BOT_NAME}) initialized ✅`);

    const app = express();
    app.use(express.json());

    // Health check
    app.get("/", (req, res) => {
      res.send(`${BOT_NAME} Gemini bot is running 💜`);
    });

    // ✅ Correct webhook mounting (no path arg)
    app.use(bot.webhookCallback(SECRET_PATH));

    const PORT = process.env.PORT || 10000;
    app.listen(PORT, async () => {
      console.log(`HTTP server listening on port ${PORT} ✅`);

      if (!WEBHOOK_DOMAIN) {
        console.warn("WEBHOOK_DOMAIN not set in .env — please set it for Telegram webhook.");
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
