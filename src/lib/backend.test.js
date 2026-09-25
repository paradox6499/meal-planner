import { describe, it, expect, vi, afterEach } from "vitest";
import { buildMealSlots, todayPlusDays, checkPlanStatus, savePlanToHistory, fetchPlanHistory, updateMealTimes, resolvePricesViaBackend, createProPayment, claimReferral, fetchReferralStatus, getBackendUrl, sendSupportPrompt, createFamily, joinFamily, leaveFamily, fetchFamilyStatus, toggleFamilyPantryItem } from "./backend.js";

function stubTelegram(initData) {
  vi.stubGlobal("window", { Telegram: initData !== undefined ? { WebApp: { initData } } : undefined });
}

// Регрессия на прод-баг (жалоба в чате: "http 404: not found", всплывшая
// только после того, как ProModal стала показывать причину отказа на
// экране, а не только в console.warn) — VITE_BACKEND_URL в GitHub Actions
// был задан С завершающим слешем, и КАЖДЫЙ вызов бэкенда (`${backendUrl}/...`)
// собирал путь с двойным слешем ("//api/pay/create"), который наш же
// роутер на сервере (точное сравнение строк) не матчит ни с чем и молча
// 404-ит. Из-за этого не только оплата — вообще любой вызов бэкенда
// (аналитика, история планов, рефералка, напоминания) тихо проваливался
// для реальных пользователей.
describe("getBackendUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("срезает один или несколько завершающих слешей", () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com/");
    expect(getBackendUrl()).toBe("https://api.example.com");

    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com///");
    expect(getBackendUrl()).toBe("https://api.example.com");
  });

  it("без завершающего слеша — не трогает адрес", () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    expect(getBackendUrl()).toBe("https://api.example.com");
  });

  it("не задан -> falsy, не бросает", () => {
    vi.stubEnv("VITE_BACKEND_URL", "");
    expect(getBackendUrl()).toBeFalsy();
  });

  it("createProPayment реально бьёт по пути БЕЗ двойного слеша, даже если адрес задан с завершающим", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com/"); // как в живом GitHub Actions
    stubTelegram("x");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, confirmationUrl: "https://yookassa.ru/checkout/pay-1" }) });
    vi.stubGlobal("fetch", fetchMock);

    await createProPayment();

    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/api/pay/create", expect.anything());
  });
});

describe("todayPlusDays", () => {
  const originalTZ = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = originalTZ;
  });

  it("возвращает дату в формате YYYY-MM-DD", () => {
    expect(todayPlusDays(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("прибавляет дни корректно, включая переход через конец месяца", () => {
    const start = new Date();
    const expected = new Date(start);
    expected.setDate(expected.getDate() + 10);
    const yyyy = expected.getFullYear();
    const mm = String(expected.getMonth() + 1).padStart(2, "0");
    const dd = String(expected.getDate()).padStart(2, "0");
    expect(todayPlusDays(10)).toBe(`${yyyy}-${mm}-${dd}`);
  });

  // Регрессия на жалобу "напоминание вообще не приходит": раньше дата
  // считалась через .toISOString() (UTC), а не локальные компоненты — для
  // ЛЮБОГО пользователя с положительным смещением от UTC (вся Россия) это
  // молча давало дату ВЧЕРА вместо СЕГОДНЯ, если открыть/собрать план в
  // первые N часов локальных суток (N = смещение в часах: для Москвы, UTC+3,
  // это полночь-3 утра; для Камчатки, UTC+12, — целых полсуток). Слот с
  // "не той" датой никогда не попадал в today/tomorrow на сервере в нужный
  // момент — напоминание просто никогда не отправлялось, без единой ошибки.
  // Явно фиксируем TZ процесса на Europe/Moscow — иначе тест либо ничего не
  // проверяет (если раннер и так в UTC, локальная и UTC-дата совпадут даже
  // при старом баге), либо зависит от часового пояса машины, на которой
  // запускается.
  it("регрессия: 01:30 по Москве 13 сентября — локальная дата, а не предыдущий UTC-день (22:30 UTC 12 сентября)", () => {
    process.env.TZ = "Europe/Moscow";
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 13, 1, 30)); // месяцы в Date() — с 0, 8 = сентябрь; локальное время при TZ=Europe/Moscow
    expect(todayPlusDays(0)).toBe("2026-09-13");
  });
});

