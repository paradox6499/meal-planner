// Отправка плана на бэкенд напоминаний (server/) — единственная сейчас
// причина, по которой у приложения вообще есть сервер (см. server/README.md).
// Всё здесь должно быть best-effort: бэкенд может быть ещё не задеплоен
// (VITE_BACKEND_URL не задан), приложение может быть открыто вне Telegram
// (браузер, локальный превью) — ни один из этих случаев не должен ничего
// сломать в основном сценарии "собрать план и увидеть список покупок".

const MEAL_LABEL_BY_ID = { breakfast: "Завтрак", lunch: "Обед", dinner: "Ужин", snack: "Перекус" };

// Найдено при разборе жалобы "напоминание вообще не приходит": .toISOString()
// всегда рендерит UTC-дату, а не локальную дату пользователя — для ЛЮБОГО
// положительного смещения от UTC (вся Россия: от +2 до +12) это даёт НЕ ТУ
// дату каждый раз, когда локальное время суток попадает в первые N часов
// суток (N = смещение в часах) — например для Москвы (+3) это полночь-3
// утра, а для Камчатки (+12) — вообще половина суток. reminderTiming.js на
// сервере (mealDateTimeToUtcMs) трактует scheduledDate как ЛОКАЛЬНУЮ
// календарную дату пользователя (это и есть смысл поля — "какой день недели
// плана"), поэтому здесь тоже нужны локальные компоненты даты, а не UTC.
// Ошибка молчаливая и постоянная: слот с "не той" датой никогда не попадёт
// в today/tomorrow на сервере в нужный момент и напоминание не придёт вообще,
// без единой ошибки в логах где бы то ни было.
export function todayPlusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`; // 'YYYY-MM-DD' по ЛОКАЛЬНОЙ дате пользователя
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

// Настоящий прод-баг (жалоба в чате "http 404: not found" — видно только
// после того, как ProModal стала показывать причину отказа на экране, не
// только в console.warn), стоивший нескольких дней путаницы с "логи
// пустые" и "событий не было": VITE_BACKEND_URL в GitHub Actions задан С
// завершающим слешем (https://…onrender.com/), а КАЖДЫЙ вызов в этом файле
// собирал путь как `${backendUrl}/api/...` — итог "//api/..." (двойной
// слеш). Сервер (простой роутер без фреймворка, см. server/src/app.js)
// матчит req.url ТОЧНЫМ сравнением строк ("/api/pay/create") — "//api/..."
// ни с чем не совпадает и падает в 404 у самого же нашего роутера, причём
// молча: обработчик 404 ничего не логирует. Живьём проверено curl'ом
// напрямую на проде — именно так и воспроизводится. Из-за этого не только
// оплата, а ВООБЩЕ ЛЮБОЙ вызов бэкенда (аналитика, история планов,
// реферальная программа, напоминания) тихо проваливался в 404 для
// реальных пользователей всё это время. getBackendUrl — единственное
// место, где вообще читается VITE_BACKEND_URL, чтобы этот класс бага не
// мог повториться незаметно ещё раз в одном из мест и уцелеть в остальных.
export function getBackendUrl() {
  const raw = import.meta.env.VITE_BACKEND_URL;
  return raw ? raw.replace(/\/+$/, "") : raw;
}

// typeof-проверка первой (а не просто window?.Telegram...) — раньше во всех
// функциях этого файла молча подразумевалось, что глобальный window вообще
// существует (правда в браузере, но не в тестах Node-окружения без jsdom, см.
// vitest.config.js). Пока это was безопасно — каждый тест, которому нужен
// window, сам стабил его через vi.stubGlobal. Стало важно с приходом
// resolvePricesViaBackend: её теперь зовёт attachRealCosts (vkusvillRecipes.js),
// а его тесты никогда не стабили window — без этой проверки простое
// обращение к самому идентификатору window бросало бы ReferenceError ДО
// того, как успело бы сработать опциональное сцепление ?. дальше по цепочке.
function currentInitData() {
  if (typeof window === "undefined") return null;
  return window.Telegram?.WebApp?.initData || null;
}

/** Возвращает null, если проверять нечем/не у кого (нет бэкенда или не в
 * Telegram) — вызывающий код (App.jsx) в этом случае не блокирует сборку
 * плана вообще, тот же принцип "бэкенд опционален", что и у остальных
 * функций этого файла. */
export async function checkPlanStatus() {
  const backendUrl = getBackendUrl();
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

/** Создаёт платёж в ЮKassa (POST /api/pay/create) и возвращает checkout-
 * ссылку — открывается через Telegram.WebApp.openLink (см. App.jsx:
 * ProModal), не встраивается в само мини-приложение: ЮKassa не поддерживает
 * работу внутри Telegram WebView.
 *
 * email — обязателен (см. lib/payerContact.js): магазин требует фискальный
 * чек на каждый платёж (54-ФЗ), а чек требует контакт покупателя. Telegram
 * email не даёт вообще ни при каких условиях, поэтому спрашиваем сами.
 *
 * Возвращает {ok:true, confirmationUrl} или {ok:false, reason, detail} —
 * раньше был просто null на любой неудаче, и все причины ("нет backendUrl/
 * initData" / "сервер ответил ошибкой" / "сетевая ошибка") были неотличимы
 * друг от друга СНАРУЖИ функции, даже когда внутри она уже честно писала их
 * в console.warn — а DevTools у обычного пользователя никто не открывает.
 * Живая жалоба в чате дошла до диагностики подключения в Аккаунте (backendUrl
 * и initData оказались в полном порядке) и до логов на сервере (тоже пусто,
 * даже после того как там стали логировать и отказ авторизации, и успех) —
 * и всё равно осталось неясно, что произошло на самом деле. reason здесь —
 * чтобы ProModal мог показать ПОЛЬЗОВАТЕЛЮ (не только консоли) точную
 * причину прямо в интерфейсе: "нет интернета", "сервер ответил 503" и т.п. —
 * следующий круг диагностики не должен снова упираться в "а в логах пусто".
 */
export async function createProPayment(email) {
  const backendUrl = getBackendUrl();
  const initData = currentInitData();
  if (!backendUrl || !initData) {
    console.warn("Не удалось создать платёж: нет backendUrl или initData", { hasBackendUrl: !!backendUrl, hasInitData: !!initData });
    return { ok: false, reason: "no_backend_or_initdata" };
  }

  try {
    const res = await fetch(`${backendUrl}/api/pay/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, email }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      console.warn("Не удалось создать платёж: сервер ответил ошибкой", res.status, data?.error);
      return { ok: false, reason: "server_error", detail: `HTTP ${res.status}${data?.error ? `: ${data.error}` : ""}` };
    }
    const data = await res.json();
    if (!data.confirmationUrl) {
      console.warn("Не удалось создать платёж: сервер не вернул confirmationUrl", data);
      return { ok: false, reason: "no_url" };
    }
    return { ok: true, confirmationUrl: data.confirmationUrl };
  } catch (err) {
    console.warn("Не удалось создать платёж: сетевая ошибка", err.message);
    return { ok: false, reason: "network_error", detail: err.message };
  }
}

