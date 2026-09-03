const COOLDOWN_SEC = 60; // 1 минута per user
const MAX_INPUT_LEN = 1000;
const MAX_REPLY_LEN = 200;

const MY_BOT_ID = 8873221319;        // @Meme_farm_poster_bot — не отвечаем сами себе
const MY_CHANNEL_ID = -1004464094291; // @memepul — автопосты канала не считаем

const PROMPT_SYSTEM = `Ты — бот в русском мемном телеграм-чате @memepul.
Тебе пишут в комментариях к постам или в чате.
Ответь ОДНОЙ короткой законченной фразой на русском (максимум 10 слов, не длиннее 80 символов).
Тон: игривый, мемный, слегка дерзкий, разговорный.
Никаких хештегов, ссылок, вопросов к пользователю, обзывательств, политики, банков.
Если сообщение непонятное/провокация/оскорбление — ответь просто словом: SKIP.
Верни ТОЛЬКО законченную фразу целиком, без кавычек, без пояснений, без обрывов на середине.`;

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') {
      return new Response('meme-farm chat bot alive');
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    const secret = (request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '').trim();
    const expected = (env.WEBHOOK_SECRET || '').trim();
    if (secret !== expected) {
      console.log(`403: secret mismatch. got_len=${secret.length} exp_len=${expected.length} got_head=${secret.slice(0, 4)} exp_head=${expected.slice(0, 4)}`);
      return new Response('forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('bad json', { status: 400 });
    }

    // не тормозим TG — отвечаем 200 сразу, обрабатываем в фоне
    ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error('handler:', e.message)));
    return new Response('ok');
  },
};

async function handleUpdate(update, env) {
  console.log('update keys:', Object.keys(update).join(','));
  const msg = update.message || update.edited_message || update.channel_post;
  if (!msg) {
    console.log('no message in update');
    return;
  }
  console.log(`msg chat=${msg.chat?.id} type=${msg.chat?.type} from=${msg.from?.id} bot=${msg.from?.is_bot} text=${!!msg.text} caption=${!!msg.caption} keys=${Object.keys(msg).join(',')}`);

  if (msg.from?.id === MY_BOT_ID) { console.log('skip: from myself'); return; }
  if (msg.from?.id === 777000) { console.log('skip: telegram service (channel autoforward)'); return; }
  if (msg.sender_chat?.id === MY_CHANNEL_ID) { console.log('skip: autopost from our own channel'); return; }
  if (!msg.text && !msg.caption) { console.log('skip: no text/caption'); return; }
  const text = (msg.text || msg.caption).slice(0, MAX_INPUT_LEN).trim();
  if (!text) { console.log('skip: empty text'); return; }

  const userId = String(msg.from.id);
  const chatId = msg.chat.id;

  const cdKey = `cd:${userId}`;
  if (await env.COOLDOWNS.get(cdKey)) {
    console.log(`skip: cooldown active for ${userId}`);
    return;
  }

  console.log(`asking gemini for "${text.slice(0, 60)}"`);
  const reply = await geminiReply(text, env.GEMINI);
  if (!reply) {
    console.log(`gemini declined reply for "${text.slice(0, 40)}"`);
    return;
  }

  await tgSendMessage(env.BOT_TOKEN, chatId, reply.slice(0, MAX_REPLY_LEN), msg.message_id);
  await env.COOLDOWNS.put(cdKey, '1', { expirationTtl: COOLDOWN_SEC });
  console.log(`replied ${userId}@${chatId}: ${reply.slice(0, 60)}`);
}

async function geminiReply(userText, apiKey) {
  const key = (apiKey || '').trim();
  if (!key) { console.warn('gemini: no key'); return null; }
  const body = {
    contents: [{ parts: [{ text: `${PROMPT_SYSTEM}\n\nСообщение пользователя:\n"""\n${userText}\n"""` }] }],
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 2000,
    },
  };
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`gemini HTTP ${r.status}: ${errText.slice(0, 300)} · key_len=${key.length} head=${key.slice(0, 4)}`);
      return null;
    }
    const j = await r.json();
    const finish = j.candidates?.[0]?.finishReason;
    const raw = j.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log(`gemini finish=${finish} raw: ${JSON.stringify(raw).slice(0, 200)}`);
    if (!raw) return null;
    let t = raw.trim().replace(/^["'«]+|["'»]+$/g, '').trim();
    if (!t || t.length < 2) return null;
    if (/^skip$/i.test(t)) return null;
    return t;
  } catch (e) {
    console.warn('gemini failed:', e.message);
    return null;
  }
}

async function tgSendMessage(botToken, chatId, text, replyTo) {
  const body = { chat_id: chatId, text };
  if (replyTo) body.reply_to_message_id = replyTo;
  const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    console.warn(`tg sendMessage ${r.status}: ${t.slice(0, 200)}`);
  }
  return r;
}
