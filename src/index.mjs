import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEDUP_PATH = path.resolve(__dirname, '..', 'dedup.json');
const DEDUP_LIMIT = 5000;

const SUBREDDITS = ['memes', 'dankmemes', 'wholesomememes', 'funny', 'ProgrammerHumor'];
const MIN_UPS = 500;
const MAX_TITLE_LEN = 200;
const MAX_MEME_TEXT_LEN = 500;
const CAPTION_HARD_LIMIT = 1000;
const OCR_MIN_CONFIDENCE = 62;
const OCR_MIN_LATIN_RATIO = 0.70;
const OCR_MIN_WORDS = 5;
const OCR_MIN_LEN = 20;
const PER_SUB_LIMIT = 25;
const USER_AGENT = 'meme-farm/1.0';
const TRANSLATE_EMAIL = 'mastershtormtrooper@gmail.com';
const MEME_API = 'https://meme-api.com/gimme';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

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

async function fetchAllCandidates() {
  const buckets = await Promise.all(
    SUBREDDITS.map(async (sub) => {
      try {
        const memes = await fetchSubreddit(sub);
        return memes.filter(isGoodPost).map((p) => ({
          id: postIdFromLink(p.postLink),
          sub: p.subreddit,
          title: p.title || '',
          url: p.url,
          ups: p.ups || 0,
          permalink: p.postLink,
        }));
      } catch (e) {
        console.warn(`[${sub}] fetch failed:`, e.message);
        return [];
      }
    })
  );
  return buckets.flat().sort((a, b) => b.ups - a.ups);
}

async function downloadImage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get('content-type') || 'image/jpeg';
  return { buf, ctype };
}

async function translate(text) {
  const clean = text.trim().slice(0, 480);
  if (!clean) return '';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=en|ru&de=${encodeURIComponent(TRANSLATE_EMAIL)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return clean;
    const json = await res.json();
    const translated = json?.responseData?.translatedText;
    if (typeof translated === 'string' && translated.length > 0) {
      return translated;
    }
    return clean;
  } catch (e) {
    console.warn('translate failed:', e.message);
    return clean;
  }
}

async function extractMemeText(imageBuf) {
  let worker;
  try {
    worker = await createWorker('eng');
    const { data } = await worker.recognize(imageBuf);
    const text = data.text.replace(/\s+/g, ' ').trim();
    const noSpace = text.replace(/\s/g, '');
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    const ratio = noSpace.length ? latin / noSpace.length : 0;
    const words = text ? text.split(' ').length : 0;
    const ok =
      data.confidence >= OCR_MIN_CONFIDENCE &&
      ratio >= OCR_MIN_LATIN_RATIO &&
      words >= OCR_MIN_WORDS &&
      text.length >= OCR_MIN_LEN;
    console.log(`ocr conf=${data.confidence.toFixed(0)} words=${words} latin%=${(ratio * 100).toFixed(0)} → ${ok ? 'keep' : 'skip'}`);
    return ok ? text.slice(0, MAX_MEME_TEXT_LEN) : '';
  } catch (e) {
    console.warn('ocr failed:', e.message);
    return '';
  } finally {
    if (worker) await worker.terminate();
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function makeCaption(post, translatedTitle, translatedMemeText) {
  const title = truncate(translatedTitle || '', MAX_TITLE_LEN);
  const via = `via r/${post.sub}`;
  let caption = title + '\n\n' + via;
  if (translatedMemeText) {
    const memePart = '💬 ' + truncate(translatedMemeText, MAX_MEME_TEXT_LEN);
    caption = title + '\n\n' + memePart + '\n\n' + via;
  }
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
    if (dedup.has(urlHash) || dedup.has(`id:${post.id}`)) continue;

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

    const rawMemeText = await extractMemeText(img.buf);
    const [translatedTitle, translatedMemeText] = await Promise.all([
      translate(post.title),
      rawMemeText ? translate(rawMemeText) : Promise.resolve(''),
    ]);
    const caption = makeCaption(post, translatedTitle, translatedMemeText);

    console.log(`posting r/${post.sub} · ${post.ups} ups · ${post.title.slice(0, 60)}`);
    await sendPhoto(img.buf, img.ctype, caption);

    dedup.add(urlHash);
    dedup.add(imgHash);
    dedup.add(`id:${post.id}`);
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
