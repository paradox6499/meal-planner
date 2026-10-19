import { describe, it, expect } from "vitest";
import { isNotPurchased, isSpice, mergeIngredientUnits, displayAmount } from "./shoppingList.js";
import { resolveIngredientCost, estimatePieceGrams } from "./vkusvillRecipes.js";
import { parsePackageAmount } from "./vkusvillMcp.js";

describe("не покупают", () => {
  it("вода и соль — нет, а «вода газированная» и «соль морская» — да", () => {
    expect(isNotPurchased("Вода")).toBe(true);
    expect(isNotPurchased("соль")).toBe(true);
    expect(isNotPurchased("Соль поваренная")).toBe(true);
    expect(isNotPurchased("Вода газ.")).toBe(false);
    expect(isNotPurchased("Соль морская")).toBe(false);
    expect(isNotPurchased("Сольянка")).toBe(false);
  });
});

describe("mergeIngredientUnits", () => {
  const entries = (...list) => list.map(([name, unit, amount, lastDay = 1]) => ({ name, unit, amount, lastDay }));

  it("г и мл одного продукта склеиваются в ту единицу, которой больше", () => {
    const out = mergeIngredientUnits(entries(["Масло оливковое", "г", 18], ["Масло оливковое", "мл", 49]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ unit: "мл", amount: 67 });
  });

  it("шт и граммы — в штуки, если известен вес штуки: 2 шт + 38 г помидоров = 2,3 шт", () => {
    const out = mergeIngredientUnits(entries(["Помидоры", "шт", 2], ["Помидоры", "г", 38]), estimatePieceGrams);
    expect(out).toHaveLength(1);
    expect(out[0].unit).toBe("шт");
    expect(out[0].amount).toBeCloseTo(2 + 38 / 120, 5);
    expect(displayAmount(out[0].amount, "шт")).toBe(3);
  });

  it("вес штуки неизвестен — позиции остаются раздельными", () => {
    const out = mergeIngredientUnits(entries(["Сметана", "мл", 83], ["Сметана", "г", 12]));
    expect(out).toHaveLength(1); // г и мл склеиваются
    const mixed = mergeIngredientUnits(entries(["Чабрец", "шт", 2], ["Чабрец", "г", 5]), () => null);
    expect(mixed).toHaveLength(2);
  });

  it("берёт самый поздний день для пометки «можно заморозить»", () => {
    const out = mergeIngredientUnits(entries(["Курица бедро", "шт", 2, 2], ["Курица бедро", "г", 133, 6]), estimatePieceGrams);
    expect(out[0].lastDay).toBe(6);
  });
});

describe("displayAmount", () => {
  it("никаких нулей; штуки вверх", () => {
    expect(displayAmount(0.2, "шт")).toBe(1);
    expect(displayAmount(0, "шт")).toBe(1);
    expect(displayAmount(2.01, "шт")).toBe(3);
    expect(displayAmount(0.4, "г")).toBe(1);
    expect(displayAmount(549.6, "г")).toBe(550);
  });
});

describe("цена ингредиента: упаковки и специи", () => {
  it("упаковка с числом штук в названии: яйцо за 119 ₽ в десятке — 12 ₽ штука", () => {
    expect(parsePackageAmount("Яйцо куриное С1, 10 шт")).toEqual({ amount: 10, unit: "шт" });
    const info = { price: 119, productUnit: "шт", packageAmount: 10, packageUnit: "шт" };
    expect(resolveIngredientCost("Яйцо куриное", 3, "шт", info)).toBeCloseTo(35.7, 1);
  });

  it("«1 шт» в названии — не упаковка; вес в названии важнее штук", () => {
    expect(parsePackageAmount("Лимон, 1 шт")).toBeNull();
    expect(parsePackageAmount("Булочка, 4 шт по 80 г")).toEqual({ amount: 80, unit: "г" });
  });

  it("лавровый лист: три «листа» — одна упаковка, а не три", () => {
    expect(isSpice("Лавровый лист")).toBe(true);
    expect(resolveIngredientCost("Лавровый лист", 3, "шт", { price: 61, productUnit: "шт" })).toBe(61);
  });

  it("обычное поштучное (лимон) считается 1:1, вода и соль — ноль", () => {
    expect(resolveIngredientCost("Лимон", 2, "шт", { price: 30, productUnit: "шт" })).toBe(60);
    expect(resolveIngredientCost("Вода", 450, "мл", { price: 21, productUnit: "шт" })).toBe(0);
    expect(resolveIngredientCost("Соль", 10, "г", null)).toBe(0);
  });
});
