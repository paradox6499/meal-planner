// Склонения и форматирование дат для интерфейса.

// "1 приём / 2 приёма / 5 приёмов" — раньше везде стояло "приёма/приёмов"
// через слэш (UX-аудит 29.09.2026).
export function mealsPerDayLabel(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "приём пищи в день";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "приёма пищи в день";
  return "приёмов пищи в день";
}

export function formatResetDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

export function pluralPeople(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "участник";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "участника";
  return "участников";
}

export function pluralDaysRu(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "дня";
  return "дней";
}

export function pluralWeeks(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "неделю";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "недели";
  return "недель";
}
