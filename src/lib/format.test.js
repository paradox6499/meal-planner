import { describe, it, expect } from "vitest";
import { formatIngredientAmount } from "./format.js";

describe("formatIngredientAmount", () => {
  it("штуки округляем вверх и не показываем «0 шт»", () => {
    expect(formatIngredientAmount(0.3, 2, "шт")).toBe("1 шт");
    expect(formatIngredientAmount(0.5, 3, "шт")).toBe("2 шт");
    expect(formatIngredientAmount(2, 2, "шт")).toBe("4 шт");
  });

  it("граммы и миллилитры — целое, не меньше единицы", () => {
    expect(formatIngredientAmount(33.3, 3, "г")).toBe("100 г");
    expect(formatIngredientAmount(0.2, 1, "г")).toBe("1 г");
    expect(formatIngredientAmount(150, 2, "мл")).toBe("300 мл");
  });

  it("нет количества — «по вкусу»", () => {
    expect(formatIngredientAmount(0, 2, "г")).toBe("по вкусу");
    expect(formatIngredientAmount(undefined, 2, "г")).toBe("по вкусу");
  });
});