describe("buildMealSlots", () => {
  const mealTimes = { breakfast: "08:00", lunch: "13:00", dinner: "19:00", snack: "16:00" };
  const planView = {
    days: [
      { day: 1, dayMeals: [{ mealId: "lunch", mealLabel: "Обед", recipe: { name: "Паста" } }, { mealId: "dinner", mealLabel: "Ужин", recipe: { name: "Суп" } }] },
      { day: 2, dayMeals: [{ mealId: "lunch", mealLabel: "Обед", recipe: { name: "Салат" } }] },
    ],
  };

  it("день 1 -> сегодняшняя дата, день 2 -> завтрашняя", () => {
    const slots = buildMealSlots(planView, mealTimes);
    expect(slots[0].scheduledDate).toBe(todayPlusDays(0));
    expect(slots[2].scheduledDate).toBe(todayPlusDays(1));
  });

  it("подставляет время из mealTimes по mealId", () => {
    const slots = buildMealSlots(planView, mealTimes);
    expect(slots.find((s) => s.mealType === "lunch" && s.scheduledDate === todayPlusDays(0)).mealTime).toBe("13:00");
    expect(slots.find((s) => s.mealType === "dinner").mealTime).toBe("19:00");
  });

  it("переносит название рецепта как recipeName", () => {
    const slots = buildMealSlots(planView, mealTimes);
    expect(slots.map((s) => s.recipeName)).toEqual(["Паста", "Суп", "Салат"]);
  });

  it("если для mealId нет времени в mealTimes — берёт разумный дефолт 19:00, не падает", () => {
    const slots = buildMealSlots(planView, {});
    expect(slots.every((s) => s.mealTime === "19:00")).toBe(true);
  });
});

describe("checkPlanStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("null без VITE_BACKEND_URL или вне Telegram — ничего не запрашивает", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "");
    stubTelegram("x");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await checkPlanStatus()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("возвращает распарсенный JSON-ответ бэкенда", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("initdata-blob");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, isPro: false, canGenerate: true }) }));
    const status = await checkPlanStatus();
    expect(status).toEqual({ ok: true, isPro: false, canGenerate: true });
  });

  it("null при сетевой ошибке или не-200 ответе — не бросает исключение", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await checkPlanStatus()).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await checkPlanStatus()).toBeNull();
  });
});

// Просьба в чате: "когда пользователь переходил в бота по кнопке 'написать
// в поддержку', ему должно высвечиваться, что напишите сейчас это обращение"
// — AccountView ждёт sendSupportPrompt() перед закрытием Mini App (см.
// App.jsx), см. buildSupportPromptText в server/src/webhook.js за текстом.
describe("sendSupportPrompt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("false без VITE_BACKEND_URL или вне Telegram — ничего не запрашивает", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "");
    stubTelegram("x");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendSupportPrompt()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("бьёт по /api/support/prompt с initData, возвращает true на успех", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("initdata-blob");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendSupportPrompt()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/api/support/prompt",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ initData: "initdata-blob" }) })
    );
  });

  it("false при сетевой ошибке или не-200 ответе — не бросает исключение", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await sendSupportPrompt()).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await sendSupportPrompt()).toBe(false);
  });
});

describe("savePlanToHistory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("ничего не делает без бэкенда/вне Telegram", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "");
    stubTelegram("x");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await savePlanToHistory({ storeId: "vv", storeName: "ВкусВилл", budget: 4000, family: 2, totalCost: 3800, plan: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("шлёт POST /api/plans с initData и данными плана", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("initdata-blob");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await savePlanToHistory({ storeId: "vv", storeName: "ВкусВилл", budget: 4000, family: 2, totalCost: 3800, plan: { days: [] } });

    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/api/plans", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ initData: "initdata-blob", storeId: "vv", storeName: "ВкусВилл", budget: 4000, family: 2, totalCost: 3800, plan: { days: [] } });
  });

  it("не бросает исключение при сетевой ошибке", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(savePlanToHistory({ storeId: "vv", storeName: "В", budget: 1, family: 1, plan: {} })).resolves.toBeUndefined();
  });
});

