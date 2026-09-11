import { describe, it, expect, vi } from "vitest";

vi.mock("./vkusvillMcp.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, searchRecipes: vi.fn() };
});
import { searchRecipes } from "./vkusvillMcp.js";
import {
  vkusvillIngredientToTriple,
  parseCookingTimeMinutes,
  nameViolatesAllergies,
  nameViolatesDiet,
  isWeightOrVolumeUnit,
  pricePerBaseUnit,
  searchRawRecipes,
} from "./vkusvillRecipes.js";

describe("vkusvillIngredientToTriple", () => {
  it("парсит целые и дробные количества с г/мл/кг/л/шт", () => {
    expect(vkusvillIngredientToTriple({ name: "Морковь", quantity: "400 г" })).toEqual(["Морковь", 400, "г"]);
    expect(vkusvillIngredientToTriple({ name: "Молоко", quantity: "0,5 л" })).toEqual(["Молоко", 500, "мл"]);
    expect(vkusvillIngredientToTriple({ name: "Мука", quantity: "1.5 кг" })).toEqual(["Мука", 1500, "г"]);
    expect(vkusvillIngredientToTriple({ name: "Яйцо", quantity: "2 шт" })).toEqual(["Яйцо", 2, "шт"]);
  });

  it("регрессия: 'г' после кириллической буквы находится (JS \\b/\\w — ASCII-only, ловил false negative)", () => {
    // Раньше паттерн с \b не матчил границу слова сразу после кириллицы —
    // этот кейс специально проверяет, что "400 г" не путается с "гречка" и т.п.
    expect(vkusvillIngredientToTriple({ name: "Гречка", quantity: "400 г" })).toEqual(["Гречка", 400, "г"]);
  });

  it("регрессия: '1 ст. л.' не матчит голую точку перед 'л' (раньше [\\d.,]+ был слишком жадным -> NaN)", () => {
    expect(vkusvillIngredientToTriple({ name: "Масло растительное", quantity: "1 ст. л." })).toBeNull();
  });

  it("возвращает null для неизмеримых количеств вместо NaN", () => {
    expect(vkusvillIngredientToTriple({ name: "Соль", quantity: "по вкусу" })).toBeNull();
    expect(vkusvillIngredientToTriple({ name: "Перец", quantity: "" })).toBeNull();
    expect(vkusvillIngredientToTriple({ name: "Специи" })).toBeNull(); // quantity вообще отсутствует
  });

  it("регистронезависимо к единице измерения", () => {
    expect(vkusvillIngredientToTriple({ name: "Вода", quantity: "200 МЛ" })).toEqual(["Вода", 200, "мл"]);
  });
});

describe("parseCookingTimeMinutes", () => {
  // Регистр важен: сравнение в самой функции — по .includes() со строчными
  // метками. Живой ответ MCP (проверено вживую, vkusvill_recipes) шлёт их
  // именно строчными ("до 40 минут", "1-2 часа") — тест использует тот же
  // регистр, а не Title Case, чтобы не проверять несуществующий кейс.
  it("маппит текстовые метки времени ВкусВилл (как они реально приходят) в минуты", () => {
    expect(parseCookingTimeMinutes("до 20 минут")).toBe(20);
    expect(parseCookingTimeMinutes("до 40 минут")).toBe(35);
    expect(parseCookingTimeMinutes("до 1 часа")).toBe(55);
    expect(parseCookingTimeMinutes("1-2 часа")).toBe(90);
    expect(parseCookingTimeMinutes("более 2 часов")).toBe(130);
  });

  it("незнакомая или отсутствующая метка -> разумный дефолт 30, не падает", () => {
    expect(parseCookingTimeMinutes(undefined)).toBe(30);
    expect(parseCookingTimeMinutes("что-то новое")).toBe(30);
  });
});

describe("nameViolatesAllergies / nameViolatesDiet (фильтр товаров-замен под 'Нет в наличии')", () => {
  it("находит запрещённый ингредиент по стему в названии товара", () => {
    expect(nameViolatesAllergies("Молоко 2,5% в бутылке", ["dairy"])).toBe(true);
    expect(nameViolatesAllergies("Морковь мытая", ["dairy"])).toBe(false);
  });

  it("пустой список аллергий ничего не запрещает", () => {
    expect(nameViolatesAllergies("Молоко", [])).toBe(false);
  });

  it("veg/vegan режут мясо-рыбные товары", () => {
    expect(nameViolatesDiet("Фарш из индейки", "veg")).toBe(true);
    expect(nameViolatesDiet("Кабачки", "veg")).toBe(false);
    expect(nameViolatesDiet("Масло сливочное", "vegan")).toBe(true);
    expect(nameViolatesDiet("Кабачки", "vegan")).toBe(false);
  });

  it("обычный/ПП/безглютеновый рацион не режет по составу товара (это не их зона ответственности здесь)", () => {
    expect(nameViolatesDiet("Фарш из индейки", "any")).toBe(false);
    expect(nameViolatesDiet("Фарш из индейки", "pp")).toBe(false);
    expect(nameViolatesDiet("Фарш из индейки", "gf")).toBe(false);
  });
});

