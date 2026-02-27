/**
 * Nora AI Girl Bot — Gemini + MongoDB + Telegram
 * ----------------------------------------------
 * ✅ Gemini API (Google AI Studio) — generateContent
 * ✅ MongoDB — per-user chat history (memory)
 * ✅ Private + Group (mention / reply only)
 * ✅ Myanmar natural talk girl persona (Nora, Bika is boyfriend)
 * ✅ Rate limit + basic error handling
 *
 * Required ENV:
 *  - BOT_TOKEN
 *  - GEMINI_API_KEY
 *  - MONGODB_URI
 *  - MONGODB_DB_NAME (optional: default nora_bot)
 *  - MONGODB_COLLECTION (optional: default sessions)
 *  - BOT_NAME (default "Nora")
 *  - LOVER_NAME (default "Bika")
 *  - MAX_HISTORY (default 16)
 *  - GROUP_REPLY_ONLY_WHEN_MENTIONED (true/false, default true)
 */

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { MongoClient } = require("mongodb");

// ========= ENV & CONSTANTS =========

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "nora_bot";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "sessions";

const BOT_NAME = process.env.BOT_NAME || "Nora";
const LOVER_NAME = process.env.LOVER_NAME || "Bika";

const MAX_HISTORY = clampInt(process.env.MAX_HISTORY, 16, 4, 40);
const GROUP_REPLY_ONLY_WHEN_MENTIONED =
  String(process.env.GROUP_REPLY_ONLY_WHEN_MENTIONED || "true") === "true";

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in .env");

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const bot = new Telegraf(BOT_TOKEN);

// ========= MONGO SETUP =========

const mongoClient = new MongoClient(MONGODB_URI, {
  maxPoolSize: 10,
});

let sessionsCollection;

/**
 * Connect MongoDB & init collection
 */
async function initMongo() {
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB_NAME);
  sessionsCollection = db.collection(MONGODB_COLLECTION);
  await sessionsCollection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }); // optional TTL 30 days
  console.log("MongoDB connected ✅");
}

// ========= SMALL HELPERS =========

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

function shouldReplyInGroup(ctx, text) {
  if (!isGroupChat(ctx)) return true;
  if (!GROUP_REPLY_ONLY_WHEN_MENTIONED) return true;

  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from && replyTo.from.is_bot) return true;

  const me = ctx.botInfo?.username;
  if (me && text.includes("@" + me)) return true;

  if (text.startsWith("/")) {
    if (!me) return true;
    if (text.includes("@" + me)) return true;
  }

  return false;
}

async function setTyping(ctx) {
  try {
    await ctx.sendChatAction("typing");
  } catch (_) {}
}

// ===== Rate Limit (in-memory simple) =====

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

// ===== Sessions (MongoDB) =====

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

// ========= Gemini Prompt & Call =========

function buildSystemPrompt(ctx) {
  const userName = getDisplayName(ctx);
  const group = isGroupChat(ctx);

  return `
You are ${BOT_NAME}, a cute, natural-talking Myanmar girl chatbot.
${LOVER_NAME} is your boyfriend. You care about him and tease him a little.

Style:
- Talk mostly in Burmese (Myanmar), mix a little casual English.
- Tone: warm, playful, friendly big-sis/girlfriend style, but respectful.
- Use emojis lightly (0–3) like 😄🥹✨.
- In group chats, keep replies short (1–3 short paragraphs).
- In private chats, you can talk a bit more, but still concise (max 6 short paragraphs).
- Call the user "${userName}" or "ko" / "nway" etc. naturally depending on context.

Safety:
- Do NOT produce explicit sexual content, pornographic detail, gore, self-harm instructions, or illegal hacking/violence.
- If the user asks for something unsafe, gently refuse in Burmese and suggest safe topics instead.

Context:
- Current chat is a ${group ? "group chat" : "private chat"}.
- If user mentions ${LOVER_NAME}, you can respond like a real girlfriend jokingly.
- Feel free to ask a small follow-up question sometimes to keep the conversation alive.
`.trim();
}

