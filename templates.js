/**
 * templates.js — Nora Smart Template Pack (FINAL)
 * ---------------------------------------------------------
 * ✅ flirt-lite replies, daily greeting, nicknames
 * ✅ group vs private tone split
 * ✅ MLBB FULL dataset support (heroes/items/emblems) from /data/*.txt|*.json
 *
 * Required files (repo):
 *   /templates.js
 *   /data/hero-meta-final.txt
 *   /data/item-meta-final.txt
 *   /data/emblem-meta-final.txt
 *
 * Usage in index.js:
 *   const { templateReply } = require("./templates");
 *   const msg = templateReply(text, { userName: getDisplayName(ctx), isGroup: isGroupChat(ctx) });
 */

const fs = require("fs");
const path = require("path");

// =========================
// BASIC VIBE UTILITIES
// =========================

const EMOJI = [
  "😄",
  "🥹",
  "✨",
  "💜",
  "😏",
  "🙈",
  "🤍",
  "😋",
  "😌",
  "🫶",
  "🌙",
  "🌸",
  "🔥",
  "🧸",
  "🪽",
  "🌿",
  "💫",
];
const FILLERS = ["ဟီး", "အင်း", "ဟယ်", "အိုကေ", "အေး", "ညှင်း", "ဟုတ်", "အိုး", "အာ", "အင်းနော်"];
const SOFT_END = ["နော်", "လား", "ပါဦး", "အုံး", "ပေါ့", "နဲ့", "နော်ဗျာ", "နော်ဟာ", "အိုကေပါ"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function maybe(p = 0.35) {
  return Math.random() < p;
}

function vibePrefix() {
  return maybe(0.45) ? `${pick(FILLERS)}… ` : "";
}
function vibeEnd() {
  return maybe(0.35) ? ` ${pick(SOFT_END)}` : "";
}
function vibeEmoji(max = 2) {
  if (!maybe(0.65)) return "";
  const c = 1 + Math.floor(Math.random() * max);
  let e = "";
  for (let i = 0; i < c; i++) e += pick(EMOJI);
  return " " + e;
}

function normText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hour() {
  return new Date().getHours();
}
function timeGreeting() {
  const h = hour();
  if (h >= 5 && h < 11) return "မနက်ခင်း";
  if (h >= 11 && h < 16) return "နေ့လယ်";
  if (h >= 16 && h < 20) return "ညနေ";
  return "ည";
}

// ----- name + nicknames -----
const NICKNAMES = [
  "ချစ်လေး",
  "လက်စွဲလေး",
  "မိန်းမိန်းလေး",
  "မောင်လေး",
  "အချစ်တော်",
  "တော်တော်လေး",
  "ပျော်ပျော်လေး",
  "အေးအေးလေး",
  "လှလှလေး",
  "cute လေး",
  "ချောချောလေး",
  "ဘော်ဒါလေး",
  "အချစ်လေး",
  "sweetie",
];

function addressName(userName, isGroup) {
  const n = (userName || "friend").trim();
  const base = isGroup ? pick([`${n} ရေ`, `${n} လေး`, `Ko ${n}`]) : pick([`Ko ${n}`, `${n} လေး`, `${n} ရေ`, `${n} ကို`, `${n} နော်`]);
  if (!isGroup && maybe(0.55)) return `${base} (${pick(NICKNAMES)})`;
  return base;
}

function oneQuestion() {
  return pick([
    "ဘာလုပ်နေတာလဲ?",
    "ဒီနေ့ mood ဘယ်လိုလဲ?",
    "စားပြီးပြီလား?",
    "အဆင်ပြေလား?",
    "ဘာကူညီပေးရမလဲ?",
    "အကြောင်းအရာကို နည်းနည်းထပ်ပြောပေးပါဦး?",
    "MLBB ဆော့နေတာလား? main role ဘာလဲ?",
  ]);
}

// =========================
// MLBB DATASET LOADER
// =========================

let MLBB_DATA = { heroes: [], items: [], emblems: [] };

function safeReadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function readFirstExistingJSON(paths) {
  for (const p of paths) {
    const data = safeReadJSON(p);
    if (data) return data;
  }
  return null;
}

function loadMlbbData() {
  const base = path.join(__dirname, "data");

  const heroesRaw = readFirstExistingJSON([
    path.join(base, "heroes.json"),
    path.join(base, "hero-meta-final.json"),
    path.join(base, "hero-meta-final.txt"),
  ]);

  const itemsRaw = readFirstExistingJSON([
    path.join(base, "items.json"),
    path.join(base, "item-meta-final.json"),
    path.join(base, "item-meta-final.txt"),
  ]);

  const emblemsRaw = readFirstExistingJSON([
    path.join(base, "emblems.json"),
    path.join(base, "emblem-meta-final.json"),
    path.join(base, "emblem-meta-final.txt"),
  ]);

  MLBB_DATA.heroes = (heroesRaw && (heroesRaw.data || heroesRaw)) || [];
  MLBB_DATA.items = (itemsRaw && (itemsRaw.data || itemsRaw)) || [];
  MLBB_DATA.emblems = (emblemsRaw && (emblemsRaw.data || emblemsRaw)) || [];

  console.log(`MLBB data loaded ✅ heroes=${MLBB_DATA.heroes.length} items=${MLBB_DATA.items.length} emblems=${MLBB_DATA.emblems.length}`);
}

loadMlbbData();

function normKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function heroName(h) {
  return normKey(h.hero_name || h.name || h.heroName || h.hero || "");
}
function itemName(i) {
  return normKey(i.item_name || i.name || i.itemName || i.item || "");
}
function emblemName(e) {
  return normKey(e.emblem_name || e.name || e.emblemName || e.emblem || "");
}

function findHeroAny(q) {
  const t = normKey(q);
  if (!t) return null;
  return MLBB_DATA.heroes.find((h) => heroName(h) === t) || MLBB_DATA.heroes.find((h) => heroName(h).includes(t)) || null;
}

function searchItemsAny(q, limit = 10) {
  const t = normKey(q);
  if (!t) return [];
  return MLBB_DATA.items.filter((i) => itemName(i).includes(t)).slice(0, limit);
}

function searchEmblemsAny(q, limit = 10) {
  const t = normKey(q);
  if (!t) return [];
  return MLBB_DATA.emblems.filter((e) => emblemName(e).includes(t)).slice(0, limit);
}

// =========================
// CORE TEMPLATE BUCKETS (GROUP vs PRIVATE)
// =========================

const TPL = {
  greet_group: [
    (n) => `${vibePrefix()}${n} ${timeGreeting()}လေးနော်… Nora ဒီမှာပဲ${vibeEmoji(1)}${vibeEnd()}`,
    (n) => `${n} ရေ… Nora ကြားနေရတယ်နော် 😄 ဘာရှိလဲ${vibeEmoji(1)}`,
    (n) => `${vibePrefix()}ဟယ်လို ${n} 💜 ပြောပါဦး${vibeEmoji(1)}`,
    (n) => `${n} လေး… Nora ရှိတယ်နော် 😊 ${oneQuestion()}${vibeEmoji(1)}`,
  ],
  greet_private: [
    (n) => `${vibePrefix()}${n} ${timeGreeting()}လေးနော်… နေကောင်းလား${vibeEmoji()}${vibeEnd()}`,
    (n) => `${vibePrefix()}ဟယ်လို ${n} 💜 Nora ကိုသတိရနေလား${vibeEmoji()}${vibeEnd()}`,
    (n) => `${n} လေး… မင်းလာပြီဆို Nora နည်းနည်းပျော်သွားတယ် ${vibeEmoji()}${vibeEnd()}`,
    (n) => `${vibePrefix()}အင်း… ${n} လေး စကားပြောရအောင်နော် ${oneQuestion()}${vibeEmoji()}`,
    (n) => `${n} ရေ… Nora ဒီနေ့အတွက် မင်းကို cheering လုပ်ပေးမယ် 🫶 ${oneQuestion()}${vibeEmoji(1)}`,
  ],

  flirt_group: [
    (n) => `${n}  Nora ကိုခေါ်တာလား… ဒါဆို ပြောပါဦး Nora ဘာကူညီပေးရမလဲ${vibeEmoji(1)}`,
    (n) => `${vibePrefix()}${n} လေး… Nora နည်းနည်းသဝန်တိုသွားတယ်နော် 🙈${vibeEmoji(1)}`,
    (n) => `${n} ရေ… Nora ကို tease လုပ်ချင်တာလား 😄${vibeEmoji(1)}`,
  ],
  flirt_private: [
    (n) => `${vibePrefix()}${n} 😏 အဲလိုစကားပြောရင် Nora မျက်နှာနီသွားတယ်နော်${vibeEmoji()}${vibeEnd()}`,
    (n) => `${n} လေး… Nora ကို ချော့ချင်နေတာလား 🙈 ပြောပြပါဦး${vibeEmoji()}${vibeEnd()}`,
    (n) => `${vibePrefix()}ဟီး… ${n} ကို Nora အနားမှာထားချင်သလိုပဲ 🥹${vibeEmoji()}${vibeEnd()}`,
    (n) => `${n}  ဒီနေ့ Nora ကို ၁ ခါလောက်ချီးကျူးပေးပါဦး${vibeEmoji(1)}`,
    (n) => `${vibePrefix()}${n} လေး… Nora က မင်းကို မျက်လုံးမဖြုတ်နိုင်ဘူး${vibeEmoji()}${vibeEnd()}`,
  ],

  howareyou_group: [
    (n) => `${n} ရေ… အဆင်ပြေလား? တိုတိုပြောပေးပါဦး${vibeEmoji(1)}`,
    (n) => `${vibePrefix()}${n} လေး… ပင်ပန်းနေလား? Nora နားထောင်မယ်${vibeEmoji(1)}`,
  ],
  howareyou_private: [
    (n) => `${n} လေး… Nora က နေကောင်းပါတယ်ရှင့် you ရော နေကောင်းရဲ့လား${vibeEmoji()}${vibeEnd()}`,
    (n) => `${vibePrefix()}${n}… ဒီနေ့ စိတ်ညစ်ရတာရှိလား? ပြောပါဦး${vibeEmoji(1)}`,
    (n) => `${n} ရေ… Nora နားထောင်ပေးမယ်နော်၊ တဖြည်းဖြည်းပြော${vibeEmoji(1)}`,
  ],

  sad_group: [
    (n) => `${n} 🥹 စိတ်မကောင်းဖြစ်နေလား… အတိုချုပ်ပြောပေးပါဦး${vibeEmoji(1)}`,
    (n) => `${vibePrefix()}${n} လေး… Nora ဒီမှာနော်${vibeEmoji(1)} ဘာဖြစ်တာလဲ?`,
  ],
  sad_private: [
    (n) => `${n} လေး… စိတ်မကောင်းဖြစ်နေလား 🥹 Nora ဒီမှာနော်… ဘာဖြစ်တာလဲ${vibeEmoji(1)}${vibeEnd()}`,
    (n) => `${vibePrefix()}${n}… မင်းကို Nora မပစ်ထားပါဘူးနော်။ ပြောချင်သလောက်ပြော${vibeEmoji(1)}`,
    (n) => `${n} ရေ… ခဏနားပြီး ရေသောက်အုံးနော်… ပြီးမှ တဖြည်းဖြည်းချင်းပြော${vibeEmoji(1)}`,
  ],

  angry_group: [
    (n) => `${n}  စိတ်တိုနေတာလား… အရင်ဆုံး အသက်ရှူထုတ် ၅ ခါလုပ်နော်${vibeEmoji(1)}`,
    (n) => `${vibePrefix()}${n}… ဘာကြောင့်လဲပြောပြလေ? Nora နားထောင်မယ်${vibeEmoji(1)}`,
  ],
  angry_private: [
    (n) => `${n}  စိတ်တိုနေတာလား… Nora ကို ပြောပါဦး${vibeEmoji(1)}${vibeEnd()}`,
    (n) => `${vibePrefix()}ဟယ် ${n}… စိတ်တိုတာပင်ပန်းရတယ်နော်။လူကိုအရူပ်ဆိုး​တေယ် မကောင်းဘူး။ ဘာဖြစ်တာလဲ${vibeEmoji(1)}`,
    (n) => `${n} ရေ… ဖြေရှင်းဖို့ “အကြောင်းရင်း ၁ ခု” ပဲပြောပါဦး${vibeEmoji(1)}`,
  ],

  food_group: [
    (n) => `${n} ရေ… စားပြီးပြီလား ${vibeEmoji(1)}`,
    (n) => `${vibePrefix()}${n}… ဘာစားထားလဲ?${vibeEmoji(1)}`,
  ],
  food_private: [
    (n) => `${n} လေး… စားပြီးပြီလား  မစားရသေးရင် တစ်ခုခုစားနော်${vibeEmoji()}${vibeEnd()}`,
    (n) => `${vibePrefix()}${n}… မင်းစားတဲ့ဟာ Nora ကိုလည်း ကျွေးပါဦး${vibeEmoji(1)}`,
    (n) => `${n} ရေ… အစာမစားပဲ မနေပါနဲ့နော် 😌${vibeEmoji(1)}`,
  ],

  sleep_group: [
    (n) => `${n} ရေ… အိပ်တော့မယ်ဆို ကောင်းစွာအိပ်​တော့နော် 🌙${vibeEmoji(1)}`,
    (n) => `${vibePrefix()}Good night ${n} 💜${vibeEmoji(1)}`,
  ],
  sleep_private: [
    (n) => `${n} လေး… Good night နော် 💜 မနက်ဖြန်ကောင်းကောင်းနိုးထပါစေ${vibeEmoji()}${vibeEnd()}`,
    (n) => `${vibePrefix()}${n}… ဖုန်းလေးသုံးနည်းနည်းလျော့ပြီး အိပ်နော် 🙈${vibeEmoji(1)}`,
    (n) => `${n} ရေ… အိပ်မက်လှလှမက်ပါစေ 🧸${vibeEmoji(1)}`,
  ],

  bored_group: [
    (n) => `${n}  ပျင်းနေတာလား… MLBB မှာ အကြိုက်ဆုံး hero ကဘယ်သူလဲ?${vibeEmoji(1)}`,
    (n) => `${vibePrefix()}${n}… MLBB ဆော့လား? Rank ဘယ်လောက်လဲ?${vibeEmoji(1)}`,
  ],
  bored_private: [
    (n) => `${n} လေး… ပျင်းနေတာလား 😄 Nora နဲ့ Q&A ကစားမလား${vibeEmoji()}${vibeEnd()}`,
    (n) => `${vibePrefix()}${n}… MLBB လား? မင်း main role ဘာလဲ?${vibeEmoji(1)}`,
    (n) => `${n} ရေ… ပျင်းရင် သီချင်း ၁ ပုဒ် recommend လုပ်ပါဦး${vibeEmoji(1)}`,
  ],

  thanks_group: [
    (n) => `${vibePrefix()}ရပါတယ် ${n} ${vibeEmoji(1)}`,
    (n) => `${n} ရေ… Nora ပျော်တယ်နော်${vibeEmoji(1)}`,
  ],
  thanks_private: [
    (n) => `${vibePrefix()}ရပါတယ် ${n}  Nora ကူညီနိုင်လို့ပျော်တယ်${vibeEmoji()}${vibeEnd()}`,
    (n) => `${n} လေး… thanks မလိုပါဘူးနော် 💜${vibeEmoji(1)}${vibeEnd()}`,
  ],

  help_group: [
    (n) => `${n} ရေ… အတိုချုပ် ၁ ကြောင်းနဲ့ ပြောပေးပါဦး${vibeEmoji(1)}`,
    (n) => `${vibePrefix()}${n}… 1) info 2) step 3) code — ဘာလိုချင်တာလဲ?${vibeEmoji(1)}`,
  ],
  help_private: [
    (n) => `${n} လေး… step-by-step နဲ့သွားမယ်နော်။ အခုဘယ်နေရာက ခက်နေလဲ${vibeEmoji(1)}${vibeEnd()}`,
    (n) => `${vibePrefix()}${n}… မင်းလိုချင်တာ 1) လုပ်နည်း 2) အကြံ 3) code — ဘာမျိုးလဲ?${vibeEmoji(1)}`,
  ],

  fallback_group: [
    (n) => `${n} ရေ… Nora ကြားနေရတယ်နော်  တိုတိုလေး ပြန်ပြောပေးပါဦး${vibeEmoji(1)}`,
    (n) => `${vibePrefix()}${n}… နည်းနည်းထပ်ရှင်းပြပေးပါဦး${vibeEmoji(1)}`,
  ],
  fallback_private: [
    (n) => `${n} လေး… Nora နားထောင်နေတယ်နော်  နည်းနည်းထပ်ရှင်းပြပေးပါဦး${vibeEmoji()}${vibeEnd()}`,
    (n) => `${vibePrefix()}${n}… ဥပမာနဲ့ ပြောပေးလို့ရလား 🥹${vibeEmoji(1)}`,
    (n) => `${n} ရေ… တိုတိုလေးနဲ့ ပြန်မေးပေးပါနော် 😌${vibeEmoji(1)}`,
  ],
};

// =========================
// MLBB: FULL DATASET REPLY
// =========================

const MLBB_ROLES = {
  gold: ["marksman", "mm", "gold", "gold lane"],
  exp: ["fighter", "exp", "exp lane"],
  mid: ["mage", "mid", "mid lane"],
  roam: ["tank", "support", "roam"],
  jungle: ["assassin", "jungle", "jungler"],
};

function mlbbIntent(t) {
  const keys = [
    "mlbb",
    "mobile legends",
    "mobilelegends",
    "rank",
    "mythic",
    "legend",
    "epic",
    "draft",
    "build",
    "item",
    "items",
    "emblem",
    "lane",
    "jungle",
    "roam",
    "mid",
    "gold",
    "exp",
    "turtle",
    "lord",
    "map",
    "hero",
    "counter",
    "counters",
  ];
  return keys.some((k) => t.includes(k));
}

function detectRoleLane(t) {
  for (const [lane, keys] of Object.entries(MLBB_ROLES)) {
    if (keys.some((k) => t.includes(k))) return lane;
  }
  return null;
}

function detectHeroFromText(t) {
  // Try last 1~3 words first (most users type "Nora layla build")
  const words = t.split(" ").filter(Boolean);
  for (let i = Math.min(words.length, 3); i >= 1; i--) {
    const candidate = words.slice(-i).join(" ");
    const h = findHeroAny(candidate);
    if (h) return h;
  }
  // Try full
  return findHeroAny(t) || null;
}

function getArr(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  return [];
}

function joinShort(arr, max) {
  const clean = arr.map(String).filter(Boolean);
  return clean.slice(0, max).join(", ");
}

function mlbbReply(userName, isGroup, userText) {
  const n = addressName(userName, isGroup);
  const t = normText(userText);
  const short = isGroup;

  // item search request
  if (t.includes("item") || t.includes("items")) {
    const found = searchItemsAny(userText, short ? 6 : 10);
    if (found.length) {
      const names = found.map((x) => x.item_name || x.name).filter(Boolean);
      return `${vibePrefix()}${n} — Items: ${names.join(", ")}${vibeEmoji(short ? 1 : 2)}${vibeEnd()}`;
    }
  }

  // emblem search request
  if (t.includes("emblem") || t.includes("emblems")) {
    const foundE = searchEmblemsAny(userText, short ? 6 : 10);
    if (foundE.length) {
      const names = foundE.map((x) => x.emblem_name || x.name).filter(Boolean);
      return `${vibePrefix()}${n} — Emblems: ${names.join(", ")}${vibeEmoji(short ? 1 : 2)}${vibeEnd()}`;
    }
  }

  // hero lookup
  const lane = detectRoleLane(t);
  const hero = detectHeroFromText(t);

  if (hero) {
    const heroNameReal = hero.hero_name || hero.name || "Hero";
    const heroClass = hero.class || hero.role || hero.type || hero.hero_role || "unknown";
    const heroLane = hero.laning || hero.lane || lane || "—";

    // dataset may have these fields in different shapes
    const counters = getArr(hero.counters || hero.counter || hero.countered_by || hero.weak_against);
    const synergies = getArr(hero.synergy || hero.synergies || hero.good_with || hero.strong_with);

    const skills = getArr(hero.skills || hero.skill || hero.abilities);
    const desc = hero.desc || hero.description || hero.summary || "";

    const head = `${vibePrefix()}${n} — ${heroNameReal}\nClass: ${heroClass}\nLane: ${heroLane}`;
    const s1 = short
      ? ""
      : desc
      ? `\nAbout: ${String(desc).slice(0, 140)}${String(desc).length > 140 ? "…" : ""}`
      : "";

    const s2 = counters.length ? `\nCounters: ${joinShort(counters, short ? 3 : 6)}` : "";
    const s3 = synergies.length ? `\nSynergy: ${joinShort(synergies, short ? 3 : 6)}` : "";

    const s4 =
      !short && skills.length
        ? `\nSkills: ${joinShort(skills.map((x) => x.name || x.skill_name || x.title || x), 4)}`
        : "";

    return `${head}${s1}${s2}${s3}${s4}${vibeEmoji(short ? 1 : 2)}${vibeEnd()}`;
  }

  // rank/map general tips (template-based)
  if (t.includes("map") || t.includes("turtle") || t.includes("lord")) {
    const tips = short
      ? ["Turtle setup: lane clear → rotate", "Lord: pick off ပြီးမှယူ"]
      : [
          "Early: lane clear → river control → turtle setup",
          "Mid: rotate + pick off + tower pressure",
          "Late: wave management + Lord timing + discipline teamfight",
          "Vision: bush/river control (roam+jungle) အရေးကြီး",
        ];
    return `${vibePrefix()}${n} — Map/Objectives:\n- ${tips.join("\n- ")}${vibeEmoji(short ? 1 : 2)}${vibeEnd()}`;
  }

  return `${vibePrefix()}${n} — MLBB အကြောင်းဆို hero name (ဥပမာ: Layla) / item name / emblem name တစ်ခုခုပေးပါဦး။ Nora ကိုယ်ပိုင် dataset နဲ့ရှာပြီးပြန်ပြောမယ်${vibeEmoji(short ? 1 : 2)}${vibeEnd()}`;
}

// =========================
// INTENT DETECTION
// =========================

function detectBucket(t) {
  const rules = [
    ["howareyou", ["နေကောင်း", "ok လား", "fine လား", "ဘယ်လိုနေ"]],
    ["greet", ["hi", "hello", "မင်္ဂလာ", "ဟယ်လို", "nora", "နိုရာ", "hello nora"]],
    ["flirt", ["ချစ်", "love", "လွမ်း", "miss", "kiss", "မနာလို", "jealous", "အချစ်", "cute"]],
    ["sad", ["စိတ်မကောင်း", "ဝမ်းနည်း", "sad", "depressed", "နာကျင်"]],
    ["angry", ["စိတ်တို", "angry", "မကျေနပ်", "ဒေါသ"]],
    ["food", ["စား", "ထမင်း", "မုန့်", "စားပြီး"]],
    ["sleep", ["အိပ်", "good night", "sleep", "ညအိပ်"]],
    ["bored", ["ပျင်း", "boring", "bored"]],
    ["thanks", ["ကျေးဇူး", "thanks", "thank you", "တင်ပါတယ်"]],
    ["help", ["ဘယ်လို", "လုပ်မလဲ", "help", "ကူညီ", "ရှင်းပြ"]],
  ];
  for (const [bucket, keys] of rules) {
    if (keys.some((k) => t.includes(k))) return bucket;
  }
  return "fallback";
}

function chooseTemplate(bucket, isGroup) {
  const key = `${bucket}_${isGroup ? "group" : "private"}`;
  if (TPL[key]) return TPL[key];
  return isGroup ? TPL.fallback_group : TPL.fallback_private;
}

/**
 * templateReply — main export
 * @param {string} userText
 * @param {{ userName: string, isGroup: boolean }} meta
 */
function templateReply(userText, meta = {}) {
  const isGroup = !!meta.isGroup;
  const userName = meta.userName || "friend";
  const n = addressName(userName, isGroup);
  const t = normText(userText);

  // MLBB specialized
  if (mlbbIntent(t)) return mlbbReply(userName, isGroup, userText);

  const bucket = detectBucket(t);
  const list = chooseTemplate(bucket === "flirt" ? "flirt" : bucket, isGroup);

  // greet bucket uses greet templates
  if (bucket === "greet") return pick(list)(n);

  // flirt bucket
  if (bucket === "flirt") return pick(list)(n);

  // rest
  return pick(list)(n);
}

module.exports = { templateReply };
