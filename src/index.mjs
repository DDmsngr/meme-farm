import { createHash } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import phash from 'sharp-phash';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEDUP_PATH = path.resolve(__dirname, '..', 'dedup.json');
const DEDUP_LIMIT = 5000;

const SUBREDDITS = ['Pikabu', 'ANormalDayInRussia'];
const FOOD_SUBS = ['food', 'FoodPorn', 'tonightsdinner'];
const FACT_VK = ['interesnie_facty', 'FactRoom'];
const FACT_TG = ['FactRoom'];

const THEMED_CAPTIONS = {
  morning: [
    'Утро, работяги ☀️ Пора пахать',
    'Подъём! Кофе в зубы и погнали ☕',
    'Открывайте глаза, начинается смена 👁️',
    'Утро, соня. Мир не остановился ☀️',
  ],
  monday_morning: [
    'С понедельником, страдальцы 😩',
    'Ну что, снова в бой? Понедельник, блин 😤',
    'Проснулись? Впереди пять дней. Держись 🫡',
    'Понедельник — это не приговор, это привычка 🥲',
  ],
  lunch: [
    'Кушать подано, садитесь жрать 🍽️',
    'Обеденный перерыв, работяги 🍔',
    'Пожуй, пока начальник не видит 🍕',
    'Мозг требует топлива 🍜',
  ],
  fact: [
    '🧠 Загрузим-ка чутка в череп',
    '🧠 Полезное на диван к пиву',
    '🧠 Держи факт, повыпендриваешься перед корешами',
    '🧠 Факт, которым будешь блистать на свиданке',
  ],
  friday: [
    'Работяги, погнали в выходные 🍺',
    'Всё, неделя всё. Наливай 🍻',
    'Пятница вечер — святое дело 🎉',
    'Бросайте ноутбуки, начинается жизнь 🕺',
  ],
  cashback: [
    '🏦 Не забудь ткнуть кешбэки, а то опять пролетишь на месяц',
    '🏦 Первое число! Кешбэки сами себя не выберут',
    '🏦 Пятиминутка жадности: обнови кешбэки во всех банках',
    '🏦 Кешбэки на новый месяц ждут, шустрее',
  ],
  weekend_sat: [
    'Ну что, отсыпаемся, лентяи? 😎',
    'Суббота — святой день ничегонеделания ☕',
    'Просыпаемся, когда сами захотим 🛌',
    'Выходной, работяги. Заслужили 🍩',
  ],
  cats: [
    'Котик на ночь',
    'Мурчалка перед сном 🐾',
    'Обнимите кота и живите дальше 🐈',
    'Пусть этот котик успокоит вашу душу 🖤',
  ],
  weekend_sun: [
    'Готовимся к понедельнику, страдальцы 😩',
    'Всё, лавочка закрывается. Завтра пахать 😔',
    'Последний вечер свободы 🥲',
    'Работа не волк, но завтра идти 🐺',
  ],
  night: [
    'Отбой, работяги. Завтра снова в бой 🌙',
    'Тушите свет, спать пора 😴',
    'Хорош залипать, ложись уже 🌙',
    'Приятных снов, страдальцы 🌛',
  ],
};

function pickCaption(mode) {
  const pool = THEMED_CAPTIONS[mode];
  if (!pool || !pool.length) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}

// Захардкоженный топ-50 (официальные РФ + международные известные + узнаваемые шуточные)
// Ключ — MM-DD (без года)
const HOLIDAYS = {
  '01-01': 'Новый год 🎄',
  '01-03': 'День ленивца 🦥',
  '01-07': 'Рождество Христово ✨',
  '01-13': 'Старый Новый год 🎉',
  '01-25': 'Татьянин день / День студента 🎓',
  '02-02': 'День сурка 🐿',
  '02-04': 'День рождения интернета 🌐',
  '02-14': 'День святого Валентина 💘',
  '02-23': 'День защитника Отечества 🛡',
  '03-08': 'Международный женский день 🌷',
  '03-14': 'День числа Пи π',
  '03-17': 'День святого Патрика ☘',
  '03-20': 'Международный день счастья 🥳',
  '04-01': 'День смеха 🤡',
  '04-12': 'День космонавтики 🚀',
  '04-22': 'День Земли 🌍',
  '04-23': 'Всемирный день книги 📖',
  '05-01': 'Праздник весны и труда 🌷',
  '05-04': 'День Звёздных войн — да прибудет с тобой Сила ⚔',
  '05-09': 'День Победы 🎖',
  '05-25': 'День полотенца 🧻',
  '06-01': 'День защиты детей 👶',
  '06-05': 'Всемирный день окружающей среды 🌳',
  '06-08': 'Всемирный день океанов 🌊',
  '06-12': 'День России 🇷🇺',
  '06-21': 'Международный день йоги 🧘',
  '07-02': 'Всемирный день НЛО 🛸',
  '07-08': 'День семьи, любви и верности 💑',
  '07-11': 'Всемирный день шоколада 🍫',
  '07-17': 'Всемирный день эмодзи 😀',
  '07-30': 'Международный день дружбы 🤝',
  '08-08': 'Всемирный день кошек 🐱',
  '08-13': 'Всемирный день левшей ✋',
  '08-22': 'День флага России 🇷🇺',
  '09-01': 'День знаний 📚',
  '09-13': 'День программиста 💻',
  '09-19': 'Международный день пиратов 🏴‍☠',
  '09-27': 'Всемирный день туризма ✈',
  '10-01': 'Международный день кофе ☕',
  '10-04': 'Всемирный день животных 🐕',
  '10-05': 'День учителя 👩‍🏫',
  '10-16': 'Всемирный день хлеба 🍞',
  '10-31': 'Хэллоуин 🎃',
  '11-01': 'Всемирный день веганов 🥗',
  '11-04': 'День народного единства 🎖',
  '11-13': 'Всемирный день доброты 🫂',
  '11-28': 'Чёрная пятница 🛍',
  '12-04': 'День мамонта 🐘',
  '12-25': 'Католическое Рождество ✝',
  '12-31': 'Канун Нового года 🥂',
};

