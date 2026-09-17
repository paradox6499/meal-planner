#!/usr/bin/env node
// Полный сброс Pro-статуса ОДНОГО пользователя — и ручной тумблер (is_pro),
// И оплаченный/подаренный период (pro_until) сразу, одной командой. На
// Render запускается через Shell-вкладку сервиса:
// `node scripts/reset-pro.js <telegram_user_id>`.
//
// Отдельно от set-pro.js <id> off — тот трогает только is_pro, специально
// не затирая pro_until: is_pro (ручной тумблер) и pro_until (оплаченный/
// реферальный период) намеренно независимы (см. db.js/getUserPro и тест
// "is_pro и pro_until — независимы, любого из двух достаточно" в
// db.test.js) — иначе снятие ручного тумблера у кого-то однажды могло бы
// случайно отменить чей-то РЕАЛЬНО оплаченный период. Но для сценария
// "хочу увидеть приложение от лица нового пользователя на своём же
// аккаунте" (тестировали реферальную программу — pro_until в будущем —
// значит одного set-pro.js off тут недостаточно) нужен именно грубый полный
// сброс ОДНОГО явно указанного id — этот скрипт специально для этого, не
// для массовых операций.
import { openDb, setUserPro, getUserPro } from "../src/db.js";

const [, , idArg] = process.argv;
const DB_PATH = process.env.DB_PATH || "./data.db";

if (!idArg) {
  console.error("Использование: node scripts/reset-pro.js <telegram_user_id>");
  process.exit(1);
}

const telegramUserId = Number(idArg);
if (!Number.isInteger(telegramUserId)) {
  console.error(`telegram_user_id должен быть целым числом, получено: ${idArg}`);
  process.exit(1);
}

const db = openDb(DB_PATH);
setUserPro(db, telegramUserId, false);
db.prepare(`UPDATE users SET pro_until = NULL WHERE telegram_user_id = ?`).run(telegramUserId);
console.log(`Готово: пользователь ${telegramUserId} теперь ${getUserPro(db, telegramUserId, new Date().toISOString()) ? "Pro" : "Free"} (is_pro=0, pro_until=NULL; БД: ${DB_PATH})`);