describe("updateMealTimes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("ничего не делает без бэкенда/вне Telegram", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "");
    stubTelegram("x");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await updateMealTimes({ lunch: "13:00" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("шлёт POST /api/meal-times с initData и временем", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("initdata-blob");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await updateMealTimes({ lunch: "13:00", dinner: "20:00" });

    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/api/meal-times", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ initData: "initdata-blob", mealTimes: { lunch: "13:00", dinner: "20:00" } });
  });

  it("не бросает исключение при сетевой ошибке", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(updateMealTimes({ lunch: "13:00" })).resolves.toBeUndefined();
  });
});

describe("fetchPlanHistory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("null без бэкенда/вне Telegram (не пустой массив — это другое состояние UI)", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "");
    stubTelegram("x");
    expect(await fetchPlanHistory()).toBeNull();
  });

  it("возвращает data.plans при успехе", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, plans: [{ id: 1 }] }) }));
    expect(await fetchPlanHistory()).toEqual([{ id: 1 }]);
  });

  it("null при сетевой ошибке", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await fetchPlanHistory()).toBeNull();
  });
});

// Общий серверный кэш цен ВкусВилл (server/src/vkusvillPrices.js) —
// attachRealCosts (vkusvillRecipes.js) пробует его первым, откатывается на
// прямые запросы к ВкусВилл, если тут вернулось null (см. её же тесты).
describe("resolvePricesViaBackend", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("null без бэкенда/вне Telegram/с пустым списком имён — ничего не запрашивает", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    vi.stubEnv("VITE_BACKEND_URL", "");
    stubTelegram("x");
    expect(await resolvePricesViaBackend(["Лук"])).toBeNull();

    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram(undefined);
    expect(await resolvePricesViaBackend(["Лук"])).toBeNull();

    stubTelegram("x");
    expect(await resolvePricesViaBackend([])).toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("возвращает data.prices при успехе", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, prices: [{ name: "Лук", matched: true, price: 58 }] }) }));
    expect(await resolvePricesViaBackend(["Лук"])).toEqual([{ name: "Лук", matched: true, price: 58 }]);
  });

  it("null при сетевой ошибке или не-200 ответе — не бросает исключение", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await resolvePricesViaBackend(["Лук"])).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await resolvePricesViaBackend(["Лук"])).toBeNull();
  });
});

describe("createProPayment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("{ok:false, reason:'no_backend_or_initdata'} без бэкенда/вне Telegram — ничего не запрашивает", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    vi.stubEnv("VITE_BACKEND_URL", "");
    stubTelegram("x");
    expect(await createProPayment()).toEqual({ ok: false, reason: "no_backend_or_initdata" });

    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram(undefined);
    expect(await createProPayment()).toEqual({ ok: false, reason: "no_backend_or_initdata" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("возвращает {ok:true, confirmationUrl} при успехе", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, confirmationUrl: "https://yookassa.ru/checkout/pay-1" }) }));
    expect(await createProPayment()).toEqual({ ok: true, confirmationUrl: "https://yookassa.ru/checkout/pay-1" });
  });

  // Регрессия на жалобу в чате: раньше все три случая ниже схлопывались в
  // один и тот же null — ни диагностика подключения (всё в порядке), ни
  // логи сервера (тоже пусто) не могли объяснить, что произошло на самом
  // деле. reason/detail теперь позволяют ProModal показать причину прямо в
  // интерфейсе, без DevTools и без переписки "что в логах".
  it("{ok:false, reason:'network_error'} с detail — сетевая ошибка (например нет интернета)", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await createProPayment()).toEqual({ ok: false, reason: "network_error", detail: "boom" });
  });

  it("{ok:false, reason:'server_error'} с detail — отказ сервера (например оплата не настроена)", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "оплата ещё не настроена" }) }));
    expect(await createProPayment()).toEqual({ ok: false, reason: "server_error", detail: "HTTP 503: оплата ещё не настроена" });
  });

  it("{ok:false, reason:'no_url'} — сервер ответил успехом, но без confirmationUrl", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
    expect(await createProPayment()).toEqual({ ok: false, reason: "no_url" });
  });
});

