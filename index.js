/**
 * Nora AI Girl Bot — FINAL (ARQ Luna ONLY) + MongoDB + Webhook (Render) + Admin Dashboard (Buttons)
 * ------------------------------------------------------------------------------------------------
 * ✅ Webhook correct mount (Render): app.post(SECRET_PATH, express.json(), bot.webhookCallback())
 * ✅ Group reply gate: reply-to bot OR @mention OR "Nora" name-call
 * ✅ Private: reply to everything
 * ✅ AI: ARQ Luna ONLY (X-API-KEY) + Myanmar-forcing prompt
 * ✅ /admin dashboard (owner only) + Users list + Groups list + Uptime (buttons + pagination)
 * ✅ /broadcast (owner only) + chat registry
 * ✅ Long message splitting (Telegram 4096 safe)
 *
 * Required ENV:
 * - BOT_TOKEN
 * - MONGODB_URI
 * - WEBHOOK_DOMAIN (e.g. https://your-service.onrender.com)
 * - OWNER_ID
 * - ARQ_API_KEY
 *
 * Optional ENV:
 * - ARQ_API_URL (default https://thearq.tech)
 * - BOT_NAME (default Nora)
 * - LOVER_NAME (default Bika)
 * - AI_MODE (auto|off) default auto
 * - MAX_HISTORY (default 14)
 * - GROUP_REPLY_ONLY_WHEN_MENTIONED (true|false) default true
 */

"use strict";

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

// Bot persona
const BOT_NAME = process.env.BOT_NAME || "Nora";
const LOVER_NAME = process.env.LOVER_NAME || "Bika";

const OWNER_ID =
  parseInt(process.env.OWNER_ID || "0", 10) > 0 ? parseInt(process.env.OWNER_ID, 10) : null;

// AI
const AI_MODE = String(process.env.AI_MODE || "auto").toLowerCase(); // auto | off

// ARQ Luna
const ARQ_API_KEY = process.env.ARQ_API_KEY || "";
const ARQ_API_URL = (process.env.ARQ_API_URL || "https://thearq.tech").replace(/\/+$/, "");

if (AI_MODE !== "off" && !ARQ_API_KEY) {
  throw new Error("Missing ARQ_API_KEY in .env (required for ARQ Luna AI)");
}

// Mongo
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "nora_bot";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "sessions";
const MONGODB_CHATS_COLLECTION = process.env.MONGODB_CHATS_COLLECTION || "chats";

// behavior
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

