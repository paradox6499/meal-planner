import { describe, it, expect, vi, afterEach } from "vitest";
import { buildMealSlots, todayPlusDays, checkPlanStatus, savePlanToHistory, fetchPlanHistory } from "./backend.js";

function stubTelegram(initData) {
  vi.stubGlobal("window", { Telegram: initData !== undefined ? { WebApp: { initData } } : undefined });
}

describe("todayPlusDays", () => {
  it("возвращает дату в формате YYYY-MM-DD", () => {
    expect(todayPlusDays(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("прибавляет дни корректно, включая переход через конец месяца", () => {
    const start = new Date();
    const expected = new Date(start);
    expected.setDate(expected.getDate() + 10);
    expect(todayPlusDays(10)).toBe(expected.toISOString().slice(0, 10));
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
