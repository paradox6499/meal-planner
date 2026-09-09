import { describe, it, expect } from "vitest";
import { buildMealSlots, todayPlusDays } from "./backend.js";

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
