// Тактильная отдача через Telegram WebApp HapticFeedback API — один из
// самых дешёвых по усилиям способов, чтобы Mini App ощущался как нативное
// приложение, а не "сайт в рамке" (обсуждали в чате). Вне Telegram (обычный
// браузер, локальный превью) window.Telegram не существует — все функции
// тихо ничего не делают, а не падают.
function haptics() {
  return window.Telegram?.WebApp?.HapticFeedback;
}

/** Лёгкий тычок — выбор чипа, переключатель, тап по некритичному элементу. */
export function hapticSelect() {
  haptics()?.selectionChanged?.();
}

/** style: "light" | "medium" | "heavy" — основное действие (кнопка "Далее",
 * добавить/убрать элемент списка). medium — разумный дефолт. */
export function hapticImpact(style = "medium") {
  haptics()?.impactOccurred?.(style);
}

/** type: "success" | "error" | "warning" — итог действия (план собран,
 * ошибка заказа). Используется реже impact/select — не на каждый тап, а на
 * "что-то значимое случилось". */
export function hapticNotify(type) {
  haptics()?.notificationOccurred?.(type);
}
