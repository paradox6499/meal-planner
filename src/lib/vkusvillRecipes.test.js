import { describe, it, expect, vi } from "vitest";

vi.mock("./vkusvillMcp.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, searchRecipes: vi.fn(), resolvePrices: vi.fn() };
});
import { searchRecipes, resolvePrices } from "./vkusvillMcp.js";
import {
  vkusvillIngredientToTriple,
  parseCookingTimeMinutes,
  nameViolatesAllergies,
  nameViolatesDiet,
  isWeightOrVolumeUnit,
  pricePerBaseUnit,
  searchRawRecipes,
  attachRealCosts,
  fetchVkusvillPools,
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

  it("регрессия: '1 ст. л.' не путается с целым литром (раньше [\\d.,]+ был слишком жадным -> NaN, или того хуже — 'л')", () => {
    const result = vkusvillIngredientToTriple({ name: "Масло растительное", quantity: "1 ст. л." });
    expect(result[2]).not.toBe("л");
    expect(Number.isNaN(result[1])).toBe(false);
  });

  // Регрессия на жалобу в чате: "блюдо стоит 116 ₽, но все его ингредиенты
  // явно не могут столько стоить" — причина была именно здесь: ложки,
  // зубчики и щепотки раньше возвращали null и полностью выпадали из
  // расчёта цены и из списка покупок, а не только "по вкусу" (у которого
  // действительно нет осмысленного числа).
  it("переводит столовые/чайные ложки и зубчики в граммы вместо null", () => {
    expect(vkusvillIngredientToTriple({ name: "Масло растительное", quantity: "1 ст. л." })).toEqual(["Масло растительное", 15, "г"]);
    expect(vkusvillIngredientToTriple({ name: "Сахар", quantity: "2 ст.л." })).toEqual(["Сахар", 30, "г"]);
    expect(vkusvillIngredientToTriple({ name: "Соль", quantity: "1 ч. л." })).toEqual(["Соль", 5, "г"]);
    expect(vkusvillIngredientToTriple({ name: "Уксус", quantity: "0.5 чайной ложки" })).toEqual(["Уксус", 2.5, "г"]);
    expect(vkusvillIngredientToTriple({ name: "Чеснок", quantity: "2 зубчика" })).toEqual(["Чеснок", 10, "г"]);
  });

  it("переводит щепотку в 1 г вместо null", () => {
    expect(vkusvillIngredientToTriple({ name: "Соль", quantity: "щепотка" })).toEqual(["Соль", 1, "г"]);
    expect(vkusvillIngredientToTriple({ name: "Перец", quantity: "щепотку" })).toEqual(["Перец", 1, "г"]);
  });

  it("возвращает null только для действительно неизмеримых количеств", () => {
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

// Регрессия на жалобу в чате: "куриная печень с черносливом за 16 ₽" — этому
// блюду выставлялась цена, даже когда нашёлся только один (дешёвый)
// ингредиент из нескольких, а самый дорогой молча выпадал из суммы.
describe("attachRealCosts — цена блюда не выставляется по частичному совпадению ингредиентов", () => {
  const mkPool = (ingr) => ({
    breakfast: [], snack: [],
    main: [{ id: "vv-1", name: "Куриная печень с черносливом", cost: 0, isRealPrice: false, ingr }],
  });

  it("не выставляет цену блюда, если совпал только дешёвый ингредиент из двух (печень не нашлась)", async () => {
    resolvePrices.mockResolvedValue([
      { matched: false, name: "Куриная печень" },
      { matched: true, name: "Чернослив", price: 2, productUnit: "г" },
    ]);
    const pools = mkPool([["Куриная печень", 400, "г"], ["Чернослив", 30, "г"]]);
    await attachRealCosts(pools);
    const recipe = pools.main[0];
    expect(recipe.cost).toBe(0); // не выставлена по одному дешёвому совпадению
    expect(recipe.isRealPrice).toBe(false);
  });

  it("выставляет цену, если совпало большинство ингредиентов (строго больше половины)", async () => {
    resolvePrices.mockResolvedValue([
      { matched: true, name: "Куриная печень", price: 3, productUnit: "г" },
      { matched: true, name: "Чернослив", price: 2, productUnit: "г" },
    ]);
    const pools = mkPool([["Куриная печень", 400, "г"], ["Чернослив", 30, "г"]]);
    await attachRealCosts(pools);
    const recipe = pools.main[0];
    expect(recipe.cost).toBe(400 * 3 + 30 * 2); // 1260
    expect(recipe.isRealPrice).toBe(true); // совпали оба — можно доверять полностью
  });

  it("3 ингредиента, совпали 2 из 3 — цена выставляется, но isRealPrice=false (не всё совпало)", async () => {
    resolvePrices.mockResolvedValue([
      { matched: true, name: "Печень", price: 3, productUnit: "г" },
      { matched: true, name: "Чернослив", price: 2, productUnit: "г" },
      { matched: false, name: "Лук" },
    ]);
    const pools = mkPool([["Печень", 400, "г"], ["Чернослив", 30, "г"], ["Лук", 50, "г"]]);
    await attachRealCosts(pools);
    const recipe = pools.main[0];
    expect(recipe.cost).toBe(400 * 3 + 30 * 2);
    expect(recipe.isRealPrice).toBe(false);
  });

  it("3 ингредиента, совпал только 1 из 3 — цена не выставляется", async () => {
    resolvePrices.mockResolvedValue([
      { matched: false, name: "Печень" },
      { matched: true, name: "Чернослив", price: 2, productUnit: "г" },
      { matched: false, name: "Лук" },
    ]);
    const pools = mkPool([["Печень", 400, "г"], ["Чернослив", 30, "г"], ["Лук", 50, "г"]]);
    await attachRealCosts(pools);
    expect(pools.main[0].cost).toBe(0);
  });

  it("несовпадение рода единиц (вес/объём vs штучно) не считается совпадением", async () => {
    resolvePrices.mockResolvedValue([
      { matched: true, name: "Печень", price: 3, productUnit: "г" },
      { matched: true, name: "Яйцо", price: 8, productUnit: "шт" }, // товар штучный, а в рецепте — граммы
    ]);
    const pools = mkPool([["Печень", 400, "г"], ["Яйцо", 100, "г"]]);
    await attachRealCosts(pools);
    // Яйцо не засчиталось (разный род единиц) — совпал только 1 из 2, не строго больше половины
    expect(pools.main[0].cost).toBe(0);
  });
});

// Найдено при разборе этого же аудита (не из жалобы в чате): ВкусВилл отдаёт
// состав рецепта НА ВСЕ raw.portions порций, а не на 1 человека — живой
// вызов vkusvill_recipes подтвердил (id 5799226 "Итальянские фрикадельки из
// индейки", portions:6, "Фарш из индейки 500 г" — то есть ~83 г на едока, не
// 500 г). Весь остальной код (data/recipes.js, planLogic.js:buildPlanView)
// считает recipe.ingr величиной "на 1 человека" — без деления на portions
// здесь каждый рецепт с portions>1 (подавляющее большинство живых данных)
// получал бы цену и позиции списка покупок, завышенные ровно в portions раз.
describe("fetchVkusvillPools — количество ингредиентов делится на portions рецепта", () => {
  const rawRecipe = (overrides) => ({
    id: 1, name: "Тест", cooking_time: { name: "до 40 минут" }, steps: [],
    ingredients: [{ name: "Фарш из индейки", quantity: "500 г" }],
    portions: 6,
    ...overrides,
  });

  it("делит количество ингредиента на portions (500 г / 6 порций = ~83.3 г на человека)", async () => {
    searchRecipes.mockResolvedValue({ items: [rawRecipe()] });
    resolvePrices.mockResolvedValue([]);
    const { pools } = await fetchVkusvillPools({
      diet: "any", cuisines: [], devices: [], allergies: [], categories: ["main"], maxCookTime: null,
    });
    expect(pools.main).toHaveLength(1);
    const [name, amount, unit] = pools.main[0].ingr[0];
    expect(name).toBe("Фарш из индейки");
    expect(amount).toBeCloseTo(500 / 6, 5);
    expect(unit).toBe("г");
  });

  it("portions отсутствует или 0 -> считаем как 1 порцию (количество не делится)", async () => {
    searchRecipes.mockResolvedValue({ items: [rawRecipe({ portions: 0, id: 2 })] });
    resolvePrices.mockResolvedValue([]);
    const { pools } = await fetchVkusvillPools({
      diet: "any", cuisines: [], devices: [], allergies: [], categories: ["main"], maxCookTime: null,
    });
    expect(pools.main[0].ingr[0][1]).toBe(500);
  });

  it("итоговая цена блюда — за 1 порцию, а не за все portions сразу", async () => {
    searchRecipes.mockResolvedValue({ items: [rawRecipe({ id: 3 })] }); // 500 г / 6 порций
    resolvePrices.mockResolvedValue([{ matched: true, name: "Фарш из индейки", price: 0.6, productUnit: "г" }]);
    const { pools } = await fetchVkusvillPools({
      diet: "any", cuisines: [], devices: [], allergies: [], categories: ["main"], maxCookTime: null,
    });
    // Правильно: (500/6) г * 0.6 ₽/г = 50 ₽ на человека.
    // Баг (без деления на portions) посчитал бы 500 * 0.6 = 300 ₽ — в 6 раз больше.
    expect(pools.main[0].cost).toBe(50);
  });
});

// Найдено при этом же аудите: ВкусВилл принимает только ОДИН
// id_cooking_method_filter за запрос. При 2+ выбранных устройствах раньше
// брался "первый попавшийся" (порядок выбора пользователя), а остальные
// молча отбрасывались — включая кейс кнопки "Готовлю на всём" (все 7
// устройств сразу), где "первым" оказывается Плита: кнопка, которая должна
// СНИМАТЬ ограничение по технике, вместо этого сужала ВкусВилл до плиты.
describe("fetchVkusvillPools — id_cooking_method_filter при нескольких выбранных устройствах", () => {
  const call = async (devices) => {
    searchRecipes.mockResolvedValue({ items: [] });
    resolvePrices.mockResolvedValue([]);
    await fetchVkusvillPools({ diet: "any", cuisines: [], devices, allergies: [], categories: ["main"], maxCookTime: null });
    return searchRecipes.mock.calls[0][0].id_cooking_method_filter;
  };

  it("одно устройство — фильтр применяется как раньше", async () => {
    expect(await call(["stove"])).toBe(305758); // id ВкусВилл для "Плита"
  });

  it("несколько устройств с ОДИНАКОВЫМ способом готовки ВкусВилл — фильтр применяется", async () => {
    // grill и air у ВкусВилл — один и тот же способ ("В духовке или на гриле")
    expect(await call(["grill", "air"])).toBe(305759);
  });

  it("несколько устройств с РАЗНЫМИ способами готовки — фильтр не применяется (0), а не 'первое попавшееся'", async () => {
    expect(await call(["grill", "stove"])).toBe(0);
  });

  it("регрессия 'Готовлю на всём': выбраны ВСЕ устройства — фильтр снят полностью, а не сведён к плите", async () => {
    expect(await call(["stove", "oven", "micro", "multi", "air", "grill", "blender"])).toBe(0);
  });

  it("устройства не выбраны — фильтр не применяется (как и раньше)", async () => {
    expect(await call([])).toBe(0);
  });
});
