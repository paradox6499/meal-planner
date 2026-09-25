import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadActivePlanSlots, saveActivePlanSlot, setActiveSlotId, removeActivePlanSlot, clearAllActivePlans, MAX_PRO_SLOTS } from "./activePlan.js";

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

const emptyPlan = { planState: { days: [], warnings: [] }, pools: { main: [], breakfast: [], snack: [] } };

describe("activePlan — слоты (см. комментарий в activePlan.js про 'Несколько планов одновременно')", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
  });

  it("без сохранённых планов -> пустой список слотов, activeSlotId null", () => {
    expect(loadActivePlanSlots()).toEqual({ slots: [], activeSlotId: null });
  });

  it("сохраняет слот, включая Map priceByName (JSON её не переживает как есть)", () => {
    const priceByName = new Map([["Гречка", { price: 3.5, productUnit: "г" }]]);
    saveActivePlanSlot({ id: "s1", store: "vv", budget: 4000, ...emptyPlan, priceByName });
    setActiveSlotId("s1");

    const { slots, activeSlotId } = loadActivePlanSlots();
    expect(activeSlotId).toBe("s1");
    expect(slots).toHaveLength(1);
    expect(slots[0].store).toBe("vv");
    expect(slots[0].budget).toBe(4000);
    expect(slots[0].priceByName).toBeInstanceOf(Map);
    expect(slots[0].priceByName.get("Гречка")).toEqual({ price: 3.5, productUnit: "г" });
  });

  it("priceByName: null сохраняется и восстанавливается как null, а не как пустая Map", () => {
    saveActivePlanSlot({ id: "s1", store: "px", budget: 3000, ...emptyPlan, priceByName: null });
    expect(loadActivePlanSlots().slots[0].priceByName).toBeNull();
  });

  it("повторное сохранение с тем же id обновляет слот на месте, не добавляет второй", () => {
    saveActivePlanSlot({ id: "s1", store: "vv", budget: 4000, ...emptyPlan, priceByName: null });
    saveActivePlanSlot({ id: "s1", store: "vv", budget: 5000, ...emptyPlan, priceByName: null });
    const { slots } = loadActivePlanSlots();
    expect(slots).toHaveLength(1);
    expect(slots[0].budget).toBe(5000);
  });

  it("разные id -> несколько слотов одновременно (до MAX_PRO_SLOTS)", () => {
    for (let i = 0; i < MAX_PRO_SLOTS; i++) {
      saveActivePlanSlot({ id: `s${i}`, store: "vv", budget: 4000, ...emptyPlan, priceByName: null });
    }
    expect(loadActivePlanSlots().slots).toHaveLength(MAX_PRO_SLOTS);
  });

  it("setActiveSlotId переключает указатель, не трогая сами слоты", () => {
    saveActivePlanSlot({ id: "s1", store: "vv", budget: 4000, ...emptyPlan, priceByName: null });
    saveActivePlanSlot({ id: "s2", store: "px", budget: 3000, ...emptyPlan, priceByName: null });
    setActiveSlotId("s1");
    setActiveSlotId("s2");
    const { slots, activeSlotId } = loadActivePlanSlots();
    expect(activeSlotId).toBe("s2");
    expect(slots).toHaveLength(2);
  });

  it("removeActivePlanSlot удаляет один слот, остальные остаются", () => {
    saveActivePlanSlot({ id: "s1", store: "vv", budget: 4000, ...emptyPlan, priceByName: null });
    saveActivePlanSlot({ id: "s2", store: "px", budget: 3000, ...emptyPlan, priceByName: null });
    setActiveSlotId("s1");
    removeActivePlanSlot("s1");
    const { slots, activeSlotId } = loadActivePlanSlots();
    expect(slots.map((s) => s.id)).toEqual(["s2"]);
    // удалили активный слот -> новый активный выбран автоматически из оставшихся
    expect(activeSlotId).toBe("s2");
  });

  it("removeActivePlanSlot последнего слота -> activeSlotId снова null", () => {
    saveActivePlanSlot({ id: "s1", store: "vv", budget: 4000, ...emptyPlan, priceByName: null });
    setActiveSlotId("s1");
    removeActivePlanSlot("s1");
    expect(loadActivePlanSlots()).toEqual({ slots: [], activeSlotId: null });
  });

  it("removeActivePlanSlot неактивного слота не меняет activeSlotId", () => {
    saveActivePlanSlot({ id: "s1", store: "vv", budget: 4000, ...emptyPlan, priceByName: null });
    saveActivePlanSlot({ id: "s2", store: "px", budget: 3000, ...emptyPlan, priceByName: null });
    setActiveSlotId("s1");
    removeActivePlanSlot("s2");
    expect(loadActivePlanSlots().activeSlotId).toBe("s1");
  });

  it("clearAllActivePlans убирает всё — loadActivePlanSlots снова пуст", () => {
    saveActivePlanSlot({ id: "s1", store: "vv", budget: 4000, ...emptyPlan, priceByName: null });
    saveActivePlanSlot({ id: "s2", store: "px", budget: 3000, ...emptyPlan, priceByName: null });
    clearAllActivePlans();
    expect(loadActivePlanSlots()).toEqual({ slots: [], activeSlotId: null });
  });

  it("повреждённая запись под новым ключом не роняет приложение — просто пустой список", () => {
    localStorage.setItem("sedim.activePlanSlots.v1", "не json вообще");
    expect(loadActivePlanSlots()).toEqual({ slots: [], activeSlotId: null });
  });

  it("слот без planState/pools в хранилище отфильтровывается, не роняет остальные", () => {
    localStorage.setItem(
      "sedim.activePlanSlots.v1",
      JSON.stringify({ activeSlotId: "s1", slots: [{ id: "s1", store: "vv" }, { id: "s2", store: "px", planState: { days: [] }, pools: {} }] })
    );
    expect(loadActivePlanSlots().slots.map((s) => s.id)).toEqual(["s2"]);
  });
});

