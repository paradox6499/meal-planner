import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadActivePlan, saveActivePlan, clearActivePlan } from "./activePlan.js";

// Окружение тестов — node, не jsdom (см. vitest.config.js), поэтому
// глобального localStorage тут нет по умолчанию — подставляем минимальный
// рабочий стаб, этого достаточно для проверки самой логики модуля.
function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

describe("activePlan", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
  });

  it("loadActivePlan без сохранённого плана -> null", () => {
    expect(loadActivePlan()).toBeNull();
  });

  it("сохраняет и восстанавливает план, включая Map priceByName (JSON её не переживает как есть)", () => {
    const priceByName = new Map([["Гречка", { price: 3.5, productUnit: "г" }]]);
    saveActivePlan({ store: "vv", budget: 4000, planState: { days: [], warnings: [] }, pools: { main: [], breakfast: [], snack: [] }, priceByName });

    const restored = loadActivePlan();
    expect(restored.store).toBe("vv");
    expect(restored.budget).toBe(4000);
    expect(restored.planState).toEqual({ days: [], warnings: [] });
    expect(restored.priceByName).toBeInstanceOf(Map);
    expect(restored.priceByName.get("Гречка")).toEqual({ price: 3.5, productUnit: "г" });
  });

  it("priceByName: null сохраняется и восстанавливается как null, а не как пустая Map", () => {
    saveActivePlan({ store: "px", budget: 3000, planState: { days: [], warnings: [] }, pools: {}, priceByName: null });
    expect(loadActivePlan().priceByName).toBeNull();
  });

  it("clearActivePlan убирает запись — loadActivePlan снова null", () => {
    saveActivePlan({ store: "vv", budget: 4000, planState: { days: [], warnings: [] }, pools: {}, priceByName: null });
    clearActivePlan();
    expect(loadActivePlan()).toBeNull();
  });

  it("повреждённая/чужая запись в localStorage не роняет приложение — просто null", () => {
    localStorage.setItem("sedim.activePlan.v1", "не json вообще");
    expect(loadActivePlan()).toBeNull();

    localStorage.setItem("sedim.activePlan.v1", JSON.stringify({ store: "vv" })); // нет planState/pools
    expect(loadActivePlan()).toBeNull();
  });
});
