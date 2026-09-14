// Напоминание "подписка скоро закончится" — прямо обещано пользователям в
// terms.html ("Подписка... не продлевается автоматически — по мере
// приближения даты окончания Сервис присылает напоминание о продлении, тем
// же механизмом, что и напоминания о еде") — то есть это не факультативная
// фича, а то, что уже опубликовано как часть условий оплаты. Один "тик",
// как у reminderTiming.js/digest.js/backup.js — вызывается по расписанию из
// index.js.
import { getUsersWithProExpiringSoon, markRenewalReminderSent } from "./db.js";
import { sendTelegramMessage } from "./telegram.js";

// 3 дня — достаточно, чтобы успеть продлить, не оплачивая "в последний
// момент"/после уже наступившего перерыва в Pro; не настолько рано, чтобы
// напоминание забылось к дате реального окончания.
export const RENEWAL_REMINDER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export function buildRenewalReminderText(proUntilISO) {
  const date = new Date(proUntilISO).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  return (
    `⏳ Подписка Pro заканчивается ${date}.\n\n` +
    `После этого действуют ограничения бесплатного тарифа (1 план в неделю, без общего списка на семью). ` +
    `Продлить — в приложении, в Аккаунте → «Перейти на Pro».`
  );
}

/** Один проход: найти, кому пора напомнить о скором окончании подписки,
 * отправить, пометить отправленным. Ошибка отправки одному пользователю не
 * должна останавливать остальных — тот же принцип, что и в scheduler.js. */
export async function runProRenewalTick(db, botToken, now = new Date()) {
  const nowISO = now.toISOString();
  const due = getUsersWithProExpiringSoon(db, { nowISO, windowMs: RENEWAL_REMINDER_WINDOW_MS });

  const results = [];
  for (const user of due) {
    try {
      await sendTelegramMessage(botToken, user.telegram_user_id, buildRenewalReminderText(user.pro_until));
      markRenewalReminderSent(db, user.telegram_user_id, nowISO);
      results.push({ telegramUserId: user.telegram_user_id, ok: true });
    } catch (err) {
      console.error(`[proRenewal] не удалось отправить напоминание user=${user.telegram_user_id}:`, err.message);
      results.push({ telegramUserId: user.telegram_user_id, ok: false, error: err.message });
    }
  }
  return results;
}
