import { describe, it, expect } from "vitest";
import { initPlanSession, planSessionReducer as reduce, DEFAULT_BUDGET } from "./planSessionReducer.js";
import { DEFAULT_STORE } from "../constants.js";

const prices = new Map([["Гречка", { price: 1, productUnit: "г" }]]);
const slotA = {
  id: "a", store: "vv", budget: 5000, createdAt: "2026-10-10T10:00:00.000Z",
  planState: { days: [{ day: 1, dayMeals: [{ category: "main", recipeId: "r1" }] }], warnings: [] },
  pools: { main: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] },
  priceByName: prices, generationPending: true, catalogReason: "цены на продукты не получены",
};

describe("initPlanSession", () => {
  it("без слота — пустой визард с дефолтами", () => {
    expect(initPlanSession(null)).toEqual({
      planSlotId: null, store: DEFAULT_STORE, budget: DEFAULT_BUDGET, planCreatedAt: null, planState: null, pools: null,
      priceByName: null, done: false, generationPending: false, catalogReason: null,
      assembling: false, retryingPrices: false, priceRetryFailed: false, epoch: 0,
    });
  });

  it("со слотом — его план на экране, включая отметку «ждёт засчитывания»", () => {
    expect(initPlanSession(slotA)).toMatchObject({ planSlotId: "a", store: "vv", budget: 5000, done: true, generationPending: true, catalogReason: "цены на продукты не получены" });
  });
});

describe("planSessionReducer: смена плана на экране", () => {
  it("slotShown — всё от нового слота, номер плана растёт", () => {
    const s = reduce({ ...initPlanSession(null), assembling: true }, { type: "slotShown", slot: slotA });
    expect(s).toMatchObject({ planSlotId: "a", done: true, generationPending: true, assembling: false, epoch: 1 });
  });

  it("slotShown(null) — пустой визард", () => {
    expect(reduce(initPlanSession(slotA), { type: "slotShown", slot: null })).toMatchObject({ planSlotId: null, done: false, generationPending: false, planState: null });
  });

  it("blankPlanStarted без slotId («Новый план») — тот же слот, план и отметка сброшены", () => {
    const s = reduce(initPlanSession(slotA), { type: "blankPlanStarted" });
    expect(s).toMatchObject({ planSlotId: "a", store: DEFAULT_STORE, budget: DEFAULT_BUDGET, done: false, planState: null, pools: null, priceByName: null, generationPending: false, catalogReason: null, epoch: 1 });
  });

  it("blankPlanStarted со slotId («Ещё план») — новый слот", () => {
    expect(reduce(initPlanSession(slotA), { type: "blankPlanStarted", slotId: "b" }).planSlotId).toBe("b");
  });

  it("planBuilt — новый план на экране; id слота берётся новый, только если своего ещё нет", () => {
    const built = { type: "planBuilt", newSlotId: "fresh", planState: slotA.planState, pools: slotA.pools, priceByName: null, createdAt: "t", generationPending: false, catalogReason: null };
    expect(reduce({ ...initPlanSession(null), assembling: true }, built)).toMatchObject({ planSlotId: "fresh", done: true, assembling: false, epoch: 1 });
    expect(reduce(initPlanSession(slotA), built)).toMatchObject({ planSlotId: "a", generationPending: false, catalogReason: null });
  });
});

describe("planSessionReducer: повтор цен", () => {
  it("тот же план — цены применяются, «не получилось» по пустому ответу", () => {
    let s = reduce(initPlanSession(slotA), { type: "priceRetryStarted" });
    expect(s).toMatchObject({ retryingPrices: true, priceRetryFailed: false });
    const fresh = new Map([["Лук", { price: 2, productUnit: "г" }]]);
    s = reduce(s, { type: "priceRetrySucceeded", epoch: 0, prices: fresh });
    expect(s).toMatchObject({ priceByName: fresh, retryingPrices: false, priceRetryFailed: false });
    expect(reduce(s, { type: "priceRetrySucceeded", epoch: 0, prices: new Map() }).priceRetryFailed).toBe(true);
  });

  it("на экране уже другой план — цены устаревшего повтора не применяются, только снимается «идёт повтор»", () => {
    let s = reduce(initPlanSession(slotA), { type: "priceRetryStarted" });
    s = reduce(s, { type: "slotShown", slot: { ...slotA, id: "b", priceByName: null, generationPending: false } });
    s = reduce(s, { type: "priceRetrySucceeded", epoch: 0, prices: new Map([["Чужое", { price: 100 }]]) });
    expect(s).toMatchObject({ planSlotId: "b", priceByName: null, retryingPrices: false });
  });

  it("ошибка повтора — «не получилось» только у того же плана", () => {
    let s = reduce(initPlanSession(slotA), { type: "priceRetryStarted" });
    expect(reduce(s, { type: "priceRetryFailed", epoch: 0 })).toMatchObject({ retryingPrices: false, priceRetryFailed: true });
    s = reduce(s, { type: "slotShown", slot: null });
    expect(reduce(s, { type: "priceRetryFailed", epoch: 0 })).toMatchObject({ retryingPrices: false, priceRetryFailed: false });
  });
});

describe("planSessionReducer: прочее", () => {
  it("mealSwapped — следующий рецепт из пула той же категории, по кругу", () => {
    let s = reduce(initPlanSession(slotA), { type: "mealSwapped", dayIndex: 0, slotIndex: 0 });
    expect(s.planState.days[0].dayMeals[0].recipeId).toBe("r2");
    s = reduce(reduce(s, { type: "mealSwapped", dayIndex: 0, slotIndex: 0 }), { type: "mealSwapped", dayIndex: 0, slotIndex: 0 });
    expect(s.planState.days[0].dayMeals[0].recipeId).toBe("r1");
  });

  it("generationCompleted — отметка и причина сняты", () => {
    expect(reduce(initPlanSession(slotA), { type: "generationCompleted" })).toMatchObject({ generationPending: false, catalogReason: null });
  });

  it("неизвестное действие — ошибка, а не молчаливое игнорирование", () => {
    expect(() => reduce(initPlanSession(null), { type: "что-то" })).toThrow(/неизвестное действие/);
  });
});
