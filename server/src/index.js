// Точка входа — единственный файл, который читает переменные окружения и
// реально запускает процесс. Всё остальное (app.js, db.js, scheduler.js)
// принимает конфигурацию параметрами, чтобы быть тестируемым без реального
// порта/файла/окружения.
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { runReminderTick } from "./scheduler.js";

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || "./data.db";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TICK_INTERVAL_MS = Number(process.env.REMINDER_TICK_MS) || 5 * 60 * 1000; // раз в 5 минут — тот же порядок величины, что и в architecture.md

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
