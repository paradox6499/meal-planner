// Фоновый подогрев каталога ВкусВилл — чтобы новому пользователю не приходилось
// ждать холодных запросов (у ВкусВилла 60 запросов в минуту на IP, а у нас IP
// один: сотня холодных запросов одной сборки плана — это две минуты ожидания).
//
// ЧТО ПОДОГРЕВАЕМ. Не "угадываем" цены и ассортимент — они меняются, и
// предсказать это нельзя. Вместо этого держим свежим то, о чём пользователи
// спрашивают чаще всего, и обновляем это по расписанию, до конца срока жизни
// записи:
//   1. страницы рецептов самых частых сочетаний фильтров (спрос копится в
//      warm_targets, плюс несколько "базовых" страниц на случай пустой базы);
//   2. цены на ингредиенты этих рецептов — названия берём прямо из кэшированных
//      страниц, тем же текстом, каким их потом спросит приложение.
// Срок годности: страницы рецептов — 6 часов (обновляем после 4), цены — 12 часов
// (обновляем после 8). Пользователь застаёт данные не старше нескольких часов.
//
// ЧЕСТНОСТЬ ЦЕН. Цена в плане — "на момент сборки"; перед покупкой корзина
// ВкусВилла показывает актуальную, а позицию, которой нет в наличии, приложение
// предлагает заменить.
//
// НЕ МЕШАЕМ ПОЛЬЗОВАТЕЛЯМ. Подогрев работает, только когда общий лимит запросов
// к ВкусВиллу занят меньше чем наполовину, и берёт мало за тик.
import { listWarmTargets } from "./db.js";
import { peekProxyCache, refreshProxyEntry, proxyCacheKey } from "./vkusvillProxy.js";
import { getUpstreamLoad, namesNeedingRefresh, queueNamesForWarming, runPriceWarmTick } from "./vkusvillPrices.js";

export const WARM_MAX_LOAD = 25; // из 50 — остальное оставляем пользователям
export const RECIPES_REFRESH_AFTER_MS = 4 * 60 * 60 * 1000;
export const RECIPES_PER_TICK = 3;
export const WARM_TARGETS_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

// Категории ВкусВилл — те же id, что CATEGORY_BY_MEAL во фронтенде
// (src/lib/vkusvillRecipes.js): завтрак, основное, перекус.
const SEED_CATEGORY_IDS = [332, 339, 335];

/** Страницы 1 и 2 (столько запрашивает фронтенд) трёх категорий без фильтров —
 * то, что запрашивает человек, оставивший все ответы "по умолчанию". Аргументы
 * ровно в том порядке и виде, как их шлёт searchRecipes во фронтенде: ключ кэша —
 * это JSON, и расхождение в порядке полей дало бы другой ключ. */
export function seedRecipeTargets() {
  const targets = [];
  for (const categoryId of SEED_CATEGORY_IDS) {
    for (const page of [1, 2]) {
      const args = {
        q: "", page, sort: "popularity",
        id_feature_filter: 0, id_cooking_time_filter: 0, id_cooking_method_filter: 0,
        id_complexity_filter: 0, id_category_filter: categoryId, id_exclude_allergens_filter: [],
      };
      targets.push({ key: proxyCacheKey("vkusvill_recipes", args), args, hits: 0 });
    }
  }
  return targets;
}

/** Названия ингредиентов со всех рецептов страницы каталога. */
export function ingredientNamesFromRecipesPage(data) {
  const names = [];
  for (const recipe of Array.isArray(data?.items) ? data.items : []) {
    for (const ing of Array.isArray(recipe?.ingredients) ? recipe.ingredients : []) {
      if (typeof ing?.name === "string" && ing.name.trim()) names.push(ing.name);
    }
  }
  return names;
}

/** Один проход подогрева. Возвращает, что сделано (для лога и тестов). */
export async function runWarmupTick(db, { now = Date.now(), maxLoad = WARM_MAX_LOAD } = {}) {
  if (getUpstreamLoad(now) > maxLoad) return { skipped: "busy", refreshedPages: 0, queuedNames: 0, warmedPrices: 0 };

  const sinceISO = new Date(now - 14 * DAY_MS).toISOString();
  const byKey = new Map();
  for (const t of [...listWarmTargets(db, { sinceISO, limit: WARM_TARGETS_LIMIT }), ...seedRecipeTargets()]) {
    if (!byKey.has(t.key)) byKey.set(t.key, t);
  }
  const targets = [...byKey.values()];

  // 1) Обновляем устаревающие страницы рецептов — понемногу за тик.
  let refreshedPages = 0;
  for (const t of targets) {
    if (refreshedPages >= RECIPES_PER_TICK) break;
    const cached = peekProxyCache("vkusvill_recipes", t.args, now);
    if (cached && cached.ageMs < RECIPES_REFRESH_AFTER_MS) continue;
    try {
      await refreshProxyEntry("vkusvill_recipes", t.args, now);
      refreshedPages++;
    } catch (err) {
      // ВкусВилл не ответил — не молотим впустую, повторим в следующий тик.
      console.warn(`[warmup] не удалось обновить страницу рецептов: ${err.message}`);
      break;
    }
  }

  // 2) Цены на ингредиенты всего, что лежит в кэше страниц, — в очередь подогрева.
  const names = [];
  for (const t of targets) {
    const cached = peekProxyCache("vkusvill_recipes", t.args, now);
    if (cached) names.push(...ingredientNamesFromRecipesPage(cached.data));
  }
  const needing = namesNeedingRefresh(db, names, now);
  queueNamesForWarming(needing);

  const { warmed } = await runPriceWarmTick(db);
  return { skipped: null, refreshedPages, queuedNames: needing.length, warmedPrices: warmed };
}