async function callGemini(ctx, userText, history) {
  const systemPrompt = buildSystemPrompt(ctx);

  // Convert our history to Gemini "contents"
  const contents = [];

  const limitedHistory = history.slice(-MAX_HISTORY);

  for (const m of limitedHistory) {
    const role = m.role === "assistant" ? "model" : "user";
    contents.push({
      role,
      parts: [{ text: m.content }],
    });
  }

  contents.push({
    role: "user",
    parts: [{ text: userText }],
  });

  const body = {
    contents,
    systemInstruction: {
      role: "system",
      parts: [{ text: systemPrompt }],
    },
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 380,
      topP: 0.95,
    },
  };

  const res = await fetch(GEMINI_ENDPOINT + `?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = await res.json();

  const cand = (data.candidates && data.candidates[0]) || null;
  if (!cand || !cand.content || !cand.content.parts) {
    return "ဟင်… Nora မသေချာသေးလို့ နည်းနည်းပြီးထပ်ရှင်းပြပေးပါနော် 🥲";
  }

  const reply = cand.content.parts
    .map((p) => p.text || "")
    .join("")
    .trim();

  return reply || "ဟယ်… စာမရသေးလိုပဲ ရေးပြီးပြန်ပို့ပေးပါအုံး 😅";
}

// ========= UI HELPERS =========

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

const HELP_TEXT = (botUsername = "") =>
  `🧸 *${BOT_NAME} — Myanmar AI Girl Bot*

Private chat:
- စာရိုက်လိုက်တာနဲ့ Nora ပြန်ဖြေမယ်

Group chat:
- Nora ကို reply လုပ်ပါ (သို့)
- *@${botUsername || "your_bot"}* လို့ mention လုပ်ပါ

Commands:
/start — Main menu
/help — How to use
/clear — Memory clear (this chat only)
`.trim();

// ========= COMMAND HANDLERS =========

bot.start(async (ctx) => {
  const name = getDisplayName(ctx);
  const text = `ဟယ်လို ${name} 👋  
ကျမက *${BOT_NAME}* ပါ ✨  
${LOVER_NAME} ရည်းစားလေးလည်း ဖြစ်တယ် 😏

Private Chat မှာတော့ စိတ်ကူးသလို စကားပြောလို့ရတယ်…
Group မှာဆိုရင် *@${ctx.botInfo.username}* ကို mention လုပ်ရင် ပြန်ဖြေမယ်နော် 💬`;

  await ctx.replyWithMarkdown(text, mainMenu());
});

bot.command("help", async (ctx) => {
  const h = HELP_TEXT(ctx.botInfo?.username || "");
  await ctx.replyWithMarkdown(h, mainMenu());
});

bot.command("clear", async (ctx) => {
  const sessionId = getSessionId(ctx);
  await saveSession({ _id: sessionId, history: [] });
  await ctx.reply("🧹 Memory ကို ဒီ chat အတွက် အကုန်ဖျက်လိုက်ပြီနော် 💙");
});

// ===== Inline menu actions =====

bot.action("MENU_CHAT", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Chat mode ✅ စာရိုက်လိုက်ရင် Nora က စိတ်တိုင်းမကျအောင် ပြန်ဖြေမယ်နော် 😌");
});

bot.action("MENU_MEMORY", async (ctx) => {
  await ctx.answerCbQuery();
  const sessionId = getSessionId(ctx);
  const s = await loadSession(sessionId);
  const n = s.history?.length || 0;
  await ctx.reply(`🧠 ဒီ chat အတွက် memory items ${n} ခုရှိတယ်နော်\n\nမနစ်နာချင်ရင် /clear နဲ့ ဖျက်လို့ရတယ် 😊`);
});

bot.action("MENU_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  const sessionId = getSessionId(ctx);
  await saveSession({ _id: sessionId, history: [] });
  await ctx.reply("OK နော် 🧹 Memory ကို ဖျက်ပေးထားမယ်");
});

bot.action("MENU_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  const h = HELP_TEXT(ctx.botInfo?.username || "");
  await ctx.replyWithMarkdown(h, mainMenu());
});

// ========= MAIN MESSAGE HANDLER =========

bot.on(["text", "caption"], async (ctx) => {
  const userId = getUserId(ctx);
  if (!userId) return;

  const text = extractText(ctx);
  if (!text) return;

  if (!shouldReplyInGroup(ctx, text)) return;

  const rl = rateLimitOk(userId);
  if (!rl.ok) {
    return ctx.reply("နည်းနည်းတစ်ဝက် အေးအေးနေပေးမယ်နော် 😅 ပြန်မေးမယ့်အခါ Nora အဆင်သင့်နေမယ်");
  }

  await setTyping(ctx);

  const sessionId = getSessionId(ctx);
  const session = await loadSession(sessionId);
  const history = session.history || [];

  try {
    const reply = await callGemini(ctx, text, history);

    // update history & save
    history.push({ role: "user", content: text, at: new Date() });
    history.push({ role: "assistant", content: reply, at: new Date() });

    session.history = history.slice(-MAX_HISTORY);
    await saveSession(session);

    await ctx.reply(reply, { disable_web_page_preview: true });
  } catch (err) {
    console.error("Gemini call error:", err?.message || err);
    await ctx.reply(
      "အင်း… Nora ဘက်က error နည်းနည်းဖြစ်သွားတယ် 🥲\nအချို့အချိန်မှာ network ထပ်စမ်းရင် ပြန်အလုပ်လုပ်လာမယ်…"
    );
  }
});

// ========= STARTUP =========

(async () => {
  try {
    await initMongo();
    await bot.launch();
    console.log(`🤖 ${BOT_NAME} started with Gemini + MongoDB ✅`);
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();

// Graceful stop (Render/Railway friendly)
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
