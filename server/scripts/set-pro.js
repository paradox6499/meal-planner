#!/usr/bin/env node
// Ручной переключатель Pro-статуса — пока не подключена реальная оплата
// (ЮKassa), это единственный способ выдать/снять Pro. На Render запускается
// через Shell-вкладку сервиса: `node scripts/set-pro.js <telegram_user_id> on|off`.
// DB_PATH берётся из того же env, что и сам сервер — правит ТУ ЖЕ базу,
// что видит production.
import { openDb, setUserPro, getUserPro } from "../src/db.js";

const [, , idArg, actionArg] = process.argv;
const DB_PATH = process.env.DB_PATH || "./data.db";

if (!idArg || !["on", "off"].includes(actionArg)) {
  console.error("Использование: node scripts/set-pro.js <telegram_user_id> on|off");
  process.exit(1);
}

const telegramUserId = Number(idArg);
if (!Number.isInteger(telegramUserId)) {
  console.error(`telegram_user_id должен быть целым числом, получено: ${idArg}`);
  process.exit(1);
}

const db = openDb(DB_PATH);
setUserPro(db, telegramUserId, actionArg === "on");
console.log(`Готово: пользователь ${telegramUserId} теперь ${getUserPro(db, telegramUserId) ? "Pro" : "Free"} (БД: ${DB_PATH})`);
