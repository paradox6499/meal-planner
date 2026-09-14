// Точка входа — единственный файл, который читает переменные окружения и
// реально запускает процесс. Всё остальное (app.js, db.js, scheduler.js)
// принимает конфигурацию параметрами, чтобы быть тестируемым без реального
// порта/файла/окружения.
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { runReminderTick } from "./scheduler.js";
import { runDigest } from "./digest.js";
import { runBackup } from "./backup.js";
import { runProRenewalTick } from "./proRenewal.js";

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || "./data.db";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TICK_INTERVAL_MS = Number(process.env.REMINDER_TICK_MS) || 5 * 60 * 1000; // раз в 5 минут — тот же порядок величины, что и в architecture.md
// Свой telegram_user_id (узнать у @userinfobot) — если задан, раз в сутки
// после DIGEST_HOUR (UTC) бот присылает сводку по событиям/ошибкам прямо в
// личку. Без переменной дайджест просто не запускается — обычный сценарий
// до тех пор, пока не известен получатель.
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR) || 9;
const DIGEST_CHECK_INTERVAL_MS = 15 * 60 * 1000; // достаточно часто, чтобы не проспать нужный час, незачем чаще
// Бэкап БД тем же ботом (см. backup.js) — тоже привязан к ADMIN_TELEGRAM_ID,
// отдельного получателя не заводим. Раз в сутки по умолчанию — размер файла
// на таком масштабе копеечный, слать чаще незачем.
const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS) || 24;
const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
// Секрет для /telegram/webhook (см. app.js) — придумываете сами (любая
// длинная случайная строка), задаётся и здесь, и Telegram-у через setWebhook
// (см. server/README.md). Без него POST /telegram/webhook отклоняет всё —
// нет открытого до настройки состояния "доверяем всем подряд".
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;
// shopId (1460694) не секретен сам по себе — но держим оба значения в одном
// месте и одним и тем же путём (env var, никогда не в коде/чате), чтобы не
// провоцировать "а вдруг можно просто одно из двух". Без обеих переменных
// оплата просто отключена (createApp получит yookassa: null) — тот же
// принцип "фича опциональна, пока не настроена", что и у ADMIN_TELEGRAM_ID
// выше: сервис работает и без оплаты, просто без неё.
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || null;
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || null;
const YOOKASSA = YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY ? { shopId: YOOKASSA_SHOP_ID, secretKey: YOOKASSA_SECRET_KEY } : null;
const PRO_RENEWAL_CHECK_INTERVAL_MS = 60 * 60 * 1000; // раз в час достаточно — окно напоминания (3 дня) намного шире

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN не задан — без него нельзя ни проверить initData, ни отправить напоминание. Задайте переменную окружения и перезапустите.");
  process.exit(1);
}
if (!YOOKASSA) {
  console.log("[pay] YOOKASSA_SHOP_ID/YOOKASSA_SECRET_KEY не заданы — оплата Pro отключена (POST /api/pay/create и /yookassa/webhook вернут 503)");
}

const db = openDb(DB_PATH);
const server = createApp(db, { botToken: BOT_TOKEN, adminTelegramId: ADMIN_TELEGRAM_ID, webhookSecret: WEBHOOK_SECRET, yookassa: YOOKASSA });

server.listen(PORT, () => {
  console.log(`meal-planner-server слушает порт ${PORT}, БД: ${DB_PATH}`);
});

async function tick() {
  try {
    const results = await runReminderTick(db, BOT_TOKEN);
    if (results.length > 0) {
      const sent = results.filter((r) => r.ok).length;
      console.log(`[scheduler] тик: ${sent}/${results.length} напоминаний отправлено`);
    }
  } catch (err) {
    // Тик не должен уронить процесс целиком — следующий тик через
    // TICK_INTERVAL_MS попробует снова.
    console.error("[scheduler] ошибка тика:", err);
  }
}
setInterval(tick, TICK_INTERVAL_MS);
tick(); // не ждать первый интервал при холодном старте

async function digestTick() {
  try {
    const result = await runDigest(db, { botToken: BOT_TOKEN, adminTelegramId: ADMIN_TELEGRAM_ID, digestHour: DIGEST_HOUR });
    if (result.sent) console.log("[digest] отчёт отправлен");
  } catch (err) {
    console.error("[digest] ошибка тика:", err);
  }
}
if (ADMIN_TELEGRAM_ID) {
  setInterval(digestTick, DIGEST_CHECK_INTERVAL_MS);
  digestTick();
} else {
  console.log("[digest] ADMIN_TELEGRAM_ID не задан — ежедневный отчёт отключён");
}

async function backupTick() {
  try {
    const result = await runBackup(db, { botToken: BOT_TOKEN, adminTelegramId: ADMIN_TELEGRAM_ID, intervalHours: BACKUP_INTERVAL_HOURS });
    if (result.sent) console.log(`[backup] отправлен (${result.sizeBytes} байт)`);
  } catch (err) {
    console.error("[backup] ошибка тика:", err);
  }
}
if (ADMIN_TELEGRAM_ID) {
  setInterval(backupTick, BACKUP_CHECK_INTERVAL_MS);
  backupTick();
} else {
  console.log("[backup] ADMIN_TELEGRAM_ID не задан — периодический бэкап отключён");
}

// Напоминание "подписка скоро закончится" (см. proRenewal.js) — не привязано
// к ADMIN_TELEGRAM_ID (это НЕ отчёт админу, а сообщение реальным
// пользователям с активной оплаченной подпиской), не привязано и к YOOKASSA:
// если у кого-то уже есть pro_until из более раннего периода оплаты, а
// оплату временно отключили — напоминание всё равно должно дойти.
async function proRenewalTick() {
  try {
    const results = await runProRenewalTick(db, BOT_TOKEN);
    if (results.length > 0) {
      const sent = results.filter((r) => r.ok).length;
      console.log(`[proRenewal] тик: ${sent}/${results.length} напоминаний о продлении отправлено`);
    }
  } catch (err) {
    console.error("[proRenewal] ошибка тика:", err);
  }
}
setInterval(proRenewalTick, PRO_RENEWAL_CHECK_INTERVAL_MS);
proRenewalTick();
