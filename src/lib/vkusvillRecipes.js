// Подбор рецептов из официального MCP ВкусВилл вместо статических 41 из
// data/recipes.js — вторая (и основная) часть интеграции, см.
// docs/telegram-bot-architecture.md и обсуждение оценки в чате.
//
// Стратегия сопоставления наших вопросов визарда с фильтрами ВкусВилл:
//   - тип приёма пищи -> id_category_filter (у них СВОЯ таксономия, не 1:1
//     с нашей breakfast/main/snack — берём ближайшее: "На завтрак"/"Горячее"/"Закуски")
//   - техника готовки -> id_cooking_method_filter (у них ОДНО значение за раз,
//     не список — берём первое совпадение из выбранных пользователем)
//   - аллергии (+ "без глютена" из рациона) -> id_exclude_allergens_filter,
//     ПЛЮС свой пост-фильтр по тексту состава как подстраховка (у ВкусВилл
//     нет фасета для сои/рыбы, а для остального их разметка могла не
//     покрыть редкий случай — лучше пропустить рецепт, чем показать его)
//   - кухня -> у них нет такого фасета вообще; мягкая подсказка через
//     текст поиска q, не жёсткий фильтр
//   - вег/веган -> тоже нет отдельного фасета для ЭТОГО запроса (только
//     категория "Вегетарианцам"/"Веганам", а категория у нас уже занята
//     типом приёма пищи) — пост-фильтр по составу
//
// ID таксономии зафиксированы вручную по факту живого ответа сервера на
// 08.09.2026 (searchRecipes({page:1}) -> meta.filters). Если результаты
// вдруг перестанут иметь смысл — стоит перепроверить эти ID тем же вызовом,
// они не гарантированно вечны.

import { searchRecipes, resolvePrices, searchProducts, getProductAnalogs } from "./vkusvillMcp.js";

const CATEGORY_BY_MEAL = { breakfast: 339, main: 332, snack: 335 };

// "В духовке или на гриле" — одна категория на oven И grill в их таксономии,
// отдельного "аэрогриль" тоже нет, ближайшее — то же самое.
const COOKING_METHOD_BY_DEVICE = {
  multi: 305757,
  stove: 305758,
  oven: 305759,
  grill: 305759,
  air: 305759,
  blender: 305762, // "Без термообработки" — ближайшее для смузи и т.п.
};

const ALLERGEN_EXCLUDE_ID = {
  nuts: 305746,
  gluten: 305747,
  dairy: 305748, // у них "Лактоза", не точно то же самое, что "молочное" — ближайшее
  eggs: 305751,
  // soy, fish — прямого фасета нет, полагаемся только на текстовый пост-фильтр
};

const CUISINE_HINT = { it: "итальянская", asia: "азиатская", cauc: "кавказская", med: "средиземноморская" };

// "Время готовки" — у ВкусВилл ОДИН бакет за запрос, не диапазон (проверено
// вживую: массив в id_cooking_time_filter не принимается, только integer,
// сервер отвечает ошибкой валидации). Бакет "до 40 минут" — это буквально
// 21-40 минут, а не "0-40": рецепты короче 20 минут туда не попадают
// (тоже проверено — id 397967 "до 20 минут" отдельно от 305736 "до 40 минут").
// Чтобы честно закрыть уровень "до 40 минут" целиком (а не только 21-40),
// на этом уровне делаем два запроса (оба бакета) и объединяем по id.
const COOKING_TIME_BUCKET_IDS = { 20: [397967], 40: [397967, 305736] };

const ALLERGEN_KEYWORDS = {
  nuts: ["орех", "миндал", "фундук", "кешью", "фисташ", "арахис"],
  dairy: ["молок", "сыр", "сливк", "сметан", "творог", "йогурт", "масло сливочн"],
  gluten: ["мук", "хлеб", "макарон", "паст", "тесто", "лапш"],
  eggs: ["яйц", "яич"],
  soy: ["соев", "тофу", "мисо"],
  fish: ["рыб", "лосос", "треск", "форел", "тунец", "креветк", "морепродукт"],
};

