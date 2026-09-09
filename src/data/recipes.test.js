import { describe, it, expect } from "vitest";
import { RECIPES, departmentOf, forbiddenIngredientsFor, recipeHasAllergen, effectiveRecipeCost, ALLERGENS } from "./recipes.js";

describe("departmentOf", () => {
  it("распознаёт все ингредиенты из собственных 41 рецепта (регрессия: раньше было точное совпадение, реальные названия ВкусВилл в него не попадали)", () => {
    const names = new Set(RECIPES.flatMap((r) => r.ingr.map(([name]) => name)));
    names.forEach((name) => {
      expect(departmentOf(name), `"${name}" не распознан ни одним отделом`).not.toBe("Разное");
    });
  });

  it("регрессия: 'огурец' (беглая гласная, не 'огурц') находит отдел овощей", () => {
    expect(departmentOf("Огурцы солёные")).toBe("Овощи и фрукты");
    expect(departmentOf("огурец")).toBe("Овощи и фрукты");
  });

  it("регрессия: 'Яйцо куриное' — молочное и яйца, а не мясо (стем 'курин' раньше перетягивал в мясной отдел)", () => {
    expect(departmentOf("Яйцо куриное")).toBe("Молочное и яйца");
  });

  it("реальные названия из каталога ВкусВилл раскладываются по ожидаемым отделам", () => {
    const cases = {
      "Фарш из индейки": "Мясо и рыба",
      "Желудки куриные": "Мясо и рыба",
      "Сосиски": "Мясо и рыба",
      "Масло сливочное": "Молочное и яйца",
      "Сельдерей стебель": "Овощи и фрукты",
      "Имбирь корень": "Овощи и фрукты",
      "Соус томатный": "Овощи и фрукты",
      "Масло подсолнечное раф.": "Бакалея",
      "Вода": "Бакалея",
    };
    Object.entries(cases).forEach(([name, expected]) => {
      expect(departmentOf(name), name).toBe(expected);
    });
  });

  it("незнакомое название уходит в 'Разное', а не падает", () => {
    expect(departmentOf("совершенно неизвестный продукт xyz")).toBe("Разное");
  });
});

describe("forbiddenIngredientsFor / recipeHasAllergen", () => {
  it("пустой список аллергий не запрещает ничего", () => {
    const forbidden = forbiddenIngredientsFor([]);
    expect(forbidden.size).toBe(0);
    expect(recipeHasAllergen(RECIPES[0], forbidden)).toBe(false);
  });

  it("находит рецепт с запрещённым ингредиентом для каждой заявленной аллергии", () => {
    ALLERGENS.forEach((a) => {
      const forbidden = forbiddenIngredientsFor([a.id]);
      const hit = RECIPES.find((r) => recipeHasAllergen(r, forbidden));
      expect(hit, `ни один рецепт не считается нарушающим аллергию "${a.label}" — сама аллергия непроверяема`).toBeDefined();
    });
  });
});

describe("effectiveRecipeCost", () => {
  it("для рецепта с isRealPrice уважает его собственный флаг, не лезет в PRICES.json", () => {
    const recipe = { cost: 250, isRealPrice: true, ingr: [] };
    expect(effectiveRecipeCost(recipe)).toEqual([250, true]);
  });

  it("для рецепта с isRealPrice=false (частичное совпадение) тоже уважает флаг как есть", () => {
    const recipe = { cost: 80, isRealPrice: false, ingr: [] };
    expect(effectiveRecipeCost(recipe)).toEqual([80, false]);
  });

  it("для статического рецепта без isRealPrice откатывается на recipe.cost, когда PRICES пуст", () => {
    const recipe = { cost: 180, ingr: [["куриное филе", 130, "г"]] };
    expect(effectiveRecipeCost(recipe, {})).toEqual([180, false]);
  });

  it("считает реальную цену по PRICES, когда данные есть для всех ингредиентов", () => {
    const recipe = { cost: 999, ingr: [["куриное филе", 200, "г"]] };
    const prices = { "куриное филе": { unit: "kg", price_per_unit: 500 } };
    // 200г × (1/1000 кг/г) × 500 ₽/кг = 100 ₽
    expect(effectiveRecipeCost(recipe, prices)).toEqual([100, true]);
  });
});
