# memepul chat bot (Cloudflare Worker)

Реал-тайм webhook-обработчик входящих сообщений для @memepul_bot. Отвечает шутливой мемной фразой через Gemini.

## Быстрый деплой (один раз)

```bash
cd worker
npm install
npx wrangler login

# 1. Создать KV namespace для cooldown-хранения
npx wrangler kv namespace create COOLDOWNS
# вернёт что-то типа: id = "abc123..."
# скопировать этот id в wrangler.toml → COOLDOWNS.id

# 2. Секреты
npx wrangler secret put BOT_TOKEN     # → paste токен из GH Secrets
npx wrangler secret put GEMINI        # → paste Gemini API key
npx wrangler secret put WEBHOOK_SECRET # → paste любую случайную строку (не запоминать, TG её проверяет автоматически)

# 3. Deploy
npx wrangler deploy
# → печатает URL вроде https://memepul-chat-bot.<username>.workers.dev

# 4. Установить TG webhook (заменить <URL> и <SECRET>)
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"<URL>","secret_token":"<WEBHOOK_SECRET>","allowed_updates":["message"],"drop_pending_updates":true}'
```

## Проверка

- `curl <URL>` → должен вернуть `meme-farm chat bot alive`
- `npx wrangler tail` → живой лог, напиши боту в discussion-чат канала и смотри
- `curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"` — покажет активный webhook и last_error если что-то не так

## Что делает

- POST /webhook принимает `update` от Telegram
- Проверяет `X-Telegram-Bot-Api-Secret-Token`
- Игнорирует ботов и не-текст
- Cooldown 5 минут per user (KV с TTL)
- Отправляет текст в Gemini 2.0-flash → просит короткую мемную фразу (≤15 слов)
- Отвечает в чат reply-ом к исходному сообщению
- Если Gemini вернул null (провокация/оскорбление/непонятно) — не отвечает

## Отключить временно

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook"
```

## Отладка

```bash
npx wrangler tail --format pretty
```
