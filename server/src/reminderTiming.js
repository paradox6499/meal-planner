// Чистая математика "пора ли напомнить про этот приём пищи прямо сейчас" —
// без обращения к БД или часам напрямую (принимает `now` параметром), чтобы
// тестировать без реального времени и без сети.
//
// meal_slots в БД хранят календарную дату (scheduled_date, 'YYYY-MM-DD') и
// локальное время пользователя (meal_time, 'HH:MM') отдельно от часового
// пояса — переводим в UTC здесь, а не при сохранении, чтобы не завязываться
// на часовой пояс сервера.

/** Локальное время пользователя (дата + время + смещение в минутах от UTC) -> unix ms в UTC. */
export function mealDateTimeToUtcMs(scheduledDateISO, mealTimeHHMM, timezoneOffsetMinutes) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(scheduledDateISO);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(mealTimeHHMM);
  if (!dateMatch || !timeMatch) return null;
  const [y, mo, d] = [dateMatch[1], dateMatch[2], dateMatch[3]].map(Number);
  const [hh, mm] = [timeMatch[1], timeMatch[2]].map(Number);
  // "локальное время как если бы оно было UTC" минус смещение = настоящий UTC.
  // Смещение +180 (UTC+3, Москва) -> локальные 19:00 это 16:00 UTC.
  const localAsUtcMs = Date.UTC(y, mo - 1, d, hh, mm);
  return localAsUtcMs - timezoneOffsetMinutes * 60 * 1000;
}

/** true, если приём пищи наступает в течение ближайших leadMinutes (и ещё не наступил). */
export function isDueForReminder({ scheduledDate, mealTime, timezoneOffsetMinutes, leadMinutes }, now = new Date()) {
  const mealUtcMs = mealDateTimeToUtcMs(scheduledDate, mealTime, timezoneOffsetMinutes);
  if (mealUtcMs == null) return false;
  const msUntilMeal = mealUtcMs - now.getTime();
  const leadMs = leadMinutes * 60 * 1000;
  // > 0 — не слать постфактум, если минута уже упущена (например, сервер не
  // проверял несколько минут); <= leadMs — уже попали в окно напоминания
  return msUntilMeal > 0 && msUntilMeal <= leadMs;
}

/** Из набора кандидатов (уже отфильтрованных в БД по "сегодня и ещё не отправлено")
 * выбирает те, для которых реально настало время напомнить. */
export function findDueReminders(candidates, now = new Date()) {
  return candidates.filter((slot) =>
    isDueForReminder(
      { scheduledDate: slot.scheduled_date, mealTime: slot.meal_time, timezoneOffsetMinutes: slot.timezone_offset_minutes, leadMinutes: slot.reminder_lead_minutes },
      now
    )
  );
}
