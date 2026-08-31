import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import phash from 'sharp-phash';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEDUP_PATH = path.resolve(__dirname, '..', 'dedup.json');
const DEDUP_LIMIT = 5000;

const SUBREDDITS = [
  'Pikabu',
  'SlavicMemes',
  'Slavs',
  'gopniks',
  'ANormalDayInRussia',
];
const FOOD_SUBS = ['food', 'FoodPorn', 'tonightsdinner'];
const FACT_VK = ['interesnie_facty', 'FactRoom'];
const FACT_TG = ['FactRoom'];

const THEMED_CAPTIONS = {
  morning: 'Доброе утро! ☀️',
  lunch: 'Приятного аппетита 🍽️',
  fact: '🧠 Познавательная минутка',
  night: 'Спокойной ночи 🌙',
};

const PHASH_THRESHOLD = 6; // Хэмминг-дистанция, ≤ значит визуальный дубль

const AD_TRIGGERS = [
  { name: 'promokod', re: /промокод/i },
  { name: 'discount', re: /скидк[аиоуеы]/i },
  { name: 'coupon', re: /купон/i },
  { name: 'bonus', re: /\bбонус/i },
  { name: 'subscribe', re: /подпи[шс](ись|итесь|аться|ывай)|подписка на канал/i },
  { name: 'go-link', re: /переход(и|ите)\s+по\s+ссылке|по\s+ссылке\s+ниже/i },
  { name: 'ad-tag', re: /#реклама|#ad\b|#промо|#partner/i },
  { name: 'http', re: /https?:\/\//i },
  { name: 'tme', re: /t\.me\//i },
  { name: 'shortener', re: /vk\.cc\/|bit\.ly|clck\.ru|taplink/i },
  { name: 'all-channels', re: /\|\s*(Все|Все наши)\s+каналы|\|\s*Каналы\s+дня/i },
  { name: 'our-channel', re: /наш(и)?\s+канал|мой\s+канал|канал\s+друг/i },
];
const AD_MIN_TRIGGERS = 2;

const MIN_UPS = 20;
const CAPTION_HARD_LIMIT = 1024;
const PER_SUB_LIMIT = 25;
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
];

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const VK_TOKEN = process.env.VK_TOKEN;

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
  if (h === 7 && m < 15) return 'morning';
  if (h === 12 && m < 15) return 'lunch';
  if (h === 15 && m < 15) return 'fact';
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

async function fetchVkCandidates(domains, minLikes = VK_MIN_LIKES) {
  if (!VK_TOKEN) return [];
  const buckets = await Promise.all(
    domains.map(async (domain) => {
      try {
        const items = await fetchVkWall(domain);
        return items
          .filter((p) => !p.marked_as_ads && !p.is_pinned)
          .map((p) => {
            const photo = pickVkPhoto(p);
            if (!photo) return null;
            const likes = p.likes?.count || 0;
            if (likes < minLikes) return null;
            return {
              source: 'vk',
              id: `vk:${p.owner_id}_${p.id}`,
              origin: domain,
              title: (p.text || '').replace(/\s+/g, ' ').trim(),
              url: photo.url,
              ups: likes,
            };
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

function decodeHtml(s) {
  return s
    .replace(/<br\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
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
    const photoM = /tgme_widget_message_photo_wrap[\s\S]*?background-image:url\('([^']+)'/.exec(block);
    if (!photoM) continue;
    const textM = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const viewsM = /tgme_widget_message_views[^>]*>([^<]+)/.exec(block);
    results.push({
      source: 'tg',
      id: `tg:${idM[1]}`,
      origin: channel,
      title: textM ? decodeHtml(textM[1]) : '',
      url: photoM[1],
      ups: viewsM ? parseViews(viewsM[1]) : 0,
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

async function fetchMemeCandidates() {
  const [reddit, vk, tg] = await Promise.all([
    fetchRedditCandidates(SUBREDDITS),
    fetchVkCandidates(VK_DOMAINS),
    fetchTgCandidates(TG_CHANNELS),
  ]);
  console.log(`reddit: ${reddit.length}, vk: ${vk.length}, tg: ${tg.length}`);
  reddit.sort((a, b) => b.ups - a.ups);
  const vkOrdered = interleaveByOrigin(vk);
  const tgOrdered = interleaveByOrigin(tg);
  const order = [
    { name: 'vk', items: vkOrdered },
    { name: 'tg', items: tgOrdered },
    { name: 'reddit', items: reddit },
  ];
  const slot = Math.floor(Date.now() / (15 * 60 * 1000));
  const shift = slot % 3;
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
      return fetchDdgCandidates('доброе утро картинка', 'morning');
    case 'night':
      return fetchDdgCandidates('спокойной ночи картинка', 'night');
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
      console.log(`fact: vk=${vk.length} tg=${tg.length}`);
      const vkOrdered = interleaveByOrigin(vk);
      const tgOrdered = interleaveByOrigin(tg);
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

function makeCaption(post, themedPrefix = '') {
  const text = (post.title || '').trim();
  const parts = [];
  if (themedPrefix) parts.push(themedPrefix);
  if (text) parts.push(text);
  const joined = parts.join('\n\n');
  return joined ? truncate(joined, CAPTION_HARD_LIMIT) : '';
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

function detectAd(text) {
  if (!text) return null;
  const hits = AD_TRIGGERS.filter((t) => t.re.test(text)).map((t) => t.name);
  return hits.length >= AD_MIN_TRIGGERS ? hits : null;
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

    const caption = makeCaption(post, themedPrefix);
    const labelMap = { reddit: `r/${post.origin}`, vk: `vk/${post.origin}`, tg: `tg/${post.origin}`, ddg: post.origin };
    const label = labelMap[post.source] || post.origin;
    console.log(`posting ${label} · ${post.ups} ups · ${post.title.slice(0, 60)}`);
    await sendPhoto(img.buf, img.ctype, caption);

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
    const candidates = await fetchCandidatesForMode(mode);
    if (candidates.length) {
      posted = await tryPost(candidates, dedup, THEMED_CAPTIONS[mode]);
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
