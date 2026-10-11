import { describe, it, expect } from "vitest";
import { isNutritionDiet, matchesNutritionDiet, countDietMismatches, NUTRITION_DIETS } from "./nutrition.js";

const n = (calories, protein, fat) => ({ calories, protein, fat, carbs: 10 });

describe("диеты по КБЖУ", () => {
  it("распознаёт только свои диеты", () => {
    expect(isNutritionDiet("protein")).toBe(true);
    expect(isNutritionDiet("light")).toBe(true);
    expect(isNutritionDiet("veg")).toBe(false);
    expect(isNutritionDiet("any")).toBe(false);
    expect(isNutritionDiet("toString")).toBe(false); // не путает с полями Object
  });

  it("высокобелковый: белок ≥ 8 г и ≥ 22% калорий из белка (на 100 г)", () => {
    expect(matchesNutritionDiet(n(140, 17, 7), "protein")).toBe(true); // 17*4/140 = 49%
    expect(matchesNutritionDiet(n(300, 8, 20), "protein")).toBe(false); // 8*4/300 = 11%
    expect(matchesNutritionDiet(n(100, 7.9, 3), "protein")).toBe(false); // меньше 8 г
    expect(matchesNutritionDiet(n(150, 8, 5), "protein")).toBe(false); // 8*4/150 = 21%
    expect(matchesNutritionDiet(n(144, 8, 5), "protein")).toBe(true); // ровно 22,2%
  });

  it("лёгкое: ≤ 150 ккал и ≤ 7 г жира", () => {
    expect(matchesNutritionDiet(n(150, 5, 7), "light")).toBe(true);
    expect(matchesNutritionDiet(n(151, 5, 3), "light")).toBe(false);
    expect(matchesNutritionDiet(n(120, 5, 7.1), "light")).toBe(false);
  });

  it("нет данных о КБЖУ — null (подтвердить нельзя); для обычных диет — true", () => {
    expect(matchesNutritionDiet(null, "protein")).toBeNull();
    expect(matchesNutritionDiet({ calories: 0 }, "light")).toBeNull();
    expect(matchesNutritionDiet(null, "veg")).toBe(true);
    expect(Object.keys(NUTRITION_DIETS)).toEqual(["protein", "light"]);
  });
});

describe("countDietMismatches (заметка на экране плана)", () => {
  const day = (...ns) => ({ dayMeals: ns.map((nutritionPer100g) => ({ recipe: { nutritionPer100g } })) });

  it("считает блюда, не подходящие под диету, и блюда без данных", () => {
    const days = [day(n(140, 17, 7), n(300, 8, 20)), day(null)];
    expect(countDietMismatches(days, "protein")).toEqual({ mismatched: 2, total: 3 });
  });

  it("для обычных диет и пустого плана — нули", () => {
    expect(countDietMismatches([day(null)], "veg")).toEqual({ mismatched: 0, total: 0 });
    expect(countDietMismatches(undefined, "protein")).toEqual({ mismatched: 0, total: 0 });
  });
});
