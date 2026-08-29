import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEDUP_PATH = path.resolve(__dirname, '..', 'dedup.json');
const DEDUP_LIMIT = 5000;

const SUBREDDITS = ['Pikabu'];

const MIN_UPS = 20;
const MAX_TITLE_LEN = 200;
const CAPTION_HARD_LIMIT = 1000;
const PER_SUB_LIMIT = 25;
const USER_AGENT = 'meme-farm/1.0';
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

async function fetchAllCandidates() {
  const [reddit, vk] = await Promise.all([
    fetchAllRedditCandidates(),
    fetchAllVkCandidates(),
  ]);
  console.log(`reddit: ${reddit.length}, vk: ${vk.length}`);
  reddit.sort((a, b) => b.ups - a.ups);
  vk.sort((a, b) => b.ups - a.ups);
  // 15-минутные слоты попеременно: чётный → сначала vk, нечётный → сначала reddit
  const slot = Math.floor(Date.now() / (15 * 60 * 1000));
  const preferVk = vk.length > 0 && slot % 2 === 0;
  console.log(`slot=${slot} prefer=${preferVk ? 'vk' : 'reddit'}`);
  return preferVk ? [...vk, ...reddit] : [...reddit, ...vk];
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

function makeCaption(post) {
  const title = truncate((post.title || '').trim(), MAX_TITLE_LEN);
  const via = post.source === 'vk'
    ? `via vk.com/${post.origin}`
    : `via r/${post.origin}`;
  let caption = title ? title + '\n\n' + via : via;
  if (caption.length > CAPTION_HARD_LIMIT) {
    caption = caption.slice(0, CAPTION_HARD_LIMIT - 1) + '…';
  }
  return caption;
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

    const label = post.source === 'vk' ? `vk/${post.origin}` : `r/${post.origin}`;
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