// Живой вывод из ревью: у существующих пользователей до этого обновления план
// лежал в старом формате (один объект без обёртки в слоты, ключ
// sedim.activePlan.v1) — обновление не должно "стереть" уже собранный план.
describe("activePlan — миграция старого формата (один план без слотов)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
  });

  it("старый формат -> один слот, становится активным", () => {
    const legacyPriceEntries = [["Гречка", { price: 3.5, productUnit: "г" }]];
    localStorage.setItem(
      "sedim.activePlan.v1",
      JSON.stringify({ store: "vv", budget: 4500, planState: { days: [], warnings: [] }, pools: { main: [] }, priceByNameEntries: legacyPriceEntries })
    );
    const { slots, activeSlotId } = loadActivePlanSlots();
    expect(slots).toHaveLength(1);
    expect(activeSlotId).toBe(slots[0].id);
    expect(slots[0].store).toBe("vv");
    expect(slots[0].budget).toBe(4500);
    expect(slots[0].priceByName.get("Гречка")).toEqual({ price: 3.5, productUnit: "г" });
  });

  it("миграция происходит один раз — повторный вызов не плодит второй слот", () => {
    localStorage.setItem(
      "sedim.activePlan.v1",
      JSON.stringify({ store: "vv", budget: 4000, planState: { days: [], warnings: [] }, pools: {}, priceByNameEntries: null })
    );
    loadActivePlanSlots();
    loadActivePlanSlots();
    expect(loadActivePlanSlots().slots).toHaveLength(1);
  });

  it("старая запись повреждена -> не падает, просто пустой список слотов", () => {
    localStorage.setItem("sedim.activePlan.v1", "не json вообще");
    expect(loadActivePlanSlots()).toEqual({ slots: [], activeSlotId: null });
  });

  it("нет ни старого, ни нового формата -> пустой список, без ошибок", () => {
    expect(loadActivePlanSlots()).toEqual({ slots: [], activeSlotId: null });
  });

  it("clearAllActivePlans убирает и старый ключ тоже — не оживает после сброса", () => {
    localStorage.setItem(
      "sedim.activePlan.v1",
      JSON.stringify({ store: "vv", budget: 4000, planState: { days: [], warnings: [] }, pools: {}, priceByNameEntries: null })
    );
    clearAllActivePlans();
    expect(loadActivePlanSlots()).toEqual({ slots: [], activeSlotId: null });
    expect(localStorage.getItem("sedim.activePlan.v1")).toBeNull();
  });
});