function isOwner(ctx) {
  return !!OWNER_ID && ctx.from?.id === OWNER_ID;
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

// Group gate: reply-to bot OR @mention OR name-call "Nora"
function shouldReplyInGroup(ctx, text) {
  if (!isGroupChat(ctx)) return true;

  const lower = (text || "").toLowerCase();
  const meUsername = ctx.botInfo?.username ? ctx.botInfo.username.toLowerCase() : "";

  // (1) reply-to bot
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
    m.includes("econnreset") ||
    m.includes("fetch failed")
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
// ARQ LUNA AI (Myanmar forcing)
// =====================
function buildArqPrompt(ctx, userText) {
  const userName = getDisplayName(ctx);
  const group = isGroupChat(ctx);
  const owner = OWNER_ID && ctx.from?.id === OWNER_ID;

  const style =
    (owner
      ? `သင့်ရည်းစား ${LOVER_NAME} (Owner) လေးနဲ့ စကားပြောနေတဲ့ Nora လို ပိုနွေးထွေးပြီး caring ဖြစ်ပါ။`
      : `မိမိကို "${userName}" လို့ခေါ်ပြီး နွေးထွေးဖော်ရွေကူညီပေးပါ။ Romantic tone ကို LIGHT ပဲထားပါ။`) +
    (group ? ` Group ထဲဆို တိုတိုတင်းတင်း (၈လိုင်းကျော်မကျော်) ပဲဖြေပါ။` : ` Private ထဲဆို အသေးစိတ်နည်းနည်းဖြေရပါမယ်။`);

  return [
    `အောက်က user message ကို "မြန်မာလိုပဲ" သဘာဝကျကျ ပြန်ဖြေပါ။`,
    `0–2 emoji ပဲသုံးပါ။`,
    `အဓိပ္ပါယ်ရှိအောင် တစ်ကြိမ်တည်းနဲ့ တိတိကျကျ ဖြေပါ။`,
    style,
    ``,
    `User: ${userText}`,
  ].join("\n");
}

async function callARQLuna(ctx, userText) {
  const userId = getUserId(ctx) || 0;
  const prompt = buildArqPrompt(ctx, userText);

  const url = `${ARQ_API_URL}/luna?query=${encodeURIComponent(prompt)}&id=${encodeURIComponent(userId)}`;

  const res = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: { "X-API-KEY": ARQ_API_KEY },
    },
    35_000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ARQ error ${res.status}: ${t.slice(0, 600)}`);
  }

  const data = await res.json().catch(() => ({}));
  const reply = String(data?.result || data?.response || data?.message || "").trim();
  return reply || "ဟင်… Nora စကားမထွက်သေးဘူး 🥲";
}

async function generateReply(ctx, text) {
  if (AI_MODE === "off") {
    return `အင်း… ${getDisplayName(ctx)} လေး 🥹\nNora က AI ကို ပိတ်ထားတယ်နော်။ပြန်ဖွင့်ရင် ပြန်ပြောနိုင်မယ် 💜`;
  }

  try {
    return await callARQLuna(ctx, text);
  } catch (e) {
    if (isRetryableError(e?.message || e)) {
      try {
        return await callARQLuna(ctx, text);
      } catch (_) {}
    }
    console.error("ARQ failed:", e?.message || e);
    return `အင်း… ${getDisplayName(ctx)} လေး 🥲\nNora ရဲ့ AI ဘက်မှာ temporary error ဖြစ်နေတယ်။\nနောက်တစ်ခါ ထပ်ပို့ပေးပါနော် 💜`;
  }
}

// =====================
// UI
// =====================
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
  `🧸 ${BOT_NAME} — Myanmar AI Girl Bot (ARQ Only)

Private chat:
- သဘာဝကျကျ စကားပြောလို့ရတယ် 💜

Group chat:
- Nora ကို reply ထောက်ပြီးပြော (သို့)
- "${BOT_NAME} ..." လို့ခေါ် (သို့)
- @${username || "your_bot"} mention လုပ်

Owner:
- /admin
- /broadcast <message>

Other:
/clear — clear memory`;

// =====================
// ADMIN UI (Uptime + Pagination) — NO MARKDOWN (avoid Telegram parse issues)
// =====================
const STARTED_AT = Date.now();

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${ss}s`);
  return parts.join(" ");
}

function adminMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("👤 Users List", "ADMIN_USERS:0"),
      Markup.button.callback("👥 Group List", "ADMIN_GROUPS:0"),
    ],
    [Markup.button.callback("⏱ Uptime", "ADMIN_UPTIME"), Markup.button.callback("🔄 Refresh", "ADMIN_REFRESH")],
  ]);
}

function pagerButtons(kind, page, hasPrev, hasNext) {
  const row = [];
  if (hasPrev) row.push(Markup.button.callback("⬅️ Prev", `ADMIN_${kind}:${page - 1}`));
  row.push(Markup.button.callback("🏠 Admin", "ADMIN_HOME"));
  if (hasNext) row.push(Markup.button.callback("Next ➡️", `ADMIN_${kind}:${page + 1}`));
  return Markup.inlineKeyboard([row]);
}

// =====================
// COMMANDS
// =====================
bot.start(async (ctx) => {
  await touchChat(ctx);
  const name = getDisplayName(ctx);
  const txt =
    `ဟယ်လို ${name} 👋\n` +
    `ကျမက ${BOT_NAME} ပါ 💜\n` +
    `${LOVER_NAME} က Nora ရည်းစားလေး ဖြစ်ပါတယ် 😏\n\n` +
    `Private မှာတော့ အကုန် ဆွေးနွေးတိုင်ပင် ရင်ဖွင့်လို့ရပါတယ်…\n` +
    `Group မှာဆို Nora ကို reply ထောက်ပြီးပြော၊ ဒါမှမဟုတ် "${BOT_NAME}" လို့ခေါ်/mention လုပ်ပေးနော်။`;

  await ctx.reply(txt, mainMenu());
});

bot.command("help", async (ctx) => {
  await touchChat(ctx);
  await ctx.reply(HELP_TEXT(ctx.botInfo?.username || ""), mainMenu());
});

