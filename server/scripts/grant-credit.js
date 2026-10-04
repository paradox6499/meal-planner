#!/usr/bin/env node
// Начислить пользователю разовые планы ("ещё один план") вручную — например,
// когда бесплатный план сгорел на сбое каталога ВкусВилл (так было до
// 04.10.2026: сборка из базового набора рецептов засчитывалась в лимит). На
// Render — вкладка Shell: `node scripts/grant-credit.js <telegram_user_id> [сколько]`.
// DB_PATH берётся из того же env, что и сам сервер.
import { openDb, addExtraPlanCredit, getExtraPlanCredits } from "../src/db.js";

const [, , idArg, countArg] = process.argv;
const DB_PATH = process.env.DB_PATH || "./data.db";

const telegramUserId = Number(idArg);
const count = countArg === undefined ? 1 : Number(countArg);
if (!idArg || !Number.isInteger(telegramUserId) || !Number.isInteger(count) || count < 1 || count > 20) {
  console.error("Использование: node scripts/grant-credit.js <telegram_user_id> [сколько, 1..20, по умолчанию 1]");
  process.exit(1);
}

const db = openDb(DB_PATH);
addExtraPlanCredit(db, telegramUserId, count);
console.log(`Готово: пользователю ${telegramUserId} начислено планов: ${count}. Теперь у него: ${getExtraPlanCredits(db, telegramUserId)} (БД: ${DB_PATH})`);
