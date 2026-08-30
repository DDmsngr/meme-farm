import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function fetchAllRedditCandidates() {
  const buckets = await Promise.all(
    SUBREDDITS.map(async (sub) => {
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

async function fetchAllVkCandidates() {
  if (!VK_TOKEN) return [];
  const buckets = await Promise.all(
    VK_DOMAINS.map(async (domain) => {
      try {
        const items = await fetchVkWall(domain);
        return items
          .filter((p) => !p.marked_as_ads && !p.is_pinned)
          .map((p) => {
            const photo = pickVkPhoto(p);
            if (!photo) return null;
            const likes = p.likes?.count || 0;
            if (likes < VK_MIN_LIKES) return null;
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

async function fetchAllTgCandidates() {
  const buckets = await Promise.all(
    TG_CHANNELS.map(async (ch) => {
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

async function fetchAllCandidates() {
  const [reddit, vk, tg] = await Promise.all([
    fetchAllRedditCandidates(),
    fetchAllVkCandidates(),
    fetchAllTgCandidates(),
  ]);
  console.log(`reddit: ${reddit.length}, vk: ${vk.length}, tg: ${tg.length}`);
  reddit.sort((a, b) => b.ups - a.ups);
  vk.sort((a, b) => b.ups - a.ups);
  tg.sort((a, b) => b.ups - a.ups);
  // 3-way ротация по 15-мин слотам: vk → tg → reddit → vk → ...
  const order = [
    { name: 'vk', items: vk },
    { name: 'tg', items: tg },
    { name: 'reddit', items: reddit },
  ];
  const slot = Math.floor(Date.now() / (15 * 60 * 1000));
  const shift = slot % 3;
  const rotated = [...order.slice(shift), ...order.slice(0, shift)];
  console.log(`slot=${slot} order=${rotated.map((b) => b.name).join(' → ')}`);
  return rotated.flatMap((b) => b.items);
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

function attribution(post) {
  const map = {
    reddit: `r/${post.origin}`,
    vk: `vk.com/${post.origin}`,
    tg: `t.me/${post.origin}`,
  };
  return `честно снайдено с ${map[post.source] || post.origin}`;
}

function makeCaption(post) {
  const via = attribution(post);
  const text = (post.title || '').trim();
  if (!text) return via;
  const maxText = CAPTION_HARD_LIMIT - via.length - 2; // '\n\n'
  return truncate(text, maxText) + '\n\n' + via;
}

async function sendPhoto(imageBuf, ctype, caption) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', caption);
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

async function main() {
  const dedup = await loadDedup();
  console.log(`dedup size: ${dedup.size}`);

  const candidates = await fetchAllCandidates();
  console.log(`candidates: ${candidates.length}`);

  for (const post of candidates) {
    const urlHash = md5(post.url);
    if (dedup.has(urlHash) || dedup.has(post.id)) continue;

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

    const caption = makeCaption(post);

    const labelMap = { reddit: `r/${post.origin}`, vk: `vk/${post.origin}`, tg: `tg/${post.origin}` };
    const label = labelMap[post.source] || post.origin;
    console.log(`posting ${label} · ${post.ups} ups · ${post.title.slice(0, 60)}`);
    await sendPhoto(img.buf, img.ctype, caption);

    dedup.add(urlHash);
    dedup.add(imgHash);
    dedup.add(post.id);
    await saveDedup(dedup);
    console.log('done');
    return;
  }

  console.log('no fresh candidates this run');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
