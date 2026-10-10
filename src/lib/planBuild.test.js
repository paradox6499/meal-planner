import { describe, it, expect } from "vitest";
import { isCatalogPlan, assessPlanBuild, canCompletePendingBuild, toHistoryPlan } from "./planBuild.js";

const catalogPools = { main: [{ id: "vv-1" }, { id: "vv-2" }], breakfast: [{ id: "vv-3" }] };
const staticPools = { main: [{ id: "vv-1" }, { id: "pasta" }] };

describe("isCatalogPlan", () => {
  it("все рецепты с id vv-… — план из каталога", () => {
    expect(isCatalogPlan(catalogPools)).toBe(true);
  });
  it("хотя бы один статический рецепт — не из каталога", () => {
    expect(isCatalogPlan(staticPools)).toBe(false);
  });
  it("пулов нет — не из каталога", () => {
    expect(isCatalogPlan(null)).toBe(false);
  });
});

describe("assessPlanBuild", () => {
  it("ВкусВилл, каталог ответил, цены есть — полноценная сборка", () => {
    expect(assessPlanBuild({ store: "vv", catalogError: null, view: { mostlyUnpriced: false } })).toEqual({ degraded: false, reason: null });
  });
  it("каталог не ответил — вырожденная, причина — текст ошибки", () => {
    expect(assessPlanBuild({ store: "vv", catalogError: "таймаут", view: { mostlyUnpriced: false } })).toEqual({ degraded: true, reason: "таймаут" });
  });
  it("цены почти не получены — вырожденная, причина по умолчанию", () => {
    expect(assessPlanBuild({ store: "vv", catalogError: null, view: { mostlyUnpriced: true } })).toEqual({ degraded: true, reason: "цены на продукты не получены" });
  });
  it("другие сети не бывают вырожденными (цен у них нет по определению)", () => {
    expect(assessPlanBuild({ store: "px", catalogError: null, view: { mostlyUnpriced: true } }).degraded).toBe(false);
  });
});

describe("canCompletePendingBuild", () => {
  it("рецепты из каталога и цены получены — можно засчитать", () => {
    expect(canCompletePendingBuild({ pools: catalogPools, view: { mostlyUnpriced: false } })).toBe(true);
  });
  it("цены всё ещё не получены — нельзя", () => {
    expect(canCompletePendingBuild({ pools: catalogPools, view: { mostlyUnpriced: true } })).toBe(false);
  });
  it("базовые рецепты (каталог не отвечал) — нельзя, даже если цены есть", () => {
    expect(canCompletePendingBuild({ pools: staticPools, view: { mostlyUnpriced: false } })).toBe(false);
  });
});

describe("toHistoryPlan", () => {
  it("берёт смотровые поля рецепта и считает позиции списка покупок", () => {
    const view = {
      total: 1200,
      itemized: true,
      grouped: [{ items: [1, 2] }, { items: [3] }],
      days: [{
        day: 1,
        dayMeals: [{
          mealLabel: "Ужин", cost: 300, family: 2, isRealPrice: true,
          recipe: { name: "Паста", emoji: "🍝", time: 20, ingr: [["Макароны", 200, "г"]], steps: ["Сварить"], cuisine: "it", diets: ["any"] },
        }],
      }],
    };
    expect(toHistoryPlan(view)).toEqual({
      total: 1200,
      itemized: true,
      shoppingItemsCount: 3,
      days: [{
        day: 1,
        dayMeals: [{
          mealLabel: "Ужин", name: "Паста", emoji: "🍝", time: 20, cost: 300, photoUrl: null,
          ingr: [["Макароны", 200, "г"]], steps: ["Сварить"], nutritionPer100g: null, family: 2, isRealPrice: true,
        }],
      }],
    });
  });
});