const MEAT_FISH_KEYWORDS = ["куриц", "куриног", "говядин", "свинин", "бекон", "баранин", "индейк", "рыб", "лосос", "треск", "креветк", "морепродукт", "фарш"];
const VEGAN_FORBIDDEN_KEYWORDS = [...MEAT_FISH_KEYWORDS, "молок", "сыр", "сливк", "сметан", "творог", "йогурт", "яйц", "мёд", "масло сливочн"];

export function parseCookingTimeMinutes(name) {
  if (!name) return 30;
  if (name.includes("до 20")) return 20;
  if (name.includes("до 40")) return 35;
  if (name.includes("до 1 часа")) return 55;
  if (name.includes("1-2 часа")) return 90;
  if (name.includes("более 2")) return 130;
  return 30;
}

// "450 г" -> ["Тесто слоёное дрож.", 450, "г"]; "по вкусу" -> null (не
// включаем в список покупок то, что нельзя осмысленно докупить в граммах).
export function vkusvillIngredientToTriple(ingredient) {
  // \b здесь бы не сработал: в JS \b/\w по умолчанию понимают только ASCII,
  // граница после кириллической буквы не определяется как ожидается — ловил
  // false negative даже на "400 г". Вместо этого — negative lookahead на
  // кириллицу. И [\d.,]+ был слишком жадным: "1 ст. л." матчил одну точку
  // перед "л" без единственной цифры (amount становился NaN) — теперь
  // паттерн требует хотя бы одну цифру в начале.
  const match = String(ingredient.quantity || "").match(/(\d+(?:[.,]\d+)?)\s*(кг|мл|г|л|шт)(?![а-яёА-ЯЁ])/i);
  if (!match) return null;
  let amount = parseFloat(match[1].replace(",", "."));
  let unit = match[2].toLowerCase();
  if (unit === "кг") { amount *= 1000; unit = "г"; }
  if (unit === "л") { amount *= 1000; unit = "мл"; }
  return [ingredient.name, amount, unit];
}

function normalizeVkusvillRecipe(raw, category) {
  const ingr = (raw.ingredients || []).map(vkusvillIngredientToTriple).filter(Boolean);
  return {
    id: `vv-${raw.id}`,
    name: raw.name,
    cuisine: "any", // фильтруется мягко через q при запросе, не через это поле
    diets: ["any"], // фактическая проверка — в recipeViolatesDiet ниже, по составу
    devices: [],
    category,
    cost: 0,
    isRealPrice: false, // проставит attachRealCosts, если получится посчитать
    time: parseCookingTimeMinutes(raw.cooking_time?.name),
    emoji: "🍽️",
    photoUrl: raw.image || null,
    sourceUrl: raw.url,
    ingr,
    steps: (raw.steps || []).map((s) => s.text).filter(Boolean),
  };
}

function recipeHasKeyword(recipe, keywords) {
  if (keywords.length === 0) return false;
  return recipe.ingr.some(([name]) => {
    const lower = name.toLowerCase();
    return keywords.some((kw) => lower.includes(kw));
  });
}

function recipeViolatesAllergies(recipe, allergyIds) {
  return recipeHasKeyword(recipe, allergyIds.flatMap((id) => ALLERGEN_KEYWORDS[id] || []));
}

function recipeViolatesDiet(recipe, diet) {
  if (diet === "veg") return recipeHasKeyword(recipe, MEAT_FISH_KEYWORDS);
  if (diet === "vegan") return recipeHasKeyword(recipe, VEGAN_FORBIDDEN_KEYWORDS);
  return false;
}

