// Nora AI Girl Bot — Gemini + MongoDB + Webhook (Render friendly)
// ---------------------------------------------------------------

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

const OWNER_ID =
  parseInt(process.env.OWNER_ID || "0", 10) &&
  parseInt(process.env.OWNER_ID || "0", 10) > 0
    ? parseInt(process.env.OWNER_ID, 10)
    : null;

const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "nora_bot";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "sessions";
const MONGODB_CHATS_COLLECTION =
  process.env.MONGODB_CHATS_COLLECTION || "chats";

const MAX_HISTORY = clampInt(process.env.MAX_HISTORY, 16, 4, 40);
const GROUP_REPLY_ONLY_WHEN_MENTIONED =
  String(process.env.GROUP_REPLY_ONLY_WHEN_MENTIONED || "true") === "true";

const WEBHOOK_DOMAIN = (process.env.WEBHOOK_DOMAIN || "").replace(/\/+$/, ""); // no trailing slash

// ===== GEMINI CONFIG =====
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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

// group reply logic: mention @username OR say "Nora"
function shouldReplyInGroup(ctx, text) {
  if (!isGroupChat(ctx)) return true;

  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from && replyTo.from.is_bot) return true;

  const me = ctx.botInfo?.username;
  const lower = (text || "").toLowerCase();

  // 1) mention
  if (me && lower.includes("@" + me.toLowerCase())) return true;

  // 2) name call: "nora"
  if (BOT_NAME && lower.includes(BOT_NAME.toLowerCase())) return true;

  // 3) config allow all
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

// ===== Mongo Sessions / Chats =====
async function initMongo() {
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB_NAME);
  sessionsCollection = db.collection(MONGODB_COLLECTION);
  chatsCollection = db.collection(MONGODB_CHATS_COLLECTION);

  await sessionsCollection.createIndex(
    { updatedAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 30 }
  ); // 30 days TTL

  await chatsCollection.createIndex({ lastSeen: 1 });
  console.log("MongoDB connected ✅");
}

function getSessionId(ctx) {
  const uid = getUserId(ctx);
  const cid = ctx.chat?.id;
  return `${cid}:${uid}`;
}

async function loadSession(sessionId) {
  if (!sessionsCollection) return { _id: sessionId, history: [] };
  const doc = await sessionsCollection.findOne({ _id: sessionId });
  if (!doc) return { _id: sessionId, history: [] };
  doc.history = doc.history || [];
  return doc;
}

async function saveSession(session) {
  if (!sessionsCollection) return;
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

// chat list for /broadcast
async function touchChat(ctx) {
  if (!chatsCollection) return;
  const chat = ctx.chat;
  if (!chat || !chat.id) return;

  const isGroup = chat.type === "group" || chat.type === "supergroup";
  let title = chat.title || "";

  if (!isGroup) {
    // private chat — use user name
    title = getDisplayName(ctx);
  }

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

// ===== LONG MESSAGE SENDER (avoid Telegram 4096 cut) =====
const TELEGRAM_LIMIT = 3900; // little lower than 4096 for safety

async function sendLongMessage(ctx, text, extra = {}) {
  if (!text) return;
  let remaining = text.toString();

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_LIMIT) {
      await ctx.reply(remaining, {
        disable_web_page_preview: true,
        ...extra,
      });
      break;
    }

    let sliceIndex = remaining.lastIndexOf("\n\n", TELEGRAM_LIMIT);
    if (sliceIndex === -1) sliceIndex = remaining.lastIndexOf("\n", TELEGRAM_LIMIT);
    if (sliceIndex === -1) sliceIndex = remaining.lastIndexOf(" ", TELEGRAM_LIMIT);
    if (sliceIndex === -1) sliceIndex = TELEGRAM_LIMIT;

    const chunk = remaining.slice(0, sliceIndex).trimEnd();
    remaining = remaining.slice(sliceIndex).trimStart();

    if (chunk.length > 0) {
      await ctx.reply(chunk, {
        disable_web_page_preview: true,
        ...extra,
      });
    }
  }
}

