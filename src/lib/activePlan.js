// Текущий собранный план — сохраняется локально (localStorage), чтобы при
// повторном открытии приложения (вышли из Telegram и зашли снова, перезапуск
// WebView и т.п.) пользователь сразу видел СВОЙ план на неделю, а не визард
// "собрать новый план" заново. Раньше planState/pools/priceByName жили только
// в React-состоянии — оно исчезает при каждом перемонтировании компонента, и
// единственным способом попасть в уже собранный план было пройти сборку
// заново (жалоба в чате: "как посмотреть старый план, который я уже собрал").
//
// Профиль (family/meals/diet/...) уже переживает перезапуск через profile.js —
// этот модуль закрывает последний недостающий кусок: сам план (store, budget,
// planState, pools, priceByName), то есть ровно то, что нужно ResultView,
// чтобы отрисоваться, минуя визард. "Заново" (App.jsx:reset) явно чистит
// запись — план хранится, пока пользователь либо не соберёт новый, либо не
// нажмёт "Заново" сам; отдельного времени жизни/протухания нет, это
// сознательно: план актуален, пока не заменён, а не "неделю после сборки".
const ACTIVE_PLAN_KEY = "sedim.activePlan.v1";

export function loadActivePlan() {
  try {
    const raw = localStorage.getItem(ACTIVE_PLAN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // минимальная валидация формы — повреждённая/чужая запись не должна ронять приложение
    if (!parsed || typeof parsed !== "object" || !parsed.planState || !parsed.pools) return null;
    return {
      store: parsed.store ?? null,
      budget: parsed.budget ?? 4000,
      planState: parsed.planState,
      pools: parsed.pools,
      // Map не переживает JSON.stringify как есть (см. saveActivePlan) —
      // храним как массив пар и восстанавливаем здесь же, чтобы вызывающему
      // коду (App.jsx) не приходилось знать об этой детали сериализации.
      priceByName: Array.isArray(parsed.priceByNameEntries) ? new Map(parsed.priceByNameEntries) : null,
    };
  } catch {
    return null;
  }
}

export function saveActivePlan({ store, budget, planState, pools, priceByName }) {
  try {
    localStorage.setItem(
      ACTIVE_PLAN_KEY,
      JSON.stringify({
        store,
        budget,
        planState,
        pools,
        priceByNameEntries: priceByName ? [...priceByName.entries()] : null,
      })
    );
  } catch {
    // приватный режим браузера / квота исчерпана (пулы ВкусВилл с полным
    // составом и шагами рецептов могут быть не самыми маленькими) — молча не
    // сохраняем, это не критичная функция: план просто не восстановится при
    // следующем открытии, тот же принцип, что и у profile.js.
  }
}

export function clearActivePlan() {
  try {
    localStorage.removeItem(ACTIVE_PLAN_KEY);
  } catch {
    /* см. saveActivePlan */
  }
}
