// Один "тик" планировщика — вызывается по расписанию из index.js (setInterval,
// не отдельный cron-процесс: сервер маленький и всё равно должен работать
// постоянно ради самого HTTP API, поэтому напоминания — просто ещё один
// таймер в том же процессе, не отдельная инфраструктура).
import { findCandidateSlots, markReminderSent } from "./db.js";
import { findDueReminders } from "./reminderTiming.js";
import { sendTelegramMessage, buildReminderText } from "./telegram.js";

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Один проход: найти всё, чему пора напомнить прямо сейчас, отправить,
 * пометить отправленным. Ошибка отправки одному пользователю (например,
 * "бот заблокирован") не должна останавливать остальных — поэтому try/catch
 * внутри цикла, а не вокруг него. Помечаем отправленным ТОЛЬКО при успехе —
 * временный сбой сможет повториться на следующем тике. */
export async function runReminderTick(db, botToken, now = new Date()) {
  const today = isoDate(now);
  const tomorrow = isoDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const candidates = findCandidateSlots(db, today, tomorrow);
  const due = findDueReminders(candidates, now);

  const results = [];
  for (const slot of due) {
    try {
      const text = buildReminderText(slot.meal_label, slot.recipe_name);
      await sendTelegramMessage(botToken, slot.telegram_user_id, text);
      markReminderSent(db, slot.id, now.toISOString());
      results.push({ slotId: slot.id, telegramUserId: slot.telegram_user_id, ok: true });
    } catch (err) {
      console.error(`[scheduler] не удалось отправить напоминание slot=${slot.id} user=${slot.telegram_user_id}:`, err.message);
      results.push({ slotId: slot.id, telegramUserId: slot.telegram_user_id, ok: false, error: err.message });
    }
  }
  return results;
}
