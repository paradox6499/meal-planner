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
