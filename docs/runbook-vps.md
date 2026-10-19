# Эксплуатация сервера «Съедим» на VPS (Timeweb), с 18.10.2026

Сервер: Ubuntu, `104.171.138.56`, процесс Node под systemd (`sedim`), HTTPS через Caddy, API на
`https://api.s-edim.ru`. Код — `/opt/sedim` (git), база — `/var/lib/sedim/data.db`, секреты — `/etc/sedim/env`
(права 600, значения никогда не присылайте в чат). Render остановлен (Suspend) и удаляется 25.10.2026.

Вход: `ssh -i ~/.ssh/sedim root@104.171.138.56` (или «Консоль» в панели Timeweb).

## Каждый день

- Утром приходит дайджест от бота (12:00 по Москве). Тишина больше суток — смотрите сервер (см. «Упал»).
- Внешний монитор: проверять `https://api.s-edim.ru/health` каждые 5 минут (UptimeRobot или аналог) с уведомлением вам.
  `/health` отвечает `{"ok":true,"schema":3}`, а если база не читается — 503.

## Обновление кода

```bash
bash /opt/sedim/server/deploy/deploy.sh
```

Скрипт делает `git pull`, `npm ci`, перезапуск и проверку `/health`. Процесс при остановке дописывает начатые запросы
(до 10 с). Фронтенд обновляется отдельно (GitHub Pages) и на сервере не нужен.

**Откат кода.** `cd /opt/sedim && git log --oneline -5`, затем `git checkout <коммит> && bash server/deploy/deploy.sh`.
Если после обновления применилась миграция схемы (`journalctl -u sedim | grep миграц`), старый код откажется
стартовать на новой базе — тогда откат только вместе с восстановлением базы из копии (ниже).

## Резервные копии

- Каждые сутки `VACUUM INTO` в `/var/lib/sedim/backups/sedim-ГГГГ-ММ-ДД.db`: 7 суточных и 4 воскресных. Бот пишет
  «✅ Бэкап сделан» (или файл в Telegram, пока не выключена отправка).
- Файл в Telegram выключается строкой `BACKUP_TELEGRAM_FILE=off` в `/etc/sedim/env` + перезапуск. Включать это нужно
  после того, как в панели Timeweb включены **снимки диска** (копия вне самого сервера).
- Сделать копию сейчас: команда `/backup` у бота.

**Восстановить базу:**

```bash
systemctl stop sedim
cp /var/lib/sedim/data.db /var/lib/sedim/data.db.before-restore   # на всякий случай
cp /var/lib/sedim/backups/sedim-ГГГГ-ММ-ДД.db /var/lib/sedim/data.db
chown sedim:sedim /var/lib/sedim/data.db && chmod 600 /var/lib/sedim/data.db
systemctl start sedim && curl -s http://127.0.0.1:3000/health
```

## Скрипты из `server/scripts/`

Запускать от пользователя сервиса и с его окружением, иначе файлы базы могут стать принадлежащими root:

```bash
cd /opt/sedim/server
sudo -u sedim bash -c 'set -a; . /etc/sedim/env; set +a; node scripts/delete-user.js <telegram_user_id>'
```

То же для `set-pro.js`, `reset-pro.js`, `grant-credit.js`. `probe-vkusvill.js` — проверка каталога с адреса сервера
(повторять не чаще раза в несколько минут: частые запросы блокируются).

## Секреты

Переменные: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `HASH_SECRET`, `ADMIN_TELEGRAM_ID`,
`YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY` (образец — `server/deploy/sedim.env.example`). Поменять одну:

```bash
sedim-setenv TELEGRAM_BOT_TOKEN        # скрытый ввод, значение нигде не печатается
systemctl restart sedim
```

- **Токен бота:** @BotFather → `/revoke` → новый → `sedim-setenv` → `setWebhook` с новым токеном и тем же секретом
  → проверить `/start`. До обновления все запросы приложения получат 401.
- **`HASH_SECRET`** менять нельзя (хэши удалённых аккаунтов перестанут совпадать); при смене токена он остаётся.
- **Ключ ЮKassa:** выпустить новый в кабинете → `sedim-setenv YOOKASSA_SECRET_KEY` → перезапуск → тестовый платёж.

## Что делать, если

- **`/health` не отвечает.** `systemctl status sedim caddy`, `journalctl -u sedim -n 80`. Сервис упал — `systemctl restart sedim`.
  Сервер выключен/завис — панель Timeweb → перезагрузка. ЮKassa повторяет вебхук сутки, сверка смотрит платежи
  за последние 48 часов: простой дольше двух суток нельзя оставлять без проверки платежей вручную.
- **Каталог ВкусВилл «не отвечает».** `/diag` у бота. Блокировка адреса по частоте запросов обычно отпускает через
  5–30 минут; подогрев сам встаёт на паузу на 30 минут после сбоя. Не запускайте пробу в цикле. Выключить подогрев:
  `WARMUP=off` в `/etc/sedim/env` и перезапуск.
- **Форма ответа каталога изменилась** (было с `xml_id` → `id`). Сверить с живым ответом: `curl -X POST https://mcp.vkusvill.ru/mcp`
  (JSON-RPC `tools/list` и `tools/call`), поправить разбор в `src/lib/vkusvillMcp.js` и `server/src/vkusvillPrices.js`.
- **Платёж завис в `pending` / `review`.** См. раздел в `server/README.md`.
- **Удалить данные пользователя** (запрос в поддержку): скрипт `delete-user.js` (выше). Копии в бэкапах и в Telegram-чате
  удаляются вручную; платежи остаются (бухучёт).
- **Откат на Render** (в первую неделю): Render → Resume, DNS `api` вернуть на CNAME `meal-planner-a96v.onrender.com`,
  остановить `sedim` на VPS. Данные, записанные на VPS после 18.10.2026, на Render не попадут.

## Удаление Render (25.10.2026)

Если неделя без проблем: Render → удалить сервис и диск (там лежит копия базы с данными пользователей), затем
подтвердить это в политике конфиденциальности (дата уже указана в `public/privacy.html`).
