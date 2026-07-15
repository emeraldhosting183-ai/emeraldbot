# Telegram Business AI Assistant

Production-ready Telegram-бот на Node.js 22 + TypeScript для функции Telegram Business «Автоматизация чатов». Получает обновления через webhook, хранит раздельную историю диалогов в PostgreSQL и отвечает от имени подключённого бизнес-профиля через OpenAI Responses API или Gemini.

## Что реализовано

- `business_connection`, `business_message`, `edited_business_message`, `deleted_business_messages` и обычные `message` для команд владельца.
- Проверка `is_enabled` и `rights.can_reply`; ответы всегда отправляются с нужным `business_connection_id`.
- Несколько бизнес-подключений без смешивания истории и настроек чатов.
- Защита от повторных updates/messages и от ответов на собственные сообщения бота.
- Durable PostgreSQL-очередь с debounce, объединением быстрых сообщений, отменой устаревшей генерации, lease/heartbeat, retry и exponential backoff.
- История до 30 сообщений текущего чата, индивидуальный/глобальный стиль, allowlist/denylist, ручной режим, расписание, cooldown и задержка ответа.
- OpenAI (`gpt-5.4` по умолчанию) и Gemini (`gemini-3.5-flash` по умолчанию).
- Безопасный webhook: secret token, лимит body 256 KB, rate limiting, Helmet и логи без текста личных сообщений и секретов.
- `GET /health`, graceful shutdown, Prisma migrations, Dockerfile и Railway-конфигурация.

## Структура

```text
prisma/
  migrations/                # начальная SQL-миграция
  schema.prisma              # подключения, чаты, сообщения, очередь, настройки, usage
scripts/
  check-connections.ts       # PostgreSQL + Telegram + выбранный AI
  set-webhook.ts             # установка и проверка Telegram webhook
src/
  ai/                        # OpenAI/Gemini и защищённый prompt
  commands/                  # команды владельца
  config/                    # Zod env и безопасное логирование
  db/                        # Prisma + PostgreSQL adapter
  domain/                    # правила ответов, расписание, стоимость
  health/                    # dependency health probes
  http/                      # Express endpoints и защита webhook
  queue/                     # durable reply queue
  services/                  # Telegram update processing и reply worker
  telegram/                  # типы и клиент чистого Bot API
  utils/
tests/                       # тесты маршрутизации и основной логики
Dockerfile
railway.json
```

## Локальная проверка

Требуются Node.js 22, pnpm 11 и доступный PostgreSQL.

```powershell
corepack enable
corepack prepare pnpm@11.7.0 --activate
Copy-Item .env.example .env.local
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Заполните `.env.local`, затем примените миграции и проверьте подключения:

```powershell
pnpm prisma:migrate
pnpm health:check
pnpm dev
```

Файлы `.env` и `.env.local` исключены из Git и Docker context.

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен от BotFather |
| `TELEGRAM_OWNER_ID` | числовой Telegram ID владельца; только он может выполнять команды |
| `TELEGRAM_WEBHOOK_SECRET` | случайная строка 16–256 символов из `A-Z`, `a-z`, `0-9`, `_`, `-` |
| `PUBLIC_BASE_URL` | публичный HTTPS URL без пути, например `https://service.up.railway.app` |
| `DATABASE_URL` | PostgreSQL connection URL |
| `AI_PROVIDER` | `gemini` или `openai` |
| `GEMINI_API_KEY` | обязателен при `AI_PROVIDER=gemini` |
| `GEMINI_MODEL` | по умолчанию `gemini-3.5-flash` |
| `OPENAI_API_KEY` | обязателен при `AI_PROVIDER=openai` |
| `OPENAI_MODEL` | по умолчанию `gpt-5.4` |
| `AI_INPUT_COST_PER_MILLION` | необязательная цена входных токенов для оценки стоимости |
| `AI_OUTPUT_COST_PER_MILLION` | необязательная цена выходных токенов для оценки стоимости |
| `AI_REQUEST_TIMEOUT_MS` | тайм-аут AI, по умолчанию `60000` |
| `DEFAULT_TIMEZONE` | IANA timezone, по умолчанию `Europe/Kyiv` |
| `LOG_LEVEL` | `info` по умолчанию |
| `PORT` | Railway задаёт автоматически; локально `3000` |

Секрет webhook можно создать локально:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Создание Telegram-бота

1. Откройте `@BotFather`, выполните `/newbot`, задайте имя и `@username`, сохраните токен.
2. В `@BotFather`: `/mybots` → нужный бот → **Bot Settings** (в некоторых клиентах пункт находится в настройках мини-приложения) → **Secretary Mode** → **Enable**.
3. Узнайте свой числовой Telegram user ID и укажите его в `TELEGRAM_OWNER_ID` (это ID личного аккаунта, не ID бота).
4. После деплоя откройте Telegram → **Настройки** → **Автоматизация чатов / Chat Automation**, выберите бота и доступные чаты, затем включите точное право **Отвечать на сообщения / Reply to Messages**. Названия пунктов слегка различаются между версиями Telegram.