const HOLIDAY_TEMPLATES = [
  '🎉 Сегодня {h}. Ну ты понял.',
  '🎊 Оказывается, сегодня {h}. Отметим?',
  '🥳 Внимание: {h}. Повод найден.',
  '🎈 А сегодня, между прочим, {h}',
];

const RU_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function todayMonthDay() {
  const now = mskNow();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

function todayHumanDate() {
  const now = mskNow();
  return `${now.getUTCDate()} ${RU_MONTHS[now.getUTCMonth()]}`;
}

async function fetchGeminiHoliday(dateStr) {
  if (!GEMINI_KEY) return null;
  const prompt = `Какой интересный, забавный или необычный тематический праздник отмечается ${dateStr}? Это может быть международный, российский, или неформальный "день чего-то" (день кофе, день пиццы, день лени и т.п.). Верни JSON: {"holiday": "название с одним эмодзи в конце"} — короткое название, максимум 5 слов. Если ничего интересного не найдено, верни {"holiday": null}.`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 60,
            responseMimeType: 'application/json',
          },
        }),
      }
    );
    if (!res.ok) {
      console.warn(`gemini holiday HTTP ${res.status}`);
      return null;
    }
    const j = await res.json();
    const raw = j.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.holiday || null;
  } catch (e) {
    console.warn('gemini holiday failed:', e.message);
    return null;
  }
}

async function getTodayHoliday() {
  const key = todayMonthDay();
  if (HOLIDAYS[key]) {
    console.log(`holiday hardcoded: ${HOLIDAYS[key]}`);
    return HOLIDAYS[key];
  }
  const gem = await fetchGeminiHoliday(todayHumanDate());
  if (gem) console.log(`holiday gemini: ${gem}`);
  else console.log(`holiday: nothing today`);
  return gem;
}

function pickHolidayTemplate(name) {
  const tpl = HOLIDAY_TEMPLATES[Math.floor(Math.random() * HOLIDAY_TEMPLATES.length)];
  return tpl.replace('{h}', name);
}

function stripEmoji(s) {
  return s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}‍]/gu, '').replace(/\s+/g, ' ').trim();
}

async function fetchHolidayCandidates(holidayName) {
  const clean = stripEmoji(holidayName);
  const query = `${clean} картинка`;
  return fetchDdgCandidates(query, 'holiday');
}

const CATS_VK = ['catszavod'];
const CATS_TG = ['catszavod', 'meowvibe', 'kotoblog'];

const PHASH_THRESHOLD = 12; // Хэмминг-дистанция, ≤ значит визуальный дубль