describe("claimReferral", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("без бэкенда/вне Telegram — ничего не запрашивает", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_BACKEND_URL", "");
    stubTelegram("x");
    await claimReferral(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("шлёт POST /api/referral/claim с initData и referrerTelegramId", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("initdata-blob");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, claimed: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await claimReferral(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/referral/claim");
    expect(JSON.parse(opts.body)).toEqual({ initData: "initdata-blob", referrerTelegramId: 1 });
  });

  it("не бросает исключение при сетевой ошибке", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(claimReferral(1)).resolves.toBeUndefined();
  });
});

describe("fetchReferralStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("null без бэкенда/вне Telegram", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "");
    stubTelegram("x");
    expect(await fetchReferralStatus()).toBeNull();
  });

  it("возвращает распарсенный JSON-ответ бэкенда", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, rewardedCount: 2, daysEarned: 14 }) }));
    expect(await fetchReferralStatus()).toEqual({ ok: true, rewardedCount: 2, daysEarned: 14 });
  });

  it("null при сетевой ошибке или не-200 ответе", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await fetchReferralStatus()).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await fetchReferralStatus()).toBeNull();
  });
});

// Живой вывод из ревью Pro-плюшек: "Общий список на семью" — 4 функции ниже
// зеркалят server/src/family.js, тот же принцип "бэкенд опционален", что и у
// остальных функций этого файла (claimReferral/fetchReferralStatus выше).
describe("createFamily / joinFamily / leaveFamily / fetchFamilyStatus / toggleFamilyPantryItem", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("null без бэкенда/вне Telegram — ни одна функция не запрашивает", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "");
    stubTelegram("x");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await createFamily()).toBeNull();
    expect(await joinFamily(1)).toBeNull();
    expect(await leaveFamily()).toBeNull();
    expect(await fetchFamilyStatus()).toBeNull();
    expect(await toggleFamilyPantryItem("Мука", true)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("createFamily шлёт POST /api/family/create с initData, возвращает ответ как есть", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("initdata-blob");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: { inFamily: true, isOwner: true } }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await createFamily()).toEqual({ ok: true, status: { inFamily: true, isOwner: true } });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/family/create");
    expect(JSON.parse(opts.body)).toEqual({ initData: "initdata-blob" });
  });

  it("createFamily: сервер отказал (не Pro) -> отдаёт {ok:false, error} как есть, не бросает", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ ok: false, error: "создание семьи доступно только на Pro" }) }));
    expect(await createFamily()).toEqual({ ok: false, error: "создание семьи доступно только на Pro" });
  });

  it("joinFamily шлёт POST /api/family/join с initData и inviteCode", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("initdata-blob");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: { inFamily: true } }) });
    vi.stubGlobal("fetch", fetchMock);
    await joinFamily("abc123XYZ_-");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/family/join");
    expect(JSON.parse(opts.body)).toEqual({ initData: "initdata-blob", inviteCode: "abc123XYZ_-" });
  });

  it("leaveFamily шлёт POST /api/family/leave", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("initdata-blob");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await leaveFamily()).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/api/family/leave");
  });

  it("fetchFamilyStatus: null при сетевой ошибке или не-200 ответе", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("x");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await fetchFamilyStatus()).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await fetchFamilyStatus()).toBeNull();
  });

  it("toggleFamilyPantryItem шлёт name и present, возвращает pantryNames из ответа", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("initdata-blob");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, pantryNames: ["Мука", "Соль"] }) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await toggleFamilyPantryItem("Мука", true);
    expect(result).toEqual({ ok: true, pantryNames: ["Мука", "Соль"] });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/family/pantry");
    expect(JSON.parse(opts.body)).toEqual({ initData: "initdata-blob", name: "Мука", present: true });
  });
});
