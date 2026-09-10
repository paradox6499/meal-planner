// Точка входа — единственный файл, который читает переменные окружения и
// реально запускает процесс. Всё остальное (app.js, db.js, scheduler.js)
// принимает конфигурацию параметрами, чтобы быть тестируемым без реального
// порта/файла/окружения.
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { runReminderTick } from "./scheduler.js";
import { runDigest } from "./digest.js";
import { runBackup } from "./backup.js";

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

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN не задан — без него нельзя ни проверить initData, ни отправить напоминание. Задайте переменную окружения и перезапустите.");
  process.exit(1);
}

const db = openDb(DB_PATH);
const server = createApp(db, { botToken: BOT_TOKEN });

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
