// Один "тик" планировщика — вызывается по расписанию из index.js (setInterval,
// не отдельный cron-процесс: сервер маленький и всё равно должен работать
// постоянно ради самого HTTP API, поэтому напоминания — просто ещё один
// таймер в том же процессе, не отдельная инфраструктура).
import { findCandidateSlots, markReminderSent, getUsersDueForFreeNudge, markFreeNudgeSent } from "./db.js";
import { findDueReminders } from "./reminderTiming.js";
import { sendTelegramMessage, buildReminderText, buildFreeNudgeText } from "./telegram.js";
import { FREE_WINDOW_MS } from "./app.js";

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
  const candidates = findCandidateSlots(db, today, tomorrow, now.toISOString());
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

// GRACE_MS — окно ПОСЛЕ сброса лимита, в течение которого ещё имеет смысл
// напомнить (живой вывод из ревью в чате: "лёгкое бесплатное напоминание
// вернуться" — раньше сброс лимита проходил тихо). 3 дня — достаточно
// широкое окно, чтобы редкий (например, раз в сутки) тик не пропустил
// момент сброса, но не бесконечное — не шлём тому, кто не возвращался
// месяцами, это уже не "напоминание", а спам.
const FREE_NUDGE_GRACE_MS = 3 * 24 * 3_600_000;

/** Отдельный тик от runReminderTick выше — другая аудитория (free, не Pro),
 * другая частота смысла (раз в сутки более чем достаточно, лимит не может
 * смениться чаще раза в неделю). Та же защита от одной ошибки, роняющей
 * остальных, и та же логика "не пометили — не отправили" на реальный сбой. */
export async function runFreeNudgeTick(db, botToken, now = new Date()) {
  const due = getUsersDueForFreeNudge(db, { nowISO: now.toISOString(), freeWindowMs: FREE_WINDOW_MS, graceMs: FREE_NUDGE_GRACE_MS });
  const results = [];
  for (const user of due) {
    try {
      await sendTelegramMessage(botToken, user.telegram_user_id, buildFreeNudgeText());
      markFreeNudgeSent(db, user.telegram_user_id, now.toISOString());
      results.push({ telegramUserId: user.telegram_user_id, ok: true });
    } catch (err) {
      console.error(`[scheduler] не удалось отправить бесплатное напоминание user=${user.telegram_user_id}:`, err.message);
      results.push({ telegramUserId: user.telegram_user_id, ok: false, error: err.message });
    }
  }
  return results;
}