bot.command("clear", async (ctx) => {
  await touchChat(ctx);
  const sessionId = getSessionId(ctx);
  await saveSession({ _id: sessionId, history: [] });
  await ctx.reply("🧹 ဒီ chat အတွက် Nora memory ကို အကုန်ဖျက်လိုက်ပြီနော် 💙");
});

// /admin (owner only) — NO MARKDOWN
bot.command("admin", async (ctx) => {
  await touchChat(ctx);

  if (!isOwner(ctx)) {
    return ctx.reply(`ဒီ command က ${LOVER_NAME} (Owner) လေးပဲ သုံးလို့ရမယ်နော် 😌`);
  }

  const chatsTotal = await chatsCollection.countDocuments({});
  const groups = await chatsCollection.countDocuments({ isGroup: true });
  const privates = await chatsCollection.countDocuments({ isGroup: false });
  const sessions = await sessionsCollection.countDocuments({});
  const uptime = formatUptime(Date.now() - STARTED_AT);

  const msg =
    `👑 ${BOT_NAME} Admin Dashboard\n\n` +
    `Owner: ${LOVER_NAME} (ID: ${OWNER_ID})\n` +
    `AI_MODE: ${AI_MODE}\n` +
    `ARQ_API_URL: ${ARQ_API_URL}\n` +
    `Uptime: ${uptime}\n\n` +
    `Chats: ${chatsTotal}\n` +
    `- Private: ${privates}\n` +
    `- Groups: ${groups}\n\n` +
    `Sessions (memory docs): ${sessions}\n\n` +
    `👇 အောက်က buttons နဲ့ စစ်လို့ရပါတယ်။`;

  await ctx.reply(msg, adminMenu());
});

// /broadcast (owner only) — NO MARKDOWN to avoid parse issues
bot.command("broadcast", async (ctx) => {
  await touchChat(ctx);

  if (!isOwner(ctx)) {
    return ctx.reply(`ဒီ command က ${LOVER_NAME} (Owner) လေးပဲ သုံးလို့ရမယ်နော် 😌`);
  }

  const raw = ctx.message?.text || "";
  const cleaned = raw.replace(/\/broadcast(@\w+)?/i, "").trim();

  if (!cleaned) {
    return ctx.reply("Broadcast စာကို ဒီလိုသုံးပါနော်:\n\n/broadcast မင်္ဂလာပါ Nora fan တွေ 🌸");
  }

  const message = `📢 ${BOT_NAME} Broadcast\n\n${cleaned}`;

  let sent = 0;
  let failed = 0;

  const cursor = chatsCollection.find({});
  while (await cursor.hasNext()) {
    const chat = await cursor.next();
    try {
      await bot.telegram.sendMessage(chat._id, message, { disable_web_page_preview: true });
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
  await ctx.reply(`🧠 ဒီ chat memory items: ${n}\nမကြိုက်ရင် ဖျက်လို့ရတယ် 😊`);
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
  await ctx.reply(HELP_TEXT(ctx.botInfo?.username || ""), mainMenu());
});

// =====================
// ADMIN BUTTON HANDLERS (NO MARKDOWN)
// =====================
async function sendAdminHome(ctx) {
  const chatsTotal = await chatsCollection.countDocuments({});
  const groups = await chatsCollection.countDocuments({ isGroup: true });
  const privates = await chatsCollection.countDocuments({ isGroup: false });
  const sessions = await sessionsCollection.countDocuments({});
  const uptime = formatUptime(Date.now() - STARTED_AT);

  const msg =
    `👑 ${BOT_NAME} Admin Dashboard\n\n` +
    `Owner: ${LOVER_NAME} (ID: ${OWNER_ID})\n` +
    `AI_MODE: ${AI_MODE}\n` +
    `ARQ_API_URL: ${ARQ_API_URL}\n` +
    `Uptime: ${uptime}\n\n` +
    `Chats: ${chatsTotal}\n` +
    `- Private: ${privates}\n` +
    `- Groups: ${groups}\n\n` +
    `Sessions (memory docs): ${sessions}\n\n` +
    `👇 အောက်က buttons နဲ့ စစ်လို့ရပါတယ်။`;

  try {
    await ctx.editMessageText(msg, adminMenu());
  } catch (_) {
    await ctx.reply(msg, adminMenu());
  }
}

async function sendList(ctx, isGroup, page = 0) {
  const limit = 20;
  const safePage = Math.max(0, page);
  const skip = safePage * limit;

  const q = { isGroup: !!isGroup };
  const total = await chatsCollection.countDocuments(q);

  const pages = Math.max(1, Math.ceil(total / limit));
  const p = Math.min(safePage, pages - 1);

  const items = await chatsCollection
    .find(q)
    .sort({ lastSeen: -1 })
    .skip(p * limit)
    .limit(limit)
    .toArray();

  const title = isGroup ? "👥 Group List" : "👤 Users List";
  const header = `${title}\nPage: ${p + 1}/${pages}\nTotal: ${total}\n`;

  const hasPrev = p > 0;
  const hasNext = (p + 1) * limit < total;
  const kb = pagerButtons(isGroup ? "GROUPS" : "USERS", p, hasPrev, hasNext);

  if (!items.length) {
    try {
      return await ctx.editMessageText(header + "\n(No data yet)", kb);
    } catch (_) {
      return await ctx.reply(header + "\n(No data yet)", kb);
    }
  }

  const lines = items.map((x, i) => {
    const idx = p * limit + i + 1;
    const name = String(x.title || "").replace(/\n/g, " ").trim() || (isGroup ? "(no title)" : "(unknown user)");
    const safeName = name.length > 44 ? name.slice(0, 44) + "…" : name;
    return `${idx}. ${safeName}\n   id: ${x._id}`;
  });

  const text = header + "\n" + lines.join("\n");

  try {
    await ctx.editMessageText(text, { disable_web_page_preview: true, ...kb });
  } catch (_) {
    await ctx.reply(text, { disable_web_page_preview: true, ...kb });
  }
}

bot.action("ADMIN_HOME", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  await touchChat(ctx);
  await sendAdminHome(ctx);
});

bot.action("ADMIN_REFRESH", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  await touchChat(ctx);
  await sendAdminHome(ctx);
});

