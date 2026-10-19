// Периодический бэкап SQLite-файла прямо в Telegram-документом разработчику —
// тем же ботом, что шлёт напоминания и дайджест. Не отдельное файловое
// хранилище (S3 и т.п.): пока это один процесс с одним диском на Render,
// заводить лишний вендор ради бэкапа нескольких мегабайт не имеет смысла —
// переиспользуем то, что уже есть.
import { readFileSync, unlinkSync, existsSync, statSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getLastBackupAt, setLastBackupAt } from "./db.js";
import { sendTelegramDocument, sendTelegramMessage } from "./telegram.js";

const MAX_BACKUP_BYTES = 45 * 1024 * 1024; // запас под лимит Bot API в 50 МБ

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

// ---- Локальные копии на самом сервере (в РФ) с ротацией ----
// Telegram — чужой сервис за границей: полная база там — трансграничная передача (аудит 19.10.2026). Основная копия
// теперь лежит рядом с базой: 7 суточных и 4 недельных (воскресных). Копии на другом диске/машине делает провайдер
// (снимки диска), а файл в Telegram можно отключить переменной BACKUP_TELEGRAM_FILE=off.
export const LOCAL_BACKUP_DAILY_KEEP = 7;
export const LOCAL_BACKUP_WEEKLY_KEEP = 4;
const LOCAL_NAME_RE = /^sedim-(\d{4})-(\d{2})-(\d{2})\.db$/;
export const localBackupName = (date) => `sedim-${date.toISOString().slice(0, 10)}.db`;

/** Оставляет LOCAL_BACKUP_DAILY_KEEP последних суточных копий и воскресные за LOCAL_BACKUP_WEEKLY_KEEP недель; остальное удаляет. */
export function pruneLocalBackups(dir, now = new Date()) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => LOCAL_NAME_RE.test(f)).sort().reverse(); // новые первыми
  const keep = new Set(files.slice(0, LOCAL_BACKUP_DAILY_KEEP));
  const weeklyFrom = now.getTime() - LOCAL_BACKUP_WEEKLY_KEEP * 7 * 86_400_000;
  for (const f of files) {
    const [, y, m, d] = LOCAL_NAME_RE.exec(f);
    const when = new Date(`${y}-${m}-${d}T00:00:00Z`);
    if (when.getUTCDay() === 0 && when.getTime() >= weeklyFrom) keep.add(f);
  }
  const removed = files.filter((f) => !keep.has(f));
  removed.forEach((f) => unlinkSync(join(dir, f)));
  return removed;
}

/** Снимок базы в dir/sedim-ГГГГ-ММ-ДД.db (одна копия на день; существующую не трогаем). */
export function runLocalBackup(db, { dir, now = new Date() }) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const final = join(dir, localBackupName(now));
    if (!existsSync(final)) {
      const tmp = join(dir, `.tmp-${Date.now()}.db`);
      vacuumInto(db, tmp);
      renameSync(tmp, final); // целиком или никак: недописанного файла под боевым именем не бывает
    }
    const removed = pruneLocalBackups(dir, now);
    const kept = readdirSync(dir).filter((f) => LOCAL_NAME_RE.test(f)).length;
    return { ok: true, path: final, sizeBytes: statSync(final).size, kept, removed: removed.length };
  } catch (err) {
    console.error("[backup] не удалось сделать локальную копию:", err.message);
    return { ok: false, reason: err.message };
  }
}

/** Делает и шлёт бэкап ПРЯМО СЕЙЧАС, без проверки "пора ли" — используется и
 * автоматическим тиком (через runBackup ниже), и командой /backup из
 * webhook.js, когда хочется проверить/получить свежий снимок без ожидания
 * следующего интервала. Обновляет last_backup_at в обоих случаях. Не
 * бросает исключение при неудаче (временная сетевая проблема не должна
 * ронять процесс) — просто логируется, вызывающий код решает, что дальше. */
export async function sendBackupNow(db, { botToken, adminTelegramId, backupDir = null, sendFile = true }, now = new Date()) {
  if (!adminTelegramId) return { sent: false, reason: "ADMIN_TELEGRAM_ID не задан" };

  // Локальная копия — первая и главная; файл в Telegram — дополнительная (и отключаемая) страховка.
  const local = backupDir ? runLocalBackup(db, { dir: backupDir, now }) : null;
  if (!sendFile) {
    if (local?.ok) {
      setLastBackupAt(db, now.toISOString());
      await sendTelegramMessage(botToken, adminTelegramId, `✅ Бэкап сделан на сервере: ${local.sizeBytes ? (local.sizeBytes / 1_048_576).toFixed(2) : "?"} МБ, копий хранится ${local.kept}. В Telegram файл не отправляется.`).catch(() => {});
      return { sent: true, local: true, sizeBytes: local.sizeBytes };
    }
    await sendTelegramMessage(botToken, adminTelegramId, `⚠️ Бэкап НЕ сделан: ${local?.reason || "не задана папка для копий (BACKUP_DIR)"}`).catch(() => {});
    return { sent: false, reason: local?.reason || "backupDir не задан" };
  }

  const tmpPath = join(tmpdir(), `sedim-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    vacuumInto(db, tmpPath);
    // Bot API не принимает документы больше 50 МБ — раньше бэкап после этого
    // порога молча переставал отправляться (только строка в логах). Теперь
    // админ узнаёт об этом сообщением, пока потеря данных ещё не случилась.
    const sizeBytes = statSync(tmpPath).size;
    if (sizeBytes > MAX_BACKUP_BYTES) {
      const text = `⚠️ База выросла до ${(sizeBytes / 1_048_576).toFixed(1)} МБ — бэкап через Telegram больше не отправляется (лимит Bot API 50 МБ). Нужно другое хранилище для бэкапов.`;
      await sendTelegramMessage(botToken, adminTelegramId, text).catch((err) => console.error("[backup] не удалось предупредить админа:", err.message));
      return { sent: false, reason: "база слишком большая для отправки через Telegram", sizeBytes };
    }
    const buffer = readFileSync(tmpPath);
    const filename = `sedim-${now.toISOString().slice(0, 10)}.db`;
    await sendTelegramDocument(botToken, adminTelegramId, buffer, filename, `Бэкап базы «Съедим» — ${now.toISOString()}${local?.ok ? ` · на сервере копий: ${local.kept}` : ""}`);
    setLastBackupAt(db, now.toISOString());
    return { sent: true, sizeBytes: buffer.length, local: !!local?.ok };
  } catch (err) {
    console.error("[backup] не удалось сделать/отправить бэкап:", err.message);
    return { sent: false, reason: err.message };
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
}

/** Обёртка sendBackupNow с проверкой "пора ли" — то, что реально зовёт
 * планировщик по расписанию (см. index.js). */
export async function runBackup(db, { botToken, adminTelegramId, intervalHours = 24, backupDir = null, sendFile = true }, now = new Date()) {
  if (!adminTelegramId) return { sent: false, reason: "ADMIN_TELEGRAM_ID не задан" };

  const lastBackupAt = getLastBackupAt(db);
  if (!shouldRunBackup(now, lastBackupAt, intervalHours)) return { sent: false, reason: "не время" };

  return sendBackupNow(db, { botToken, adminTelegramId, backupDir, sendFile }, now);
}