// ===== Gemini =====
function buildSystemPrompt(ctx) {
  const userName = getDisplayName(ctx);
  const isGroup = isGroupChat(ctx);
  const isOwner = OWNER_ID && ctx.from && ctx.from.id === OWNER_ID;

  const relationshipLine = isOwner
    ? `${LOVER_NAME} (the current user) is your beloved boyfriend and the owner of this bot. Treat him extra sweet and caring, but still safe and non-explicit.`
    : `${LOVER_NAME} is your beloved boyfriend and also the owner of this bot, but right now you are chatting with "${userName}". Be friendly and warm, but keep romantic tone lighter than with ${LOVER_NAME}.`;

  return `
You are ${BOT_NAME}, a cute Myanmar AI girl chatbot.

${relationshipLine}

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
  const isGroup = isGroupChat(ctx);

  const contents = [];
  const limitedHistory = history.slice(-MAX_HISTORY);

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
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: isGroup ? 260 : 380, // group မှာအဖြေတိုအောင်
      topP: 0.95,
    },
  };

  const res = await fetch(
    `${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = await res.json();
  const cand = (data.candidates && data.candidates[0]) || null;
  if (!cand || !cand.content || !cand.content.parts) {
    return "ဟင်… Nora က သေချာမရေးနိုင်သေးလို့ တစ်ခါထပ်ရှင်းပြပေးပါနော်";
  }

  const reply = cand.content.parts
    .map((p) => p.text || "")
    .join("")
    .trim();

  return (
    reply ||
    "ဟယ်… Nora က စာမလုံးဝလက်ခံမရရှိသေးဘူးလို့ပဲ ထင်တယ် 😅 နောက်တစ်ခါ ထပ်ရိုက်ပို့ပေးပါအုံး။"
  );
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

Private chat:
- စိတ်ကူးယဉ်ရည်းစားလို စကားပြောလို့ရတယ် 💙

Group chat:
- "Nora ..." လို့ နာမည်ခေါ်မယ် (သို့)
- *@${username || "your_bot"}* လို့ mention လိုက်ရင် ပြန်ဖြေမယ်

Commands:
/start — Main menu
/help — How to use
/clear — Clear memory (this chat only)
/admin — Admin dashboard (owner only)
/broadcast — Message to all chats (owner only)
`.trim();

// /start
bot.start(async (ctx) => {
  await touchChat(ctx);
  const name = getDisplayName(ctx);
  const txt = `ဟယ်လို ${name} 👋  
ကျမက *${BOT_NAME}* ပါ 💜  
${LOVER_NAME} ရည်းစားလေးလည်း ဖြစ်တယ် 😏

Private chat မှာတော့ စိတ်တိုင်းမကျမလား စကားပြောလို့ရတယ်…
Group မှာဆိုရင် "Nora" လို့နာမည်ခေါ်ပေးမယ်၊ ဒါမှမဟုတ် *@${ctx.botInfo.username}* ကို mention လုပ်ပေးရင် ပြန်ဖြေပေးမယ်နော်။`;

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
    return ctx.reply(
      `ဒီ command က ${LOVER_NAME} (Owner) လေးက ပဲ သုံးလို့ရမယ်နော် 😌`
    );
  }

  const totalChats = await chatsCollection.countDocuments({});
  const privateChats = await chatsCollection.countDocuments({ isGroup: false });
  const groupChats = await chatsCollection.countDocuments({ isGroup: true });
  const sessionsCount = await sessionsCollection.countDocuments({});

  const msg =
    `👑 *${BOT_NAME} Admin Dashboard*\n\n` +
    `Owner: ${LOVER_NAME} (ID: ${OWNER_ID})\n\n` +
    `Chats: ${totalChats}\n` +
    `- Private: ${privateChats}\n` +
    `- Groups: ${groupChats}\n\n` +
    `Memory docs (sessions): ${sessionsCount}`;

  await ctx.replyWithMarkdown(msg);
});

// /broadcast — owner only
bot.command("broadcast", async (ctx) => {
  await touchChat(ctx);

  if (!OWNER_ID || ctx.from?.id !== OWNER_ID) {
    return ctx.reply(
      `ဒီ command က ${LOVER_NAME} (Owner) လေးပဲ သုံးလို့ရမယ်နော် 😌`
    );
  }

  const raw = ctx.message?.text || "";
  const cleaned = raw.replace(/\/broadcast(@\w+)?/i, "").trim();

  if (!cleaned) {
    return ctx.reply(
      "Broadcast စာကို `/broadcast` အောက်ကလို သုံးပါနော်:\n\n" +
        "/broadcast မင်္ဂလာပါ Nora fan တွေ 🌸"
    );
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
    } catch (err) {
      failed++;
    }
  }

  await ctx.reply(
    `Broadcast ပြီးပါပြီ ✅\n\nပို့နိုင်သမျှ: ${sent}\nပျက်သွားသမျှ: ${failed}`
  );
});

// Inline menu actions
bot.action("MENU_CHAT", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  await ctx.reply(
    "Chat mode ✅ စိတ်ပါထဲမှာ ပါတာနဲ့ပဲ ရိုက်ပို့လိုက်… Nora က နာမည်ခေါ်ပြီး ပြန်စကားပြောမယ်နော် 😌"
  );
});

bot.action("MENU_MEMORY", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  const sessionId = getSessionId(ctx);
  const s = await loadSession(sessionId);
  const n = s.history?.length || 0;
  await ctx.reply(
    `🧠 ဒီ chat အတွက် Memory items ${n} ခုရှိနေတယ်\nမကြိုက်ရင် /clear နဲ့ ဖျက်လို့ရတယ် 😊`
  );
});

bot.action("MENU_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  await touchChat(ctx);
  const sessionId = getSessionId(ctx);
  await saveSession({ _id: sessionId, history: [] });
  await ctx.reply("OK နော် 🧹 Memory ကို ဖျက်ပေးထားတယ်");
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

  if (!shouldReplyInGroup(ctx, text)) return;

  const rl = rateLimitOk(userId);
  if (!rl.ok) {
    return ctx.reply(
      "နည်းနည်းအေးအေးနားပေးမယ်နော် 😅 နောက်ထပ်မေးချင်ရင် Nora ပြန်ဖြေမယ်"
    );
  }

  await setTyping(ctx);

  const sessionId = getSessionId(ctx);
  const session = await loadSession(sessionId);
  const history = session.history || [];

  const isGroup = isGroupChat(ctx);

  try {
    // Group chat မှာတော့ history မပါပဲ ယနေ့ message တစ်ခုပဲ သုံးမယ်
    const historyForModel = isGroup ? [] : history;
    const reply = await callGemini(ctx, text, historyForModel);

    // memory ကို private chat မှာပဲသိမ်းမယ်
    if (!isGroup) {
      history.push({ role: "user", content: text, at: new Date() });
      history.push({ role: "assistant", content: reply, at: new Date() });
      session.history = history.slice(-MAX_HISTORY);
      await saveSession(session);
    }

    await sendLongMessage(ctx, reply);
  } catch (e) {
    console.error("Gemini error:", e?.message || e);
    await ctx.reply(
      "အင်း… Nora ဘက်က error နည်းနည်းဖြစ်သွားတယ် 🥲\nNetwork ပြန်မြင့်ရင် နောက်တစ်ခါထပ်စမ်းပေးပါနော်။"
    );
  }
});

// ===== WEBHOOK SERVER (Render) =====
const SECRET_PATH = `/telegraf/${BOT_TOKEN}`; // random enough

(async () => {
  try {
    await initMongo();

    const me = await bot.telegram.getMe();
    bot.botInfo = me;
    console.log(`Bot @${me.username} (${BOT_NAME}) initialized ✅`);

  const app = express();
    app.use(express.json());

    // Health check
    app.get("/", (req, res) => {
      res.send(`${BOT_NAME} Gemini bot is running 💜`);
    });

    // Telegraf webhook middleware
    app.use(bot.webhookCallback(SECRET_PATH));

    const PORT = process.env.PORT || 10000;
    app.listen(PORT, async () => {
      console.log(`HTTP server listening on port ${PORT} ✅`);

      if (!WEBHOOK_DOMAIN) {
        console.warn(
          "WEBHOOK_DOMAIN not set in .env — please configure it so Telegram can reach your bot."
        );
        return;
      }

      const hookUrl = WEBHOOK_DOMAIN + SECRET_PATH;
      try {
        await bot.telegram.setWebhook(hookUrl);
        console.log(`Webhook set to ${hookUrl} ✅`);
      } catch (err) {
        console.error("Failed to set webhook:", err?.message || err);
      }
    });
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();

// no bot.launch() in webhook mode