// Те же самые проверки (recipeHasKeyword/…Allergies/…Diet выше), но для
// голого названия товара, а не объекта рецепта с .ingr — нужны для замены
// "нет в наличии" (getSubstituteOptions ниже): аналог с полки ВкусВилл это
// просто {name}, а не рецепт с составом.
function nameHasKeyword(name, keywords) {
  if (keywords.length === 0) return false;
  const lower = name.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}
export function nameViolatesAllergies(name, allergyIds) {
  return nameHasKeyword(name, allergyIds.flatMap((id) => ALLERGEN_KEYWORDS[id] || []));
}
export function nameViolatesDiet(name, diet) {
  if (diet === "veg") return nameHasKeyword(name, MEAT_FISH_KEYWORDS);
  if (diet === "vegan") return nameHasKeyword(name, VEGAN_FORBIDDEN_KEYWORDS);
  return false;
}

// ВкусВилл отдаёт названия с HTML-сущностями (например "900&nbsp;мл") —
// DOMParser здесь безопасен и уместен: мы всегда в браузере (это клиентский
// модуль), а не строим DOM из чужого HTML для показа как есть, только читаем
// обратно текстовое содержимое.
function decodeHtmlEntities(str) {
  return new DOMParser().parseFromString(str, "text/html").documentElement.textContent;
}

// export — App.jsx (buildPlanView) считает по ним итемизированную стоимость
// каждой позиции списка покупок отдельно, тем же способом, каким здесь
// считается стоимость рецепта — единая логика, не два разных пути расчёта.
export function isWeightOrVolumeUnit(unit) {
  return unit === "г" || unit === "мл" || unit === "кг" || unit === "л";
}

export function pricePerBaseUnit(price, productUnit) {
  // цена товара за кг/л -> цена за грамм/мл (наши recipe.ingr всегда в г/мл/шт)
  if (productUnit === "кг" || productUnit === "л") return price / 1000;
  return price; // уже за г/мл/шт — как есть
}

// Один параллельный проход по ВСЕМ уникальным ингредиентам сразу по всем
// пулам (не по каждому рецепту отдельно) — иначе "яйцо"/"соль" искались бы
// в каталоге по многу раз впустую. Мутирует recipe.cost/isRealPrice на месте
// (нужно для цены рядом с каждым блюдом) И возвращает саму карту name->цена
// товара — она же нужна снаружи (App.jsx/buildPlanView), чтобы посчитать
// итемизированную стоимость списка покупок ТЕМИ ЖЕ цифрами, а не запрашивать
// каталог второй раз ради того, что уже знаем.
// export — App.jsx зовёт это напрямую повторно как "Повторить получение
// цен" (см. ResultView), не пересобирая весь план заново: пулы рецептов уже
// есть, нужно только ещё раз попробовать получить цены на них.
export async function attachRealCosts(pools) {
  const allNames = new Set();
  Object.values(pools).forEach((recipes) => recipes.forEach((r) => r.ingr.forEach(([name]) => allNames.add(name))));
  const priceByName = new Map();
  if (allNames.size === 0) return priceByName;

  const resolved = await resolvePrices([...allNames].map((name) => ({ name, amount: 1, unit: "шт" })));
  resolved.forEach((r) => {
    if (r.matched && r.price != null) priceByName.set(r.name, { price: r.price, productUnit: r.productUnit });
  });

  Object.values(pools).forEach((recipes) => {
    recipes.forEach((recipe) => {
      if (recipe.ingr.length === 0) return;
      let total = 0;
      let allMatched = true;
      for (const [name, amount, unit] of recipe.ingr) {
        const info = priceByName.get(name);
        // единица нашего ингредиента и товара должны быть одного "рода"
        // (вес/объём vs штучно) — иначе почти наверняка посчитаем неверно,
        // лучше отказаться от точной цены для этого рецепта, чем соврать
        if (!info || isWeightOrVolumeUnit(unit) !== isWeightOrVolumeUnit(info.productUnit)) {
          allMatched = false;
          continue;
        }
        total += pricePerBaseUnit(info.price, info.productUnit) * amount;
      }
      if (total > 0) {
        recipe.cost = Math.round(total);
        recipe.isRealPrice = allMatched;
      }
    });
  });

  return priceByName;
}

