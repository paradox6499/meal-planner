import { describe, it, expect } from "vitest";
import {
  vkusvillIngredientToTriple,
  parseCookingTimeMinutes,
  nameViolatesAllergies,
  nameViolatesDiet,
  isWeightOrVolumeUnit,
  pricePerBaseUnit,
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