const AD_TRIGGERS = [
  { name: 'promokod', re: /промокод/i },
  { name: 'discount', re: /скидк[аиоуеы]/i },
  { name: 'coupon', re: /купон/i },
  { name: 'bonus', re: /\bбонус/i },
  { name: 'subscribe', re: /подпи[шс](ись|итесь|аться|ывай)|подписка на канал/i },
  { name: 'go-link', re: /переход(и|ите)\s+по\s+ссылке|по\s+ссылке\s+ниже/i },
  { name: 'ad-tag', re: /#реклама|#ad\b|#промо|#partner/i },
  { name: 'all-channels', re: /\|\s*(Все|Все наши)\s+каналы|\|\s*Каналы\s+дня/i },
  { name: 'our-channel', re: /наш(и)?\s+канал|мой\s+канал|канал\s+друг/i },
];
const AD_MIN_TRIGGERS = 2;

// Сильные триггеры: одно упоминание = скип (банки + яндекс + любые ссылки)
// Используем (?<!\p{L}) и (?!\p{L}) для word-boundaries по кириллице
const AD_HARD_TRIGGERS = [
  { name: 'any-link', re: /https?:\/\/\S|www\.[a-z0-9-]+\.\S|(?<!\p{L})t\.me\/\S|(?<!\p{L})(?:vk\.cc|bit\.ly|clck\.ru|taplink|goo\.gl|tinyurl|short\.link)\/\S/iu },
  { name: 'bank', re: /(?<!\p{L})банк(?:а|у|е|ом|ов|ами|ах)?(?!\p{L})/iu },
  { name: 'alpha', re: /(?<!\p{L})альфа(?:[\s-]?банк\p{L}*)?(?!\p{L})/iu },
  { name: 'sber', re: /(?<!\p{L})сбер(?:банк\p{L}*|карта|пэй)?(?!\p{L})/iu },
  { name: 'tinkoff', re: /(?<!\p{L})(?:тинькофф\p{L}*|т[\s-]?банк\p{L}*|t[\s-]?банк\p{L}*)(?!\p{L})/iu },
  { name: 'vtb', re: /(?<!\p{L})втб(?!\p{L})/iu },
  { name: 'gazprom', re: /(?<!\p{L})газпром(?:банк\p{L}*|-медиа|нефть)?(?!\p{L})/iu },
  { name: 'raiffeisen', re: /(?<!\p{L})райффайзен\p{L}*(?!\p{L})/iu },
  { name: 'otkrytie-bank', re: /(?<!\p{L})банк\s+открытие(?!\p{L})/iu },
  { name: 'sovkom', re: /(?<!\p{L})совкомбанк\p{L}*(?!\p{L})/iu },
  { name: 'psb', re: /(?<!\p{L})(?:псб|промсвязьбанк\p{L}*)(?!\p{L})/iu },
  { name: 'ozon-bank', re: /(?<!\p{L})(?:ozon|озон)\s*банк\p{L}*(?!\p{L})/iu },
  { name: 'mts-bank', re: /(?<!\p{L})мтс\s*банк\p{L}*(?!\p{L})/iu },
  { name: 'pochta-bank', re: /(?<!\p{L})почта\s*банк\p{L}*(?!\p{L})/iu },
  { name: 'yandex', re: /(?<!\p{L})яндекс\p{L}*(?!\p{L})/iu },
];

const MIN_UPS = 20;
const CAPTION_HARD_LIMIT = 1024;
const PER_SUB_LIMIT = 25;
const VIDEO_MAX_BYTES = 50 * 1024 * 1024; // TG sendVideo hard limit
const USER_AGENT = 'meme-farm/1.0';
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MEME_API = 'https://meme-api.com/gimme';

const VK_DOMAINS = [
  'mudakoff',
  'bugurt_thread',
  'mrakobesie',
  'borsch',
  'academyofmemes',
  'reddit',
  'typical_moscow',
  'lentach',
  'true_lentach',
];
const VK_MIN_LIKES = 500;
const VK_PER_DOMAIN = 20;
const VK_API_VERSION = '5.199';

const TG_CHANNELS = [
  'twitt_ota',
  'sarcasm_orgasm',
  'meowkyit',
  'amdevs',
  'avansanebudet',
  'ithumor',
  'internetpasta',
  'memepedia_Ru',
  'apatiyaaaa',
  'yu6_6kan',
  'cbpub',
  'lentachold',
  'dvachannel',
  'mudak',
  'meowfacts',
];

const YT_KEYWORDS = ['мемы shorts', 'приколы shorts', 'смешное shorts', 'шутки shorts'];
const YT_MIN_VIEWS = 50_000;
const YT_MIN_LIKES = 2_000;
const YT_MAX_DURATION_SEC = 60;

const RT_KEYWORDS = ['мемы', 'приколы', 'смешное', 'шутки'];
const RT_MIN_VIEWS = 20_000;
const RT_MAX_DURATION_SEC = 180;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const VK_TOKEN = process.env.VK_TOKEN;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const GEMINI_KEY = process.env.GEMINI;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('BOT_TOKEN and CHAT_ID env vars are required');
  process.exit(1);
}

const md5 = (buf) => createHash('md5').update(buf).digest('hex');

const IMG_RE = /\.(jpe?g|png)(\?.*)?$/i;

async function computePhash(buf) {
  return 'phash:' + (await phash(buf));
}

