#!/usr/bin/env node
// Удаление всех личных данных пользователя по запросу (152-ФЗ) — на случай,
// когда человек просит об этом через поддержку, а не кнопкой в приложении
// (Аккаунт → «Удалить мои данные»; обе дороги вызывают одну и ту же
// deleteUserData). На Render запускается через Shell-вкладку сервиса:
//   node scripts/delete-user.js 123456789
// DB_PATH берётся из того же env, что и сам сервер — правит ТУ ЖЕ базу.
//
// НЕ удаляет записи об оплатах (payments): это бухгалтерские документы, их
// хранение обязательно по закону. Резервные копии базы, ушедшие админу в
// Telegram (backup.js), этим скриптом не затрагиваются.
import { openDb, deleteUserData } from "../src/db.js";

const [, , idArg] = process.argv;
const DB_PATH = process.env.DB_PATH || "./data.db";

const telegramUserId = Number(idArg);
if (!idArg || !Number.isInteger(telegramUserId)) {
  console.error("Использование: node scripts/delete-user.js <telegram_user_id>");
  process.exit(1);
}

// Тот же секрет, что у сервера (HASH_SECRET, иначе токен бота): по нему пишется
// "надгробие" удалённого аккаунта — необратимый хэш, из-за которого удаление не
// обнуляет бесплатный лимит и не даёт заново получить реферальную награду.
const hashSecret = process.env.HASH_SECRET || process.env.TELEGRAM_BOT_TOKEN;
if (!hashSecret) {
  console.error("Нужна переменная HASH_SECRET (или TELEGRAM_BOT_TOKEN) — как у сервера; на Render в Shell они уже заданы.");
  process.exit(1);
}

const db = openDb(DB_PATH);
const deleted = deleteUserData(db, telegramUserId, { hashSecret });
console.log(`Готово: данные пользователя ${telegramUserId} удалены (БД: ${DB_PATH})`);
console.log(JSON.stringify(deleted, null, 2));
console.log("Платежи сохранены (бухучёт). Не забудьте про копии в бэкапах, если они есть.");
