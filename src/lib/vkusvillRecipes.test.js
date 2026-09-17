import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./vkusvillMcp.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, searchRecipes: vi.fn(), resolvePrices: vi.fn(), searchProducts: vi.fn(), getProductAnalogs: vi.fn() };
});
vi.mock("./backend.js", () => ({ resolvePricesViaBackend: vi.fn() }));
import { searchRecipes, resolvePrices, searchProducts, getProductAnalogs } from "./vkusvillMcp.js";
import { resolvePricesViaBackend } from "./backend.js";
import {
  vkusvillIngredientToTriple,
  parseCookingTimeMinutes,
  nameViolatesAllergies,
  nameViolatesDiet,
  isWeightOrVolumeUnit,
  pricePerBaseUnit,
  resolveIngredientCost,
  searchRawRecipes,
  attachRealCosts,
  fetchVkusvillPools,
  getSubstituteOptions,
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

// Регрессия на жалобу "все равно не получаются цены" (уже после фикса
// "печень за 16₽"): рецепты ВкусВилл очень часто указывают овощи поштучно
// ("0.5 шт лука"), а тот же товар в каталоге продаётся на вес (кг) — без
// оценки по среднему весу такой ингредиент никогда не засчитывался
// совпадением, и у БОЛЬШИНСТВА рецептов не набиралось строгого большинства
// (см. attachRealCosts) — цена не показывалась вообще ни для чего, хотя
// сами цены на самом деле были найдены.
describe("resolveIngredientCost — оценка поштучных овощей/фруктов по среднему весу", () => {
  it("нет info -> null", () => {
    expect(resolveIngredientCost("Лук репчатый", 0.5, "шт", null)).toBeNull();
  });

  it("совпадающий род единиц (вес-вес) считается как раньше, без оценки", () => {
    expect(resolveIngredientCost("Свинина шея", 110, "г", { price: 795, productUnit: "кг" })).toBeCloseTo(0.795 * 110, 5);
  });

  it("рецепт поштучно, товар на вес, овощ из таблицы — оценивает по среднему весу", () => {
    // 0.5 шт лука ~= 50 г (100 г — средний вес одной луковицы), 58₽/кг = 0.058₽/г
    const cost = resolveIngredientCost("Лук репчатый", 0.5, "шт", { price: 58, productUnit: "кг" });
    expect(cost).toBeCloseTo(0.058 * 0.5 * 100, 5);
  });

  it("рецепт поштучно, товар на вес, но овощ НЕ из таблицы — не рискует, null", () => {
    expect(resolveIngredientCost("Экзотический корнеплод", 1, "шт", { price: 300, productUnit: "кг" })).toBeNull();
  });

  it("болгарский перец (не только 'сладкий') и куриное бедро — найдено на живом прогоне, добавлено в таблицу", () => {
    expect(resolveIngredientCost("Перец болгарский", 1, "шт", { price: 200, productUnit: "кг" })).toBeCloseTo(0.2 * 150, 5);
    expect(resolveIngredientCost("Куриное бедро", 1, "шт", { price: 250, productUnit: "кг" })).toBeCloseTo(0.25 * 160, 5);
  });

  it("обратный случай (рецепт в граммах, товар поштучно), вес упаковки НЕИЗВЕСТЕН — не оценивается", () => {
    // майонез 22.5 г, товар продаётся банкой ("шт"), и вес банки не удалось
    // распарсить из названия (packageAmount отсутствует) — размер банки
    // непредсказуем, рискованная оценка тут хуже честного "не знаем"
    expect(resolveIngredientCost("Майонез", 22.5, "г", { price: 118, productUnit: "шт" })).toBeNull();
  });
});

// Регрессия на живую жалобу "не удалось получить цены почти ни на один
// товар": прогнал вживую несколько сотен ингредиентов — priceByName
// резолвился на 100%, но цена блюда выставлялась только для ~7% рецептов.
// Причина: почти ВСЕ обычные товары ВкусВилл (крупы, фарш, сахар) продаются
// "поштучно" (unit: "шт" = 1 упаковка), а настоящий вес зашит только в
// название ("Фарш из индейки, 500 г") — это не редкий случай вроде майонеза
// в банке, а подавляющее большинство. См. parsePackageAmount в vkusvillMcp.js.
describe("resolveIngredientCost — товар 'шт' с известным весом упаковки (из названия)", () => {
  it("рецепт в граммах, товар 'шт' с packageAmount — считает цену за грамм из цены упаковки", () => {
    // Фарш из индейки, 500 г за 443₽ = 0.886₽/г; рецепту нужно 130 г
    const cost = resolveIngredientCost("Фарш из индейки", 130, "г", { price: 443, productUnit: "шт", packageAmount: 500, packageUnit: "г" });
    expect(cost).toBeCloseTo((443 / 500) * 130, 5);
  });

  it("рецепт в мл, товар 'шт' с packageAmount в мл", () => {
    const cost = resolveIngredientCost("Молоко", 200, "мл", { price: 90, productUnit: "шт", packageAmount: 900, packageUnit: "мл" });
    expect(cost).toBeCloseTo((90 / 900) * 200, 5);
  });

  it("рецепт поштучно ('шт'), товар тоже поштучно ('шт') — это уже совпадающий род единиц, считается обычной веткой, а не этой", () => {
    const cost = resolveIngredientCost("Яйцо", 2, "шт", { price: 8, productUnit: "шт" });
    expect(cost).toBe(16);
  });

  it("packageAmount отсутствует/0/null — не считается (то же поведение, что и раньше)", () => {
    expect(resolveIngredientCost("Фарш из индейки", 130, "г", { price: 443, productUnit: "шт" })).toBeNull();
    expect(resolveIngredientCost("Фарш из индейки", 130, "г", { price: 443, productUnit: "шт", packageAmount: 0, packageUnit: "г" })).toBeNull();
    expect(resolveIngredientCost("Фарш из индейки", 130, "г", { price: 443, productUnit: "шт", packageAmount: null, packageUnit: "г" })).toBeNull();
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

// Регрессия на прод-баг (жалоба в чате: "план на 15 000 ₽, а все блюда и
// итог по 0 ₽"): normalizeVkusvillRecipe раньше выставлял cost:0 ДО
// attachRealCosts — тот же 0, что и "цена честно посчитана и равна нулю".
// effectiveRecipeCost в data/recipes.js для ВкусВилл-рецептов ВСЕГДА
// доверяет recipe.cost как есть (isRealPrice не undefined), никогда не
// подставляя оценку взамен — блюдо с недостаточным совпадением ингредиентов
// выглядело БЕСПЛАТНЫМ, а не "цена неизвестна". Проверяем через настоящий
// fetchVkusvillPools (не через фикстуру attachRealCosts выше), потому что
// баг был именно в дефолте normalizeVkusvillRecipe, а не в самой
// attachRealCosts.
describe("fetchVkusvillPools — недостаточное совпадение ингредиентов даёт cost:null, не cost:0", () => {
  it("cost остаётся null (не 0), если ни один ингредиент не нашёлся в каталоге", async () => {
    searchRecipes.mockResolvedValue({
      items: [{
        id: 10, name: "Экзотическое блюдо", cooking_time: { name: "до 40 минут" }, steps: [],
        ingredients: [{ name: "Редкий ингредиент", quantity: "200 г" }],
        portions: 1,
      }],
    });
    resolvePrices.mockResolvedValue([{ matched: false, name: "Редкий ингредиент" }]);
    const { pools } = await fetchVkusvillPools({
      diet: "any", cuisines: [], devices: [], allergies: [], categories: ["main"], maxCookTime: null,
    });
    expect(pools.main[0].cost).toBeNull(); // не 0 — "неизвестно", а не "бесплатно"
    expect(pools.main[0].isRealPrice).toBe(false);
  });
});

// Серверный кэш цен (server/src/vkusvillPrices.js, POST /api/prices) —
// общий на всех пользователей, должен реже упираться в rate-limit ВкусВилл,
// чем клиентский in-memory кэш (per-браузер). attachRealCosts пробует его
// первым, direct-to-ВкусВилл (resolvePrices) — только откат, если бэкенда
// нет/не в Telegram/запрос не удался, поведение должно остаться ровно тем
// же, что было раньше.
describe("attachRealCosts — приоритет серверного кэша цен над прямыми запросами к ВкусВилл", () => {
  const mkPool = (ingr) => ({ breakfast: [], snack: [], main: [{ id: "vv-1", name: "Тест", cost: 0, isRealPrice: false, ingr }] });

  beforeEach(() => {
    resolvePricesViaBackend.mockReset();
    resolvePrices.mockReset();
  });

  it("серверный кэш ответил — resolvePrices (прямой запрос к ВкусВилл) вообще не зовётся", async () => {
    resolvePricesViaBackend.mockResolvedValue([{ matched: true, name: "Курица", price: 5, productUnit: "г" }]);
    const pools = mkPool([["Курица", 100, "г"]]);
    await attachRealCosts(pools);
    expect(pools.main[0].cost).toBe(500);
    expect(resolvePrices).not.toHaveBeenCalled();
  });

  it("серверный кэш недоступен (null) — откатывается на прямой запрос к ВкусВилл, результат тот же", async () => {
    resolvePricesViaBackend.mockResolvedValue(null);
    resolvePrices.mockResolvedValue([{ matched: true, name: "Курица", price: 5, productUnit: "г" }]);
    const pools = mkPool([["Курица", 100, "г"]]);
    await attachRealCosts(pools);
    expect(pools.main[0].cost).toBe(500);
    expect(resolvePrices).toHaveBeenCalledTimes(1);
  });

  it("серверный кэш не настроен вообще (мок без реализации, как в остальных тестах файла) — тоже откат, ничего не падает", async () => {
    resolvePrices.mockResolvedValue([{ matched: true, name: "Курица", price: 5, productUnit: "г" }]);
    const pools = mkPool([["Курица", 100, "г"]]);
    await attachRealCosts(pools);
    expect(pools.main[0].cost).toBe(500);
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

// Регрессия на живую жалобу "на замену моркови предлагает всё, кроме
// моркови": vkusvill_product_analogs — это не "то же самое, другой бренд",
// а весь овощной отдел рядом (проверено вживую: аналоги моркови — свёкла,
// лук, капуста и т.д., хотя "Морковь резаная"/"Морковь мытая" там ТОЖЕ
// есть). Раньше сортировка была только по цене — более дешёвые чужие овощи
// всплывали выше настоящей моркови.
describe("getSubstituteOptions — приоритет совпадений по названию над просто дешёвыми аналогами", () => {
  beforeEach(() => {
    searchProducts.mockReset();
    getProductAnalogs.mockReset();
    // decodeHtmlEntities (vkusvillRecipes.js) использует DOMParser — есть в
    // браузере, но не в тестовом окружении Node (environment: "node", без
    // jsdom, см. vitest.config.js). Минимальный стаб — этого достаточно,
    // названия в тестах ниже без реальных HTML-сущностей.
    vi.stubGlobal(
      "DOMParser",
      class {
        parseFromString(str) {
          return { documentElement: { textContent: str.replace(/&nbsp;/g, " ") } };
        }
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("аналоги с тем же корнем названия — первыми, даже если дороже", async () => {
    searchProducts.mockResolvedValue({ items: [{ xml_id: "606", name: "Морковь" }] });
    getProductAnalogs.mockResolvedValue({
      products: [
        { xml_id: "1", name: "Свёкла", price: { current: 58 }, unit: "кг" }, // дешевле, но другой овощ
        { xml_id: "2", name: "Морковь мытая, 600 г", price: { current: 110 }, unit: "шт" }, // дороже, но тот же продукт
        { xml_id: "3", name: "Капуста белокочанная", price: { current: 48 }, unit: "кг" },
      ],
    });
    const options = await getSubstituteOptions({ name: "Морковь", allergies: [], diet: "any" });
    expect(options[0].name).toBe("Морковь мытая, 600 г"); // настоящая морковь — первая, несмотря на цену
    expect(options.map((o) => o.name)).toContain("Свёкла");
    expect(options.map((o) => o.name)).toContain("Капуста белокочанная");
  });

  it("внутри каждой группы (тот же продукт / остальные аналоги) — сортировка по цене", async () => {
    searchProducts.mockResolvedValue({ items: [{ xml_id: "1", name: "Молоко" }] });
    getProductAnalogs.mockResolvedValue({
      products: [
        { xml_id: "2", name: "Молоко 3.2%", price: { current: 120 }, unit: "шт" },
        { xml_id: "3", name: "Молоко 2.5%", price: { current: 90 }, unit: "шт" },
        { xml_id: "4", name: "Кефир", price: { current: 70 }, unit: "шт" },
        { xml_id: "5", name: "Йогурт", price: { current: 60 }, unit: "шт" },
      ],
    });
    const options = await getSubstituteOptions({ name: "Молоко", allergies: [], diet: "any" });
    expect(options.map((o) => o.name)).toEqual(["Молоко 2.5%", "Молоко 3.2%", "Йогурт", "Кефир"]);
  });

  it("сам исходный товар (тот же xmlId) не попадает в список замен", async () => {
    searchProducts.mockResolvedValue({ items: [{ xml_id: "1", name: "Морковь" }] });
    getProductAnalogs.mockResolvedValue({ products: [{ xml_id: "1", name: "Морковь", price: { current: 58 }, unit: "кг" }] });
    const options = await getSubstituteOptions({ name: "Морковь", allergies: [], diet: "any" });
    expect(options).toHaveLength(0);
  });

  it("товар не найден в каталоге -> пустой список, не падает", async () => {
    searchProducts.mockResolvedValue({ items: [] });
    const options = await getSubstituteOptions({ name: "Неизвестный товар", allergies: [], diet: "any" });
    expect(options).toEqual([]);
    expect(getProductAnalogs).not.toHaveBeenCalled();
  });
});