/** Как resolvePrices (vkusvillMcp.js), но через ОБЩИЙ серверный кэш цен
 * (server/src/vkusvillPrices.js, POST /api/prices) вместо прямого похода в
 * ВкусВилл из браузера каждый раз заново. Одинаковые названия ингредиентов
 * повторяются у разных пользователей (курица, лук, молоко — почти в каждом
 * плане) — общий кэш должен заметно реже упираться в rate-limit ВкусВилл,
 * чем клиентский in-memory кэш (per-браузер, ничего не переживает и ни с
 * кем не делится). null означает "нечем спросить или не получилось" (нет
 * бэкенда, не в Telegram, сеть, отклонено сервером) — вызывающий код
 * (attachRealCosts в vkusvillRecipes.js) в этом случае откатывается на
 * resolvePrices напрямую, тот же принцип "бэкенд опционален", что и везде
 * в этом файле. names — БЕЗ дублей не обязательно, сервер сам дедуплицирует. */
export async function resolvePricesViaBackend(names) {
  const backendUrl = getBackendUrl();
  const initData = currentInitData();
  if (!backendUrl || !initData || names.length === 0) return null;

  try {
    const res = await fetch(`${backendUrl}/api/prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, names }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.prices) ? data.prices : null;
  } catch (err) {
    console.warn("Не удалось получить цены через серверный кэш, откат на прямые запросы к ВкусВилл:", err.message);
    return null;
  }
}

/** Сохраняет собранный план в историю (server/src/db.js:plan_history) —
 * best-effort, как и всё остальное здесь: без бэкенда просто не сохраняется,
 * история — приятное дополнение, а не часть основного сценария. */
export async function savePlanToHistory({ storeId, storeName, budget, family, totalCost, plan }) {
  const backendUrl = getBackendUrl();
  const initData = currentInitData();
  if (!backendUrl || !initData) return;

  try {
    const res = await fetch(`${backendUrl}/api/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, storeId, storeName, budget, family, totalCost, plan }),
    });
    // Тот же пробел, что уже был в updateMealTimes/submitPlanToBackend (см.
    // их комментарии) — без этой проверки отклонённая сервером запись
    // (например initData "устарела") выглядела бы как успех, а история
    // планов и геймификация (streak/экономия в Аккаунте — они считаются
    // именно из этой истории, см. ProgressSection в App.jsx) молча
    // оставались бы пустыми без единой видимой причины.
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      console.warn("Сервер отклонил сохранение плана в историю:", res.status, body?.error);
    }
  } catch (err) {
    console.warn("Не удалось сохранить план в историю:", err.message);
  }
}

/** Список прошлых планов — null означает "нечем спросить" (нет бэкенда/не в
 * Telegram), пустой массив [] — "спросили, там пока пусто". Разные вещи для
 * UI: null скрывает раздел "История" целиком, [] показывает "пока пусто". */