describe("pricePerBaseUnit / isWeightOrVolumeUnit", () => {
  it("переводит цену за кг/л в цену за г/мл", () => {
    expect(pricePerBaseUnit(1000, "кг")).toBe(1);
    expect(pricePerBaseUnit(200, "л")).toBe(0.2);
  });

  it("цену за г/мл/шт оставляет как есть", () => {
    expect(pricePerBaseUnit(55, "г")).toBe(55);
    expect(pricePerBaseUnit(10, "шт")).toBe(10);
  });

  it("различает вес/объём и штучные единицы", () => {
    expect(isWeightOrVolumeUnit("г")).toBe(true);
    expect(isWeightOrVolumeUnit("мл")).toBe(true);
    expect(isWeightOrVolumeUnit("кг")).toBe(true);
    expect(isWeightOrVolumeUnit("л")).toBe(true);
    expect(isWeightOrVolumeUnit("шт")).toBe(false);
  });
});

// Реальный ВкусВилл принимает только ОДИН id_cooking_time_filter за раз (не
// массив — проверено вживую, сервер отвечает ошибкой валидации), а бакет
// "до 40 минут" — это буквально 21-40 минут, не "0-40". Чтобы честно закрыть
// "до 40 минут" целиком, searchRawRecipes на этом уровне делает ДВА запроса
// (оба бакета) и объединяет — это и тестируется здесь на мокнутом searchRecipes.
// Плюс, отдельно от бакетов времени, каждый бакет теперь сам берёт 2
// страницы (RECIPE_SEARCH_PAGES) — жалоба в чате на повторяющиеся блюда:
// одной страницы часто не хватало на разнообразие недели.
describe("searchRawRecipes — бюджет времени готовки", () => {
  const baseArgs = { q: "", categoryId: 332, cookingMethod: 0, excludeAllergens: [] };

  it("без maxCookTime — две страницы одного запроса без фильтра времени (без дублей по id)", async () => {
    searchRecipes.mockResolvedValue({ items: [{ id: 1 }] });
    const items = await searchRawRecipes(baseArgs);
    expect(searchRecipes).toHaveBeenCalledTimes(2); // страница 1 и страница 2
    expect(searchRecipes).toHaveBeenCalledWith(expect.objectContaining({ id_cooking_time_filter: 0, page: 1 }));
    expect(searchRecipes).toHaveBeenCalledWith(expect.objectContaining({ id_cooking_time_filter: 0, page: 2 }));
    expect(items).toEqual([{ id: 1 }]); // обе страницы вернули один и тот же id=1 в моке — задвоения нет
  });

  it("maxCookTime=20 — две страницы на единственный бакет 'до 20 минут'", async () => {
    searchRecipes.mockResolvedValue({ items: [{ id: 1 }] });
    await searchRawRecipes({ ...baseArgs, maxCookTime: 20 });
    expect(searchRecipes).toHaveBeenCalledTimes(2);
    expect(searchRecipes).toHaveBeenCalledWith(expect.objectContaining({ id_cooking_time_filter: 397967 }));
  });

  it("maxCookTime=40 — оба бакета по 2 страницы каждый (4 запроса), результат объединён и без дублей по id", async () => {
    searchRecipes.mockImplementation(({ id_cooking_time_filter }) =>
      Promise.resolve({
        items: id_cooking_time_filter === 397967 ? [{ id: 1 }, { id: 2 }] : [{ id: 2 }, { id: 3 }], // id=2 встречается в обоих — не должен задвоиться
      })
    );
    const items = await searchRawRecipes({ ...baseArgs, maxCookTime: 40 });
    expect(searchRecipes).toHaveBeenCalledTimes(4);
    expect(items.map((r) => r.id).sort()).toEqual([1, 2, 3]);
  });

  it("сбой одного из двух запросов бакета 40 минут не роняет весь результат — берём то, что получилось", async () => {
    searchRecipes.mockImplementation(({ id_cooking_time_filter }) =>
      id_cooking_time_filter === 397967 ? Promise.resolve({ items: [{ id: 1 }] }) : Promise.reject(new Error("boom"))
    );
    const items = await searchRawRecipes({ ...baseArgs, maxCookTime: 40 });
    expect(items).toEqual([{ id: 1 }]);
  });
});