function hammingDistance(a, b) {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function findVisualDuplicate(newPhash, dedupSet) {
  const bits = newPhash.slice('phash:'.length);
  for (const entry of dedupSet) {
    if (!entry.startsWith('phash:')) continue;
    if (hammingDistance(bits, entry.slice('phash:'.length)) <= PHASH_THRESHOLD) return true;
  }
  return false;
}

function mskNow() {
  return new Date(Date.now() + 3 * 3600 * 1000);
}

function currentMode() {
  const now = mskNow();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const dow = now.getUTCDay(); // 0=Sun ... 1=Mon ... 5=Fri ... 6=Sat
  const dom = now.getUTCDate(); // 1..31
  if (h === 7 && m < 15) return dow === 1 ? 'monday_morning' : 'morning';
  if (h === 10 && m < 15 && dom === 1) return 'cashback';
  if (h === 10 && m < 15 && dow === 6) return 'weekend_sat';
  if (h === 11 && m < 15) return 'holiday';
  if (h === 12 && m < 15) return 'lunch';
  if (h === 15 && m < 15) return 'fact';
  if (h === 18 && m < 15 && dow === 5) return 'friday';
  if (h === 20 && m < 15 && dow === 0) return 'weekend_sun';
  if (h === 21 && m < 15) return 'cats';
  if (h === 23 && m >= 30) return 'night';
  return 'meme';
}

function todayMSK() {
  return mskNow().toISOString().slice(0, 10);
}

async function loadDedup() {
  try {
    const raw = await readFile(DEDUP_PATH, 'utf8');
    const data = JSON.parse(raw);
    return new Set(data.hashes || []);
  } catch {
    return new Set();
  }
}

async function saveDedup(set) {
  const arr = [...set];
  const trimmed = arr.slice(-DEDUP_LIMIT);
  await writeFile(DEDUP_PATH, JSON.stringify({ hashes: trimmed }, null, 2) + '\n', 'utf8');
}

async function fetchSubreddit(sub) {
  const url = `${MEME_API}/${sub}/${PER_SUB_LIMIT}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    console.warn(`[${sub}] HTTP ${res.status}`);
    return [];
  }
  const json = await res.json();
  return Array.isArray(json?.memes) ? json.memes : [];
}

function postIdFromLink(link) {
  const m = /redd\.it\/([a-z0-9]+)/i.exec(link || '');
  return m ? m[1] : link;
}

function isGoodPost(p) {
  if (!p) return false;
  if (p.nsfw || p.spoiler) return false;
  if ((p.ups || 0) < MIN_UPS) return false;
  if (!p.url) return false;
  if (!IMG_RE.test(p.url)) return false;
  return true;
}

async function fetchRedditCandidates(subs) {
  const buckets = await Promise.all(
    subs.map(async (sub) => {
      try {
        const memes = await fetchSubreddit(sub);
        return memes.filter(isGoodPost).map((p) => ({
          source: 'reddit',
          id: 'id:' + postIdFromLink(p.postLink),
          origin: p.subreddit,
          title: p.title || '',
          url: p.url,
          ups: p.ups || 0,
        }));
      } catch (e) {
        console.warn(`[r/${sub}] fetch failed:`, e.message);
        return [];
      }
    })
  );
  return buckets.flat();
}

async function fetchVkWall(domain) {
  const q = new URLSearchParams({
    domain,
    count: String(VK_PER_DOMAIN),
    access_token: VK_TOKEN,
    v: VK_API_VERSION,
  });
  const res = await fetch(`https://api.vk.com/method/wall.get?${q}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  const j = await res.json();
  if (j.error) {
    console.warn(`[vk/${domain}] error ${j.error.error_code}: ${j.error.error_msg}`);
    return [];
  }
  return j.response?.items || [];
}

function pickVkPhoto(item) {
  const photoAtt = (item.attachments || []).find((a) => a.type === 'photo');
  if (!photoAtt) return null;
  const sizes = photoAtt.photo?.sizes || [];
  if (!sizes.length) return null;
  return sizes.reduce((a, b) => ((a.width || 0) > (b.width || 0) ? a : b));
}

function pickVkVideoUrl(item) {
  const videoAtt = (item.attachments || []).find((a) => a.type === 'video');
  if (!videoAtt || !videoAtt.video) return null;
  const v = videoAtt.video;
  const key = v.access_key ? `?list=${v.access_key}` : '';
  return `https://vk.com/video${v.owner_id}_${v.id}${key}`;
}

async function fetchVkCandidates(domains, minLikes = VK_MIN_LIKES) {
  if (!VK_TOKEN) return [];
  const buckets = await Promise.all(
    domains.map(async (domain) => {
      try {
        const items = await fetchVkWall(domain);
        return items
          .filter((p) => !p.marked_as_ads && !p.is_pinned)
          .map((p) => {
            const likes = p.likes?.count || 0;
            if (likes < minLikes) return null;
            const title = (p.text || '').replace(/\s+/g, ' ').trim();
            const base = {
              source: 'vk',
              id: `vk:${p.owner_id}_${p.id}`,
              origin: domain,
              title,
              ups: likes,
            };
            const video = pickVkVideoUrl(p);
            if (video) return { ...base, mediaType: 'video', url: video };
            const photo = pickVkPhoto(p);
            if (photo) return { ...base, mediaType: 'photo', url: photo.url };
            return null;
          })
          .filter(Boolean);
      } catch (e) {
        console.warn(`[vk/${domain}] fetch failed:`, e.message);
        return [];
      }
    })
  );
  return buckets.flat();
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', ldquo: '"', rdquo: '"',
  lsquo: "'", rsquo: "'", copy: '©', reg: '®', trade: '™',
  middot: '·', bull: '•',
};

function decodeHtml(s) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);?/gi, (m, name) => HTML_ENTITIES[name.toLowerCase()] || m)
    .replace(/\s+/g, ' ')
    .trim();
}

function parseViews(s) {
  const trimmed = s.trim();
  const num = parseFloat(trimmed);
  if (Number.isNaN(num)) return 0;
  if (/K$/i.test(trimmed)) return Math.round(num * 1000);
  if (/M$/i.test(trimmed)) return Math.round(num * 1_000_000);
  return Math.round(num);
}

async function fetchTgChannel(channel) {
  const r = await fetch(`https://t.me/s/${channel}`, {
    headers: { 'User-Agent': BROWSER_UA },
  });
  if (!r.ok) {
    console.warn(`[tg/${channel}] HTTP ${r.status}`);
    return [];
  }
  const html = await r.text();
  const blocks = html.split('tgme_widget_message_wrap').slice(1);
  const results = [];
  for (const block of blocks) {
    const idM = /data-post="([^"]+)"/.exec(block);
    if (!idM) continue;
    const videoM = /<video[^>]*\ssrc=["']([^"']+)["']/.exec(block);
    const photoM = /tgme_widget_message_photo_wrap[\s\S]*?background-image:url\('([^']+)'/.exec(block);
    let mediaType = null;
    let url = null;
    if (videoM) { mediaType = 'video'; url = videoM[1]; }
    else if (photoM) { mediaType = 'photo'; url = photoM[1]; }
    else continue;
    const textM = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const viewsM = /tgme_widget_message_views[^>]*>([^<]+)/.exec(block);
    const views = viewsM ? parseViews(viewsM[1]) : 0;
    results.push({
      source: 'tg',
      mediaType,
      id: `tg:${idM[1]}`,
      origin: channel,
      title: textM ? decodeHtml(textM[1]) : '',
      url,
      ups: views,
    });
  }
  return results;
}