Telegram разрешает бизнес-боту отвечать от имени профиля только в чатах, которые были активны за последние 24 часа. Это ограничение платформы, а не приложения.

## Деплой на Railway из GitHub

1. Создайте пустой GitHub-репозиторий и загрузите содержимое проекта. Не загружайте `.env.local`, `node_modules`, `dist`, `src/generated` и служебные папки — они уже перечислены в `.gitignore`.
2. В Railway создайте проект **Deploy from GitHub repo** и выберите репозиторий.
3. Добавьте в тот же Railway-проект PostgreSQL service.
4. Для сервиса приложения создайте переменные:

```dotenv
NODE_ENV=production
TELEGRAM_BOT_TOKEN=<новый токен>
TELEGRAM_OWNER_ID=<ваш числовой ID>
TELEGRAM_WEBHOOK_SECRET=<случайный секрет>
AI_PROVIDER=gemini
GEMINI_API_KEY=<новый Gemini API key>
GEMINI_MODEL=gemini-3.5-flash
DATABASE_URL=${{Postgres.DATABASE_URL}}
DEFAULT_TIMEZONE=Europe/Kyiv
LOG_LEVEL=info
```

Если Railway назвал PostgreSQL service иначе, замените `Postgres` в ссылке на фактическое имя сервиса. Для OpenAI задайте `AI_PROVIDER=openai`, `OPENAI_API_KEY` и при необходимости `OPENAI_MODEL`.

5. В Railway откройте **Settings → Networking → Generate Domain**. Полученный адрес добавьте как `PUBLIC_BASE_URL` без завершающего `/`.
6. В **Settings → Deploy** отключите **Serverless/App Sleeping**: webhook и очередь должны работать постоянно.
7. Запустите новый deploy. `railway.json` соберёт Docker image, до запуска применит Prisma migrations, проверит `/health` и перезапустит процесс при сбое.
8. Дождитесь статуса **Active**. Проверьте:

```text
https://<ваш-домен>/health
```

Ответ `200` означает, что PostgreSQL, Telegram и выбранный AI доступны; при проблеме endpoint возвращает `503` и имя недоступной зависимости без раскрытия ключей.

## Установка webhook

После первого успешного деплоя укажите в локальном `.env.local` те же `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` и `PUBLIC_BASE_URL`, затем выполните:

```powershell
pnpm webhook:set
```

Скрипт вызывает `setWebhook`, включает только `message`, `business_connection`, `business_message`, `edited_business_message`, `deleted_business_messages` и затем проверяет точный список через `getWebhookInfo`. Итоговый endpoint:

```text
POST /telegram/webhook
```

После смены домена, bot token или webhook secret выполните установку webhook повторно.

## Команды владельца

Команды принимаются только от `TELEGRAM_OWNER_ID` в обычном диалоге с ботом:

```text
/start
/status
/pause [chat_id] [connection_id]
/resume [chat_id] [connection_id]
/settings
/style <текст|reset>
/style chat <chat_id> [connection_id] | <стиль|reset>
/history <chat_id> [connection_id] [limit]
/clear <chat_id> [connection_id]
/allow <chat_id> [connection_id]
/deny <chat_id> [connection_id]
```

Основные настройки:

```text
/settings mode all|allowlist
/settings delay <min_ms> <max_ms>
/settings max-length <50..4096>
/settings history <1..30>
/settings debounce <100..10000>
/settings cooldown <0..3600>
/settings timezone Europe/Kyiv
/settings schedule 09:00-22:00 [0,1,2,3,4,5,6] | off
/settings ignore-one-word|ignore-stickers|ignore-reactions|ignore-service on|off
/settings unsupported skip|neutral
/settings unsupported-text <текст>
```

В расписании дни обозначены как `0..6`, где `0` — воскресенье, `1` — понедельник, …, `6` — суббота. Если один `chat_id` встречается в нескольких бизнес-подключениях, дополнительно укажите `connection_id`.

## Безопасность перед production

- Никогда не добавляйте токены в GitHub; используйте только Railway Variables.
- Если API key или bot token были отправлены в чат, issue, лог либо commit, перевыпустите их перед деплоем: bot token — через `@BotFather`, AI key — в кабинете провайдера.
- При смене `TELEGRAM_WEBHOOK_SECRET` обязательно снова выполните `pnpm webhook:set`.
- Не отключайте права ответа у подключённого бизнес-бота: worker перепроверяет их перед каждой отправкой и безопасно пропускает ответ при отзыве права.
