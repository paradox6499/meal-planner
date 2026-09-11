// Периодический бэкап SQLite-файла прямо в Telegram-документом разработчику —
// тем же ботом, что шлёт напоминания и дайджест. Не отдельное файловое
// хранилище (S3 и т.п.): пока это один процесс с одним диском на Render,
// заводить лишний вендор ради бэкапа нескольких мегабайт не имеет смысла —
// переиспользуем то, что уже есть.
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getLastBackupAt, setLastBackupAt } from "./db.js";
import { sendTelegramDocument } from "./telegram.js";

export function shouldRunBackup(now, lastBackupAt, intervalHours) {
  if (!lastBackupAt) return true;
  const hoursSince = (now.getTime() - new Date(lastBackupAt).getTime()) / 3_600_000;
  return hoursSince >= intervalHours;
}

/** VACUUM INTO — официальный способ SQLite снять консистентный снимок БД в
 * отдельный файл, не рискуя "порванной" копией, если в этот момент идёт
 * запись (в отличие от простого fs.copyFile исходного файла). Путь мы сами
 * генерируем (os.tmpdir() + время) — не пользовательский ввод, но
 * одинарные кавычки на всякий случай экранируем, раз VACUUM INTO не
 * поддерживает bound-параметры. */
function vacuumInto(db, targetPath) {
  const escaped = targetPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
}

/** Делает и шлёт бэкап ПРЯМО СЕЙЧАС, без проверки "пора ли" — используется и
 * автоматическим тиком (через runBackup ниже), и командой /backup из
 * webhook.js, когда хочется проверить/получить свежий снимок без ожидания
 * следующего интервала. Обновляет last_backup_at в обоих случаях. Не
 * бросает исключение при неудаче (временная сетевая проблема не должна
 * ронять процесс) — просто логируется, вызывающий код решает, что дальше. */
export async function sendBackupNow(db, { botToken, adminTelegramId }, now = new Date()) {
  if (!adminTelegramId) return { sent: false, reason: "ADMIN_TELEGRAM_ID не задан" };

  const tmpPath = join(tmpdir(), `sedim-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    vacuumInto(db, tmpPath);
    const buffer = readFileSync(tmpPath);
    const filename = `sedim-${now.toISOString().slice(0, 10)}.db`;
    await sendTelegramDocument(botToken, adminTelegramId, buffer, filename, `Бэкап базы «Съедим» — ${now.toISOString()}`);
    setLastBackupAt(db, now.toISOString());
    return { sent: true, sizeBytes: buffer.length };
  } catch (err) {
    console.error("[backup] не удалось сделать/отправить бэкап:", err.message);
    return { sent: false, reason: err.message };
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
}

/** Обёртка sendBackupNow с проверкой "пора ли" — то, что реально зовёт
 * планировщик по расписанию (см. index.js). */
export async function runBackup(db, { botToken, adminTelegramId, intervalHours = 24 }, now = new Date()) {
  if (!adminTelegramId) return { sent: false, reason: "ADMIN_TELEGRAM_ID не задан" };

  const lastBackupAt = getLastBackupAt(db);
  if (!shouldRunBackup(now, lastBackupAt, intervalHours)) return { sent: false, reason: "не время" };

  return sendBackupNow(db, { botToken, adminTelegramId }, now);
}