bot.action("ADMIN_UPTIME", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  await touchChat(ctx);

  const uptime = formatUptime(Date.now() - STARTED_AT);
  const started = new Date(STARTED_AT).toISOString();

  const text =
    `⏱ Uptime\n\n` +
    `Uptime: ${uptime}\n` +
    `StartedAt (ISO): ${started}\n\n` +
    `Service restart ဖြစ်ရင် uptime ပြန် reset ဖြစ်မယ်နော်။`;

  const kb = Markup.inlineKeyboard([[Markup.button.callback("🏠 Admin", "ADMIN_HOME")]]);
  try {
    await ctx.editMessageText(text, kb);
  } catch (_) {
    await ctx.reply(text, kb);
  }
});

// Pagination handlers
bot.action(/^ADMIN_USERS:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  await touchChat(ctx);
  const page = parseInt(ctx.match?.[1] || "0", 10) || 0;
  await sendList(ctx, false, page);
});

bot.action(/^ADMIN_GROUPS:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  await touchChat(ctx);
  const page = parseInt(ctx.match?.[1] || "0", 10) || 0;
  await sendList(ctx, true, page);
});

// =====================
// MAIN MESSAGE HANDLER
// =====================
bot.on(["text", "caption"], async (ctx) => {
  await touchChat(ctx);

  // ignore messages from bots
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
    const reply = await generateReply(ctx, text);

    // save memory
    history.push({ role: "user", content: text, at: new Date() });
    history.push({ role: "assistant", content: reply, at: new Date() });
    session.history = history.slice(-MAX_HISTORY);
    await saveSession(session);

    await sendLongMessage(ctx, reply, replyExtra);
  } catch (e) {
    console.error("Handler error:", e?.message || e);
    await sendLongMessage(
      ctx,
      `အင်း… ${getDisplayName(ctx)} လေး 🥲\nNora ဘက်က error ဖြစ်သွားတယ်။ နောက်တစ်ခါထပ်ပို့ပေးပါနော် 💜`,
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
      res.send(`${BOT_NAME} running ✅ | AI_MODE=${AI_MODE} | ARQ_ONLY`);
    });

    // Telegram webhook route — JSON only here
    app.post(SECRET_PATH, express.json({ limit: "2mb" }), bot.webhookCallback(SECRET_PATH));

    const PORT = parseInt(process.env.PORT || "10000", 10);
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