async function fetchTgCandidates(channels) {
  const buckets = await Promise.all(
    channels.map(async (ch) => {
      try {
        return await fetchTgChannel(ch);
      } catch (e) {
        console.warn(`[tg/${ch}] fetch failed:`, e.message);
        return [];
      }
    })
  );
  return buckets.flat();
}

function interleaveByOrigin(items) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.origin)) groups.set(it.origin, []);
    groups.get(it.origin).push(it);
  }
  for (const g of groups.values()) g.sort((a, b) => b.ups - a.ups);
  const buckets = [...groups.values()].sort(() => Math.random() - 0.5);
  const result = [];
  const max = buckets.length ? Math.max(...buckets.map((b) => b.length)) : 0;
  for (let i = 0; i < max; i++) {
    for (const bucket of buckets) {
      if (i < bucket.length) result.push(bucket[i]);
    }
  }
  return result;
}

function parseIsoDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

async function fetchYtCandidates() {
  if (!YOUTUBE_API_KEY) return [];
  const kw = YT_KEYWORDS[Math.floor(Math.random() * YT_KEYWORDS.length)];
  try {
    const sq = new URLSearchParams({
      part: 'snippet',
      q: kw,
      type: 'video',
      videoDuration: 'short',
      order: 'viewCount',
      maxResults: '25',
      regionCode: 'RU',
      relevanceLanguage: 'ru',
      key: YOUTUBE_API_KEY,
    });
    const searchJson = await (await fetch(`https://www.googleapis.com/youtube/v3/search?${sq}`)).json();
    if (searchJson.error) {
      console.warn(`[yt] search "${kw}" error: ${searchJson.error.message}`);
      return [];
    }
    const items = (searchJson.items || []).filter((it) => it.id?.videoId);
    if (!items.length) return [];
    const ids = items.map((i) => i.id.videoId).join(',');
    const vq = new URLSearchParams({ part: 'statistics,contentDetails', id: ids, key: YOUTUBE_API_KEY });
    const statsJson = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?${vq}`)).json();
    const byId = new Map();
    for (const s of statsJson.items || []) byId.set(s.id, s);

    const results = [];
    for (const it of items) {
      const stats = byId.get(it.id.videoId);
      if (!stats) continue;
      const views = +stats.statistics?.viewCount || 0;
      const likes = +stats.statistics?.likeCount || 0;
      const dur = parseIsoDuration(stats.contentDetails?.duration);
      if (views < YT_MIN_VIEWS) continue;
      if (likes < YT_MIN_LIKES) continue;
      if (dur > YT_MAX_DURATION_SEC || dur < 3) continue;
      results.push({
        source: 'yt',
        mediaType: 'video',
        id: `yt:${it.id.videoId}`,
        origin: kw,
        title: (it.snippet?.title || '').trim(),
        url: `https://www.youtube.com/shorts/${it.id.videoId}`,
        ups: views,
      });
    }
    console.log(`yt "${kw}": ${items.length} raw → ${results.length} pass`);
    return results;
  } catch (e) {
    console.warn('[yt] fetch failed:', e.message);
    return [];
  }
}

async function fetchRutubeCandidates() {
  const kw = RT_KEYWORDS[Math.floor(Math.random() * RT_KEYWORDS.length)];
  try {
    const q = new URLSearchParams({ query: kw, format: 'json' });
    const r = await fetch(`https://rutube.ru/api/search/video/?${q}`, {
      headers: { 'User-Agent': BROWSER_UA },
    });
    if (!r.ok) {
      console.warn(`[rt] search "${kw}" HTTP ${r.status}`);
      return [];
    }
    const j = await r.json();
    const items = j.results || [];
    const results = [];
    for (const it of items) {
      const views = +it.hits || 0;
      const duration = +it.duration || 0;
      if (views < RT_MIN_VIEWS) continue;
      if (duration > RT_MAX_DURATION_SEC || duration < 3) continue;
      const url = it.video_url || (it.id ? `https://rutube.ru/video/${it.id}/` : null);
      if (!url) continue;
      results.push({
        source: 'rt',
        mediaType: 'video',
        id: `rt:${it.id}`,
        origin: kw,
        title: (it.title || '').trim(),
        url,
        ups: views,
      });
    }
    console.log(`rt "${kw}": ${items.length} raw → ${results.length} pass`);
    return results;
  } catch (e) {
    console.warn('[rt] fetch failed:', e.message);
    return [];
  }
}