/** Тянет пулы рецептов из VkusVill под текущие фильтры визарда — по форме
 * результата совместимо с buildPools() из App.jsx ({breakfast, main, snack}),
 * так что дальше по коду (buildInitialPlan, buildPlanView, swap) ничего
 * менять не нужно, они не знают, откуда взялись рецепты.
 *
 * `categories` — только те категории, что реально нужны (из выбранных
 * приёмов пищи) — не тратим вызовы на то, что пользователь не спрашивал. */
// Раньше брали только страницу 1 — для многих сочетаний фильтров (узкая
// кухня + диета + аллергии) это оставляло буквально несколько рецептов на
// категорию, и при 14 приёмах пищи в неделю (2×7) блюда неизбежно
// повторялись — жалоба в чате "иногда попадаются одинаковые блюда изо дня в
// день". Вторая страница примерно удваивает пул почти без доп. цены по
// времени (один лишний параллельный запрос) — и это ДРУГОЙ инструмент MCP
// (vkusvill_recipes, не vkusvill_products_search), который спрашивается
// всего пару раз за сборку плана, так что риска для burst-лимита цен
// (см. vkusvillMcp.js) это не добавляет.
const RECIPE_SEARCH_PAGES = [1, 2];

// Один "сырой" поиск рецептов под заданный бюджет времени — либо один-два
// запроса (по числу страниц выше) без фильтра времени (maxCookTime не
// задан), либо на бакет (20 минут), либо на оба бакета (40 минут, см.
// комментарий у COOKING_TIME_BUCKET_IDS), с сохранением дедупликации по id.
// Ошибка отдельного под-запроса не должна обрушивать всю категорию —
// считаем её как "ничего не нашли на этой странице/бакете".
export async function searchRawRecipes({ q, categoryId, cookingMethod, excludeAllergens, maxCookTime }) {
  const bucketIds = maxCookTime ? COOKING_TIME_BUCKET_IDS[maxCookTime] : null;
  const fetchBucket = async (timeId) => {
    const pages = await Promise.all(
      RECIPE_SEARCH_PAGES.map((page) =>
        searchRecipes({
          q, page, sort: "popularity",
          id_category_filter: categoryId, id_cooking_method_filter: cookingMethod,
          id_cooking_time_filter: timeId, id_exclude_allergens_filter: excludeAllergens,
        })
          .then((d) => d.items || [])
          .catch(() => [])
      )
    );
    // На случай, если у ВкусВилл страницы 1 и 2 когда-нибудь пересекутся
    // (короткий хвостовой список, дубли на границе страницы) — дедуп по id
    // тут же, а не только на уровне бакетов ниже.
    const seenInBucket = new Set();
    return pages.flat().filter((r) => (seenInBucket.has(r.id) ? false : (seenInBucket.add(r.id), true)));
  };

  if (!bucketIds) return fetchBucket(0);
  const results = await Promise.all(bucketIds.map(fetchBucket));
  const seen = new Set();
  return results.flat().filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** maxCookTime — 20 | 40 | null ("не важно", как раньше). Мягкое
 * предпочтение, как кухня/техника: если с ним категория опустела, повторяем
 * запрос без ограничения времени — лучше показать план с рецептом подольше,
 * чем оставить приём пищи вообще без рецепта. */
export async function fetchVkusvillPools({ diet, cuisines, devices, allergies, categories, maxCookTime }) {
  const effectiveAllergies = diet === "gf" && !allergies.includes("gluten") ? [...allergies, "gluten"] : allergies;
  const excludeAllergens = [...new Set(effectiveAllergies.map((a) => ALLERGEN_EXCLUDE_ID[a]).filter(Boolean))];
  const cookingMethod = devices.map((d) => COOKING_METHOD_BY_DEVICE[d]).find(Boolean) || 0;
  const specificCuisines = cuisines.filter((c) => c !== "any");
  const q = specificCuisines.length === 1 ? CUISINE_HINT[specificCuisines[0]] || "" : "";

  const normalizeAndFilter = (raw, category) =>
    raw
      .map((r) => normalizeVkusvillRecipe(r, category))
      .filter((r) => r.ingr.length > 0 && !recipeViolatesDiet(r, diet) && !recipeViolatesAllergies(r, effectiveAllergies));

  const pools = {};
  await Promise.all(
    categories.map(async (category) => {
      const categoryId = CATEGORY_BY_MEAL[category] || 0;
      try {
        const raw = await searchRawRecipes({ q, categoryId, cookingMethod, excludeAllergens, maxCookTime });
        let normalized = normalizeAndFilter(raw, category);
        if (normalized.length === 0 && maxCookTime) {
          // смягчаем время готовки, если из-за него пул опустел — та же
          // логика, что у buildPools() для кухни/техники в data/recipes.js
          const rawUnrestricted = await searchRawRecipes({ q, categoryId, cookingMethod, excludeAllergens, maxCookTime: null });
          normalized = normalizeAndFilter(rawUnrestricted, category);
        }
        pools[category] = normalized;
      } catch {
        pools[category] = [];
      }
    })
  );

  const priceByName = await attachRealCosts(pools);
  // buildInitialPlan (App.jsx) жадно ищет самый дорогой рецепт, который ещё
  // укладывается в допустимый бюджет — для этого пул должен быть
  // отсортирован по возрастанию цены, как и статические RECIPES в
  // buildPools(). Тут цены появляются только что (после attachRealCosts),
  // поэтому сортируем здесь, а не раньше.
  Object.values(pools).forEach((recipes) => recipes.sort((a, b) => a.cost - b.cost));
  // priceByName наружу — App.jsx/buildPlanView считает по ней итемизированную
  // стоимость КАЖДОЙ позиции списка покупок (не только суммарную стоимость
  // рецепта), это и даёт "Итого за продукты", которое честно меняется при
  // замене товара через "Нет в наличии".
  return { pools, priceByName };
}

/** "Нет в наличии" в списке покупок (ResultView) — предлагает замену
 * конкретному товару. Сначала ищем сам товар в каталоге (то же, что делает
 * resolvePrices при сборке корзины) — аналоги запрашиваются именно под
 * найденный id, а не под текст рецепта. `vkusvill_product_analogs` — штатный
 * инструмент MCP ровно под этот сценарий ("похожие товары"), не наш
 * самодельный подбор по названию.
 *
 * Возвращает до 6 вариантов, отсортированных по цене (дешёвые впереди —
 * осмысленный выбор по умолчанию, раз уж всё равно нужно докупать), уже
 * прошедших те же проверки на аллергию/рацион, что и обычные рецепты — без
 * этого "замена" могла бы тихо подсунуть что-то запрещённое. */
export async function getSubstituteOptions({ name, allergies, diet }) {
  const search = await searchProducts({ q: name, mode: "short", vvonly: 0 });
  const original = search.items?.[0];
  if (!original) return [];

  const analogs = await getProductAnalogs(original.xml_id);
  const effectiveAllergies = diet === "gf" && !allergies.includes("gluten") ? [...allergies, "gluten"] : allergies;

  return (analogs.products || [])
    .map((p) => ({
      xmlId: p.xml_id,
      name: decodeHtmlEntities(p.name || ""),
      price: p.price?.current ?? null,
      productUnit: p.unit,
      image: p.images?.[0]?.small || null,
    }))
    .filter((p) => p.price != null && p.xmlId !== original.xml_id)
    .filter((p) => !nameViolatesAllergies(p.name, effectiveAllergies) && !nameViolatesDiet(p.name, diet))
    .sort((a, b) => a.price - b.price)
    .slice(0, 6);
}
