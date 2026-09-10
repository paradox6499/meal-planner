// "Добавить на экран" — официальный API Telegram Mini Apps (Bot API 8.0+,
// core.telegram.org/bots/webapps), не самодельный обход через navigator.share
// или инструкции "нажмите кнопку меню сами". Вне Telegram или на клиенте
// старее 8.0 — методов просто нет, весь модуль тихо не работает (см.
// isHomeScreenSupported ниже), кнопку в UI нужно скрывать, а не дизейблить.

function webApp() {
  return window.Telegram?.WebApp;
}

export function isHomeScreenSupported() {
  const tg = webApp();
  return !!(tg?.isVersionAtLeast?.("8.0") && typeof tg.addToHomeScreen === "function");
}

/** status: "unsupported" | "unknown" | "added" | "missed" */
export function checkHomeScreenStatus() {
  return new Promise((resolve) => {
    const tg = webApp();
    if (!isHomeScreenSupported()) {
      resolve("unsupported");
      return;
    }
    // checkHomeScreenStatus не гарантирует вызов callback (например, если
    // клиент заявляет версию 8.0+, но по факту не реализовал именно этот
    // метод) — подстраховываемся таймаутом, чтобы не зависнуть на "проверяем"
    // навсегда, если callback никогда не придёт.
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve("unknown");
      }
    }, 1500);
    try {
      tg.checkHomeScreenStatus((status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(status || "unknown");
      });
    } catch {
      clearTimeout(timer);
      resolve("unknown");
    }
  });
}

export function promptAddToHomeScreen() {
  webApp()?.addToHomeScreen?.();
}

/** onAdded вызывается, когда пользователь реально подтвердил добавление —
 * до этого статус может ещё какое-то время оставаться "missed"/"unknown". */
export function onHomeScreenAdded(callback) {
  const tg = webApp();
  if (!tg?.onEvent) return () => {};
  tg.onEvent("homeScreenAdded", callback);
  return () => tg.offEvent?.("homeScreenAdded", callback);
}
