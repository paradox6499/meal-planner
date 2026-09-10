// Отправка плана на бэкенд напоминаний (server/) — единственная сейчас
// причина, по которой у приложения вообще есть сервер (см. server/README.md).
// Всё здесь должно быть best-effort: бэкенд может быть ещё не задеплоен
// (VITE_BACKEND_URL не задан), приложение может быть открыто вне Telegram
// (браузер, локальный превью) — ни один из этих случаев не должен ничего
// сломать в основном сценарии "собрать план и увидеть список покупок".

const MEAL_LABEL_BY_ID = { breakfast: "Завтрак", lunch: "Обед", dinner: "Ужин", snack: "Перекус" };

export function todayPlusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10); // 'YYYY-MM-DD' по UTC-дате — сервер использует её только как ключ дня, не как момент времени
}

/** planView.days -> mealSlots для POST /api/plan. День 1 = сегодня (план
 * составляется "на эту неделю начиная с сегодня", не с понедельника). */
export function buildMealSlots(planView, mealTimes) {
  return planView.days.flatMap((d) =>
    d.dayMeals.map((dm) => ({
      scheduledDate: todayPlusDays(d.day - 1),
      mealType: dm.mealId,
      mealLabel: MEAL_LABEL_BY_ID[dm.mealId] || dm.mealLabel,
      mealTime: mealTimes[dm.mealId] || "19:00",
      recipeName: dm.recipe.name,
    }))
  );
}

function currentInitData() {
  return window.Telegram?.WebApp?.initData || null;
}

/** Возвращает null, если проверять нечем/не у кого (нет бэкенда или не в
 * Telegram) — вызывающий код (App.jsx) в этом случае не блокирует сборку
 * плана вообще, тот же принцип "бэкенд опционален", что и у остальных
 * функций этого файла. */
export async function checkPlanStatus() {
  const backendUrl = import.meta.env.VITE_BACKEND_URL;
  const initData = currentInitData();
  if (!backendUrl || !initData) return null;

  try {
    const res = await fetch(`${backendUrl}/api/plan-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn("Не удалось получить статус тарифа:", err.message);
    return null;
  }
}

/** Сохраняет собранный план в историю (server/src/db.js:plan_history) —
 * best-effort, как и всё остальное здесь: без бэкенда просто не сохраняется,
 * история — приятное дополнение, а не часть основного сценария. */
export async function savePlanToHistory({ storeId, storeName, budget, family, totalCost, plan }) {
  const backendUrl = import.meta.env.VITE_BACKEND_URL;
  const initData = currentInitData();
  if (!backendUrl || !initData) return;

  try {
    await fetch(`${backendUrl}/api/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, storeId, storeName, budget, family, totalCost, plan }),
    });
  } catch (err) {
    console.warn("Не удалось сохранить план в историю:", err.message);
  }
}

/** Список прошлых планов — null означает "нечем спросить" (нет бэкенда/не в
 * Telegram), пустой массив [] — "спросили, там пока пусто". Разные вещи для
 * UI: null скрывает раздел "История" целиком, [] показывает "пока пусто". */
export async function fetchPlanHistory() {
  const backendUrl = import.meta.env.VITE_BACKEND_URL;
  const initData = currentInitData();
  if (!backendUrl || !initData) return null;

  try {
    const res = await fetch(`${backendUrl}/api/plans/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.plans || [];
  } catch (err) {
    console.warn("Не удалось получить историю планов:", err.message);
    return null;
  }
}

export async function submitPlanToBackend(planView, mealTimes) {
  const backendUrl = import.meta.env.VITE_BACKEND_URL;
  if (!backendUrl) return; // бэкенд ещё не задеплоен — молча ничего не делаем, это ок

  const tg = window.Telegram?.WebApp;
  // initData (не initDataUnsafe!) — подписанная сырая строка, только по ней
  // сервер может проверить, что запрос реально от Telegram, а не от кого
  // угодно с открытыми devtools. Вне настоящего Telegram-клиента (обычный
  // браузер, локальный превью) её не существует — напоминания там просто
  // не имеют смысла, тихо выходим.
  if (!tg?.initData) return;

  try {
    await fetch(`${backendUrl}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        initData: tg.initData,
        // JS Date.getTimezoneOffset() отдаёт ОБРАТНЫЙ знак принятой записи
        // часового пояса (для UTC+3 вернёт -180, а не +180) — сервер
        // (reminderTiming.js) ждёт "смещение от UTC" в привычной записи,
        // отсюда минус. Перепутать знак здесь — значит слать напоминания на
        // 6 часов не в то время, поэтому явно проговорено и тут, и в тестах
        // сервера.
        timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
        mealSlots: buildMealSlots(planView, mealTimes),
      }),
    });
  } catch (err) {
    // Напоминания — это плюс к основному сценарию, а не его часть; неудачная
    // отправка не должна ничем помешать пользователю, который просто хочет
    // увидеть список покупок. Логируем и забываем.
    console.warn("Не удалось отправить план на сервер напоминаний:", err.message);
  }
}
