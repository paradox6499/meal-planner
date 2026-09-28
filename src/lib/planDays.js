// Подписи дней плана: "Сегодня · пт, 2 окт." вместо голого "День 3" (UX-аудит
// 29.09.2026 — человек сам высчитывал, какой день недели сегодня). День 1 =
// день сборки плана (см. buildMealSlots в backend.js: "составляется на
// неделю начиная с сегодня"), поэтому дата дня N — локальная дата createdAt
// плюс N-1 дней. Считаем по ЛОКАЛЬНЫМ датам (без часов), как и
// todayPlusDays в backend.js — иначе план, собранный в 23:50, съезжал бы на
// день из-за UTC.

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** createdAtISO — когда план собран (слот плана хранит это поле; у старых
 * планов оно может быть null — тогда null и вызывающий код показывает
 * прежнее "День N"). Возвращает { label, isToday, isPast } или null. */
export function describePlanDay(createdAtISO, day, now = new Date()) {
  if (!createdAtISO) return null;
  const created = new Date(createdAtISO);
  if (Number.isNaN(created.getTime())) return null;

  const start = startOfLocalDay(created);
  const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day - 1);
  const today = startOfLocalDay(now);

  const isToday = date.getTime() === today.getTime();
  const isPast = date.getTime() < today.getTime();
  const dateLabel = date.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" });

  return { label: isToday ? `Сегодня · ${dateLabel}` : dateLabel, isToday, isPast };
}

/** Индекс дня, который сегодня, среди days (массив {day}) — или -1, если
 * сегодня вне диапазона плана (план старый или дата неизвестна). */
export function findTodayDayIndex(createdAtISO, days, now = new Date()) {
  return days.findIndex((d) => describePlanDay(createdAtISO, d.day, now)?.isToday);
}
