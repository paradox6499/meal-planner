// Подтверждение опасного действия (диалог Telegram или window.confirm).

// Подтверждение опасного действия: showConfirm — родной диалог Telegram (Bot
// API 6.2+), window.confirm — запасной вариант вне Telegram.
export function confirmAction(message) {
  return new Promise((resolve) => {
    const tg = window.Telegram?.WebApp;
    if (tg?.showConfirm) tg.showConfirm(message, (ok) => resolve(!!ok));
    else resolve(window.confirm(message));
  });
}