async function fetchMemeCandidates() {
  const [reddit, vk, tg, yt, rt] = await Promise.all([
    fetchRedditCandidates(SUBREDDITS),
    fetchVkCandidates(VK_DOMAINS),
    fetchTgCandidates(TG_CHANNELS),
    fetchYtCandidates(),
    fetchRutubeCandidates(),
  ]);
  console.log(`reddit: ${reddit.length}, vk: ${vk.length}, tg: ${tg.length}, yt: ${yt.length}, rt: ${rt.length}`);
  reddit.sort((a, b) => b.ups - a.ups);
  yt.sort((a, b) => b.ups - a.ups);
  rt.sort((a, b) => b.ups - a.ups);
  const vkOrdered = interleaveByOrigin(vk);
  const tgOrdered = interleaveByOrigin(tg);
  const order = [
    { name: 'vk', items: vkOrdered },
    { name: 'tg', items: tgOrdered },
    { name: 'reddit', items: reddit },
    { name: 'yt', items: yt },
    { name: 'rt', items: rt },
  ];
  const slot = Math.floor(Date.now() / (15 * 60 * 1000));
  const shift = slot % order.length;
  const rotated = [...order.slice(shift), ...order.slice(0, shift)];
  console.log(`slot=${slot} order=${rotated.map((b) => b.name).join(' → ')}`);
  return rotated.flatMap((b) => b.items);
}

async function ddgImageSearch(query) {
  try {
    const url1 = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`;
    const html = await (await fetch(url1, { headers: { 'User-Agent': BROWSER_UA } })).text();
    const m = html.match(/vqd=["']?([\w-]+)/);
    if (!m) return [];
    const vqd = m[1];
    const q = new URLSearchParams({ l: 'ru-ru', o: 'json', q: query, vqd, f: ',,,,,', p: '1' });
    const r2 = await fetch(`https://duckduckgo.com/i.js?${q}`, {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://duckduckgo.com/', Accept: 'application/json' },
    });
    if (!r2.ok) return [];
    const j = await r2.json();
    return (j.results || [])
      .filter((r) => (r.width || 0) >= 500 && (r.height || 0) >= 500 && /\.(jpe?g|png)(\?|$)/i.test(r.image));
  } catch (e) {
    console.warn('ddg search failed:', e.message);
    return [];
  }
}

async function fetchDdgCandidates(query, tag) {
  const results = await ddgImageSearch(query);
  console.log(`ddg[${tag}] "${query}" → ${results.length}`);
  const shuffled = results.sort(() => Math.random() - 0.5);
  return shuffled.map((r) => ({
    source: 'ddg',
    id: `ddg:${tag}:${md5(Buffer.from(r.image))}`,
    origin: `DuckDuckGo / ${tag}`,
    title: '',
    url: r.image,
    ups: 0,
  }));
}

async function fetchCandidatesForMode(mode) {
  switch (mode) {
    case 'morning':
    case 'monday_morning':
      return fetchDdgCandidates('доброе утро картинка', 'morning');
    case 'night':
      return fetchDdgCandidates('спокойной ночи картинка', 'night');
    case 'friday':
    case 'weekend_sat':
    case 'weekend_sun':
      return fetchMemeCandidates();
    case 'cashback':
      return fetchDdgCandidates('кешбэк карта деньги', 'cashback');
    case 'cats': {
      const [vk, tg] = await Promise.all([
        fetchVkCandidates(CATS_VK, 0),
        fetchTgCandidates(CATS_TG),
      ]);
      console.log(`cats: vk=${vk.length} tg=${tg.length}`);
      const vkOrdered = interleaveByOrigin(vk);
      const tgOrdered = interleaveByOrigin(tg);
      const order = [
        { name: 'tg', items: tgOrdered },
        { name: 'vk', items: vkOrdered },
      ].sort(() => Math.random() - 0.5);
      return order.flatMap((b) => b.items);
    }
    case 'lunch': {
      const reddit = await fetchRedditCandidates(FOOD_SUBS);
      reddit.sort((a, b) => b.ups - a.ups);
      return reddit;
    }
    case 'fact': {
      const [vk, tg] = await Promise.all([
        fetchVkCandidates(FACT_VK, 0),
        fetchTgCandidates(FACT_TG),
      ]);
      // требуем осмысленный текст: если факт «зашит» в картинку без описания —
      // после публикации пользователь увидит только «🧠 Познавательная минутка»
      const MIN_FACT_TEXT_LEN = 50;
      const withText = [...vk, ...tg].filter((p) => (p.title || '').length >= MIN_FACT_TEXT_LEN);
      console.log(`fact: vk=${vk.length} tg=${tg.length} → ${withText.length} with text ≥ ${MIN_FACT_TEXT_LEN}`);
      const vkOrdered = interleaveByOrigin(withText.filter((p) => p.source === 'vk'));
      const tgOrdered = interleaveByOrigin(withText.filter((p) => p.source === 'tg'));
      const order = [
        { name: 'tg', items: tgOrdered },
        { name: 'vk', items: vkOrdered },
      ].sort(() => Math.random() - 0.5);
      return order.flatMap((b) => b.items);
    }
    default:
      return fetchMemeCandidates();
  }
}

async function downloadImage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get('content-type') || 'image/jpeg';
  return { buf, ctype };
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const TG_MESSAGE_LIMIT = 4096;

