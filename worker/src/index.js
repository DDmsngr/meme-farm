const COOLDOWN_SEC = 300; // 5 минут per user
const MAX_INPUT_LEN = 1000;
const MAX_REPLY_LEN = 200;

const PROMPT_SYSTEM = `Ты — бот в русском мемном телеграм-чате @memepul.
Тебе пишут в комментариях к постам или в чате.
Ответь ОДНОЙ короткой шутливой фразой на русском (максимум 15 слов).
Тон: игривый, мемный, слегка дерзкий, разговорный.
Никаких хештегов, ссылок, вопросов к пользователю, обзывательств, политики, банков.
Если сообщение непонятное/провокация/оскорбление — верни null.
Верни JSON: {"reply": "текст"} или {"reply": null}.`;

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') {
      return new Response('meme-farm chat bot alive');
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (secret !== env.WEBHOOK_SECRET) {
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
  const msg = update.message || update.edited_message;
  if (!msg) return;
  if (msg.from?.is_bot) return; // не отвечаем ботам
  if (!msg.text && !msg.caption) return; // только текстовые
  const text = (msg.text || msg.caption).slice(0, MAX_INPUT_LEN).trim();
  if (!text) return;

  const userId = String(msg.from.id);
  const chatId = msg.chat.id;

  // cooldown per user
  const cdKey = `cd:${userId}`;
  if (await env.COOLDOWNS.get(cdKey)) {
    console.log(`cooldown active for ${userId}`);
    return;
  }

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
  if (!apiKey) return null;
  const body = {
    contents: [{ parts: [{ text: `${PROMPT_SYSTEM}\n\nСообщение пользователя:\n"""\n${userText}\n"""` }] }],
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 120,
      responseMimeType: 'application/json',
    },
  };
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!r.ok) {
      console.warn(`gemini HTTP ${r.status}`);
      return null;
    }
    const j = await r.json();
    const raw = j.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const t = (parsed?.reply || '').trim();
    return t && t.length > 1 ? t : null;
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
