// fetch с таймаутом для ВНЕШНИХ вызовов сервера (ЮKassa, Telegram). Раньше у них
// таймаутов не было вовсе (перепроверка аудита 04.10.2026, п. 4.1): зависший
// ответ ЮKassa держал /api/plan-status, а зависший Telegram — тик планировщика,
// из-за чего следующий тик стартовал параллельно и напоминания уходили дважды.
export const EXTERNAL_TIMEOUT_MS = 8000;

export async function fetchWithTimeout(url, init = {}, timeoutMs = EXTERNAL_TIMEOUT_MS, label = "внешний сервис") {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(`${label}: нет ответа за ${Math.round(timeoutMs / 1000)} с`);
    }
    throw err;
  }
}

/** Оборачивает периодический тик: если предыдущий ещё идёт — пропускает
 * (иначе тик длиннее интервала запускался бы параллельно с собой). */
export function guardTick(name, fn) {
  let running = false;
  return async () => {
    if (running) {
      console.warn(`[${name}] предыдущий тик ещё идёт — пропускаю`);
      return;
    }
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}