function splitAt(text, limit) {
  if (text.length <= limit) return { head: text, tail: '' };
  const search = text.slice(0, limit);
  for (const sep of ['\n\n', '\n', '. ', '! ', '? ', ' ']) {
    const idx = search.lastIndexOf(sep);
    if (idx > limit * 0.6) {
      return {
        head: text.slice(0, idx + sep.length).trim(),
        tail: text.slice(idx + sep.length).trim(),
      };
    }
  }
  return { head: text.slice(0, limit).trim(), tail: text.slice(limit).trim() };
}

function makeCaptionParts(post, themedPrefix = '') {
  const text = (post.title || '').trim();
  const prefix = themedPrefix ? themedPrefix + (text ? '\n\n' : '') : '';
  if (!text) return { head: prefix, tail: '' };
  const budget = CAPTION_HARD_LIMIT - prefix.length;
  if (text.length <= budget) return { head: prefix + text, tail: '' };
  const { head, tail } = splitAt(text, budget);
  return { head: prefix + head, tail: truncate(tail, TG_MESSAGE_LIMIT) };
}

async function downloadVideo(sourceUrl) {
  // прямая mp4-ссылка (TG telesco.pe и подобные) — обычный fetch, без yt-dlp overhead
  if (/\.mp4(\?|$)/i.test(sourceUrl)) {
    const r = await fetch(sourceUrl, { headers: { 'User-Agent': BROWSER_UA } });
    if (!r.ok) throw new Error(`video HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return { buf, ctype: r.headers.get('content-type') || 'video/mp4' };
  }
  const tmpFile = path.join(os.tmpdir(), `meme-farm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('yt-dlp', [
        '-f', 'best[filesize<50M][height<=720]/best[height<=720]/best',
        '--no-warnings',
        '--no-playlist',
        '--merge-output-format', 'mp4',
        '-o', tmpFile,
        sourceUrl,
      ]);
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp exit ${code}: ${stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`));
      });
    });
    const buf = await readFile(tmpFile);
    return { buf, ctype: 'video/mp4' };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

async function extractFirstFrame(videoBuf) {
  const tmpVid = path.join(os.tmpdir(), `meme-farm-frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
  await writeFile(tmpVid, videoBuf);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', tmpVid,
        '-vframes', '1',
        '-f', 'image2pipe',
        '-vcodec', 'png',
        'pipe:1',
      ]);
      const chunks = [];
      let stderr = '';
      child.stdout.on('data', (d) => chunks.push(d));
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 200)}`));
      });
    });
  } finally {
    await unlink(tmpVid).catch(() => {});
  }
}

async function sendVideo(videoBuf, caption) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('video', new Blob([videoBuf], { type: 'video/mp4' }), 'video.mp4');
  if (caption) form.append('caption', caption);
  form.append('supports_streaming', 'true');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, {
    method: 'POST',
    body: form,
  });
  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(`telegram sendVideo: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function sendPhoto(imageBuf, ctype, caption) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  if (caption) form.append('caption', caption);
  const ext = ctype.includes('png') ? 'png' : 'jpg';
  form.append('photo', new Blob([imageBuf], { type: ctype }), `meme.${ext}`);
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(`telegram: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function sendMessage(text, replyTo) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('text', text);
  if (replyTo) form.append('reply_to_message_id', String(replyTo));
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    body: form,
  });
  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(`telegram sendMessage: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function postTail(sendResult, tail) {
  if (!tail) return;
  const msgId = sendResult?.result?.message_id;
  try {
    await sendMessage(tail, msgId);
  } catch (e) {
    console.warn(`tail send failed: ${e.message}`);
  }
}

function detectAd(text) {
  if (!text) return null;
  const hardHits = AD_HARD_TRIGGERS.filter((t) => t.re.test(text)).map((t) => 'hard:' + t.name);
  if (hardHits.length) return hardHits;
  const softHits = AD_TRIGGERS.filter((t) => t.re.test(text)).map((t) => t.name);
  return softHits.length >= AD_MIN_TRIGGERS ? softHits : null;
}

async function classifyPost(text) {
  if (!GEMINI_KEY) return null;
  const clean = (text || '').trim();
  if (clean.length < 10) return null;
  const prompt = `Ты фильтр контента для русскоязычного мем-канала. Проверь текст поста и верни JSON с 4 булевыми ключами:
- ad: реклама/промо/тизер канала/партнёрская интеграция
- lowquality: бессмысленный, скучный, без сути
- foreign: написан не на русском (английский, украинский и т.п.)
- offtopic: не мем/не юмор (новость, серьёзное объявление, инструкция)

Пост:
"""
${clean.slice(0, 1000)}
"""

Ответ строго в формате JSON без пояснений.`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 100,
            responseMimeType: 'application/json',
          },
        }),
      }
    );
    if (!res.ok) {
      console.warn(`gemini HTTP ${res.status}`);
      return null;
    }
    const j = await res.json();
    const raw = j.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('gemini failed:', e.message);
    return null;
  }
}