export async function fetchPlanHistory() {
  const backendUrl = getBackendUrl();
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

/** Обновляет время приёмов пищи для УЖЕ сохранённого на сервере плана,
 * напрямую, без пересборки всего плана (см. server/src/db.js:
 * updateMealTimesForUser). Раньше время долетало до сервера только вместе
 * с целым планом — если человек открывал Аккаунт поменять время, не
 * пересобирая план заново (например, зашёл в свежей сессии только за этим),
 * новое время никогда не сохранялось, и напоминания продолжали приходить
 * по старому времени (или не приходить вовсе, если плана ещё не было).
 * best-effort, как и всё остальное здесь — если сохранённого плана ещё нет,
 * сервер просто ничего не найдёт и не обновит, это не ошибка. */
export async function updateMealTimes(mealTimes) {
  const backendUrl = getBackendUrl();
  const initData = currentInitData();
  if (!backendUrl || !initData) return;

  try {
    const res = await fetch(`${backendUrl}/api/meal-times`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, mealTimes }),
    });
    // fetch() бросает исключение ТОЛЬКО на сетевом сбое — HTTP 4xx/5xx он
    // резолвит как обычный (успешный с точки зрения Promise) ответ. Раньше
    // здесь это не проверялось вообще: сервер мог молча отклонить запрос
    // (например initData "устарела" — см. server/src/initData.js, лимит 24
    // часа), а фронтенд считал бы это успехом неотличимо от настоящего —
    // жалоба "поставил время, напоминание не приходит" могла быть именно
    // этим, без единого следа где бы то ни было. Не блокируем пользователя
    // (как и раньше — это по-прежнему best-effort), но хотя бы оставляем
    // тут diagnosable сигнал в консоли.
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      console.warn("Сервер напоминаний отклонил обновление времени приёмов пищи:", res.status, body?.error);
    }
  } catch (err) {
    console.warn("Не удалось обновить время приёмов пищи на сервере:", err.message);
  }
}

export async function submitPlanToBackend(planView, mealTimes) {
  const backendUrl = getBackendUrl();
  if (!backendUrl) return; // бэкенд ещё не задеплоен — молча ничего не делаем, это ок

  const tg = window.Telegram?.WebApp;
  // initData (не initDataUnsafe!) — подписанная сырая строка, только по ней
  // сервер может проверить, что запрос реально от Telegram, а не от кого
  // угодно с открытыми devtools. Вне настоящего Telegram-клиента (обычный
  // браузер, локальный превью) её не существует — напоминания там просто
  // не имеют смысла, тихо выходим.
  if (!tg?.initData) return;

  try {
    const res = await fetch(`${backendUrl}/api/plan`, {
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
    // См. тот же комментарий в updateMealTimes выше — fetch() не бросает на
    // HTTP 4xx/5xx, только на сетевой сбой. Без этой проверки отклонённый
    // сервером план (например initData "устарела" — лимит 24 часа,
    // server/src/initData.js) выглядел бы для фронтенда как успех — и
    // напоминания потом просто не приходили бы всю неделю без единой видимой
    // причины.
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      console.warn("Сервер напоминаний отклонил план:", res.status, body?.error);
    }
  } catch (err) {
    // Напоминания — это плюс к основному сценарию, а не его часть; неудачная
    // отправка не должна ничем помешать пользователю, который просто хочет
    // увидеть список покупок. Логируем и забываем.
    console.warn("Не удалось отправить план на сервер напоминаний:", err.message);
  }
}

/** Регистрирует "меня пригласил referrerTelegramId" — вызывается один раз
 * при открытии по реферальной ссылке (?startapp=ref_<id>, см. App.jsx).
 * Тихо ничего не делает без бэкенда/вне Telegram, как и остальные функции
 * здесь; результат ("claimed" или отказ — самоприглашение, уже существующий
 * пользователь и т.п., см. server/src/referrals.js) не нужен вызывающему
 * коду — это best-effort фоновая регистрация, не блокирующая ничего в UI. */
export async function claimReferral(referrerTelegramId) {
  const backendUrl = getBackendUrl();
  const initData = currentInitData();
  if (!backendUrl || !initData) return;

  try {
    await fetch(`${backendUrl}/api/referral/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, referrerTelegramId }),
    });
  } catch (err) {
    console.warn("Не удалось зарегистрировать реферала:", err.message);
  }
}

/** {rewardedCount, daysEarned} — сколько людей пригласил пользователь (уже
 * получивших награду) и сколько дней Pro это принесло; null — нечем
 * спросить/не получилось (см. AccountView в App.jsx: раздел "Пригласить
 * друга" рендерится и без этого — просто без строки прогресса). */
export async function fetchReferralStatus() {
  const backendUrl = getBackendUrl();
  const initData = currentInitData();
  if (!backendUrl || !initData) return null;

  try {
    const res = await fetch(`${backendUrl}/api/referral/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn("Не удалось получить статус рефералов:", err.message);
    return null;
  }
}