async function tryPost(candidates, dedup, themedPrefix) {
  for (const post of candidates) {
    const urlHash = md5(post.url);
    if (dedup.has(urlHash) || dedup.has(post.id)) continue;

    const adHits = detectAd(post.title);
    if (adHits) {
      console.log(`skip ad [${adHits.join(', ')}]: ${post.title.slice(0, 60)}`);
      dedup.add(post.id);
      continue;
    }

    const cls = await classifyPost(post.title);
    if (cls) {
      const bad = ['ad', 'lowquality', 'foreign', 'offtopic'].filter((k) => cls[k]);
      if (bad.length) {
        console.log(`skip llm [${bad.join(', ')}]: ${post.title.slice(0, 60)}`);
        dedup.add(post.id);
        continue;
      }
    }

    const labelMap = { reddit: `r/${post.origin}`, vk: `vk/${post.origin}`, tg: `tg/${post.origin}`, yt: `yt/${post.origin}`, rt: `rt/${post.origin}`, ddg: post.origin };
    const label = labelMap[post.source] || post.origin;

    if (post.mediaType === 'video') {
      let vid;
      try {
        vid = await downloadVideo(post.url);
      } catch (e) {
        console.warn(`skip video ${post.url}: ${e.message}`);
        dedup.add(post.id);
        continue;
      }
      if (vid.buf.length > VIDEO_MAX_BYTES) {
        console.warn(`skip video ${post.url}: too big (${(vid.buf.length / 1024 / 1024).toFixed(1)} MB)`);
        dedup.add(post.id);
        continue;
      }
      const vidHash = md5(vid.buf);
      if (dedup.has(vidHash)) {
        dedup.add(urlHash);
        continue;
      }
      let phashHash = '';
      try {
        const frame = await extractFirstFrame(vid.buf);
        phashHash = await computePhash(frame);
        if (findVisualDuplicate(phashHash, dedup)) {
          console.log(`skip video ${post.url}: visual duplicate`);
          dedup.add(urlHash);
          dedup.add(vidHash);
          continue;
        }
      } catch (e) {
        console.warn('video phash failed, md5-only:', e.message);
      }
      const { head, tail } = makeCaptionParts(post, themedPrefix);
      console.log(`posting ${label} 📹 · ${post.ups} · ${post.title.slice(0, 60)} · ${(vid.buf.length / 1024 / 1024).toFixed(1)}MB${tail ? ` · +tail ${tail.length}` : ''}`);
      const sent = await sendVideo(vid.buf, head);
      await postTail(sent, tail);
      dedup.add(urlHash);
      dedup.add(vidHash);
      dedup.add(post.id);
      if (phashHash) dedup.add(phashHash);
      return true;
    }

    let img;
    try {
      img = await downloadImage(post.url);
    } catch (e) {
      console.warn(`skip ${post.url}: ${e.message}`);
      continue;
    }
    if (img.buf.length > 9 * 1024 * 1024) {
      console.warn(`skip ${post.url}: too big (${img.buf.length} bytes)`);
      continue;
    }

    const imgHash = md5(img.buf);
    if (dedup.has(imgHash)) {
      dedup.add(urlHash);
      continue;
    }

    let phashHash = '';
    try {
      phashHash = await computePhash(img.buf);
      if (findVisualDuplicate(phashHash, dedup)) {
        console.log(`skip ${post.url}: visual duplicate`);
        dedup.add(urlHash);
        dedup.add(imgHash);
        continue;
      }
    } catch (e) {
      console.warn('phash failed, falling back to md5-only:', e.message);
    }

    const { head, tail } = makeCaptionParts(post, themedPrefix);
    console.log(`posting ${label} · ${post.ups} ups · ${post.title.slice(0, 60)}${tail ? ` · +tail ${tail.length}` : ''}`);
    const sent = await sendPhoto(img.buf, img.ctype, head);
    await postTail(sent, tail);

    dedup.add(urlHash);
    dedup.add(imgHash);
    dedup.add(post.id);
    if (phashHash) dedup.add(phashHash);
    return true;
  }
  return false;
}

async function main() {
  const dedup = await loadDedup();
  console.log(`dedup size: ${dedup.size}`);

  const rawMode = currentMode();
  const slotKey = `slot:${rawMode}:${todayMSK()}`;
  const mode =
    rawMode !== 'meme' && dedup.has(slotKey) ? 'meme' : rawMode;
  console.log(`raw mode: ${rawMode} · effective: ${mode}`);

  let posted = false;
  let usedThemed = false;

  if (mode !== 'meme') {
    let candidates = [];
    let themedPrefix = '';
    if (mode === 'holiday') {
      const holidayName = await getTodayHoliday();
      if (holidayName) {
        themedPrefix = pickHolidayTemplate(holidayName);
        candidates = await fetchHolidayCandidates(holidayName);
      }
    } else {
      themedPrefix = pickCaption(mode);
      candidates = await fetchCandidatesForMode(mode);
    }
    if (candidates.length) {
      posted = await tryPost(candidates, dedup, themedPrefix);
      usedThemed = posted;
    } else {
      console.log(`themed mode ${mode}: 0 candidates, falling back to meme`);
    }
  }

  if (!posted) {
    console.log('meme fallback');
    const candidates = await fetchMemeCandidates();
    console.log(`candidates: ${candidates.length}`);
    posted = await tryPost(candidates, dedup, '');
  }

  if (posted) {
    if (usedThemed) dedup.add(slotKey);
    await saveDedup(dedup);
    console.log('done');
  } else {
    console.log('no fresh candidates this run');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
