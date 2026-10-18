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

// Подогрев намеренно «тихий»: при блокировке адреса сервера защитой каталога (QRATOR, 05.10.2026)
// не хочется давать ей повод видеть в нас бота — мало запросов, никакой равномерной «барабанной дроби».
export const WARM_MAX_LOAD = 15; // из 50 — остальное оставляем пользователям
export const WARM_PRICES_PER_TICK = 3;
export const RECIPES_REFRESH_AFTER_MS = 4 * 60 * 60 * 1000;
export const RECIPES_PER_TICK = 1;
// Первый запуск на новом адресе (18.10.2026): ≈10 запросов в минуту, и через 4 минуты ВкусВилл перестал отвечать
// (блокировка отпустила минут через пять тишины). Поэтому — потолок запросов в час и «автомат»: любой сбой
// останавливает подогрев на полчаса, чтобы не стучать в заблокированный адрес.
export const WARM_MAX_PER_HOUR = 90;
export const WARM_PAUSE_AFTER_FAILURE_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
let pausedUntil = 0;
let spentAt = []; // отметки времени наших запросов за последний час

export function resetWarmupState() {
  pausedUntil = 0;
  spentAt = [];
}
export function getWarmupPausedUntil() {
  return pausedUntil;
}
function pauseWarmup(now, reason) {
  pausedUntil = now + WARM_PAUSE_AFTER_FAILURE_MS;
  console.warn(`[warmup] пауза на ${WARM_PAUSE_AFTER_FAILURE_MS / 60000} мин: ${reason}`);
}
export const WARM_TARGETS_LIMIT = 20;
// Сколько страниц подогреваем ВСЕГО: самые востребованные из спроса + обход каталога.
const DAY_MS = 24 * 60 * 60 * 1000;

// Категории ВкусВилл — те же id, что CATEGORY_BY_MEAL во фронтенде
// (src/lib/vkusvillRecipes.js): завтрак, основное, перекус — и сколько страниц (по 10 рецептов)
// обходить в каждой. Страницы 1–2 — ровно то, что запрашивает человек с ответами «по умолчанию»
// (его сборка попадает в кэш целиком). Остальные нужны ради цен: ингредиенты у рецептов сильно
// пересекаются (замер 05.10.2026: обход 6 страниц «основного» даёт ~200 названий и покрывает 58–77%
// названий при других запросах — «курица», «овощи», «суп»), и чем больше названий уже в кэше цен,
// тем реже новому человеку приходится ждать живые запросы (около секунды на название).
const SEED_PAGES = [
  { categoryId: 332, pages: 12 }, // основное (обед и ужин)
  { categoryId: 339, pages: 4 }, // завтрак
  { categoryId: 335, pages: 3 }, // перекус
];

/** Страницы каталога без фильтров: порядок и вид аргументов — ровно как их шлёт searchRecipes во
 * фронтенде (ключ кэша — это JSON, и расхождение в порядке полей дало бы другой ключ). */
export function seedRecipeTargets() {
  const targets = [];
  for (const { categoryId, pages } of SEED_PAGES) {
    for (let page = 1; page <= pages; page++) {
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
  const none = { refreshedPages: 0, queuedNames: 0, warmedPrices: 0 };
  if (now < pausedUntil) return { skipped: "paused", ...none };
  spentAt = spentAt.filter((t) => now - t < HOUR_MS);
  const budgetLeft = WARM_MAX_PER_HOUR - spentAt.length;
  if (budgetLeft <= 0) return { skipped: "hourly_cap", ...none };
  if (getUpstreamLoad(now) > maxLoad) return { skipped: "busy", ...none };

  const sinceISO = new Date(now - 14 * DAY_MS).toISOString();
  const byKey = new Map();
  for (const t of [...listWarmTargets(db, { sinceISO, limit: WARM_TARGETS_LIMIT }), ...seedRecipeTargets()]) {
    if (!byKey.has(t.key)) byKey.set(t.key, t);
  }
  const targets = [...byKey.values()];

  // 1) Обновляем устаревающие страницы рецептов — понемногу за тик.
  let refreshedPages = 0;
  let pageFailed = false;
  for (const t of targets) {
    if (refreshedPages >= Math.min(RECIPES_PER_TICK, budgetLeft)) break;
    const cached = peekProxyCache("vkusvill_recipes", t.args, now);
    if (cached && cached.ageMs < RECIPES_REFRESH_AFTER_MS) continue;
    try {
      await refreshProxyEntry("vkusvill_recipes", t.args, now);
      refreshedPages++;
      spentAt.push(now);
    } catch (err) {
      // ВкусВилл не ответил — не молотим впустую: подогрев встаёт на паузу (см. WARM_PAUSE_AFTER_FAILURE_MS).
      console.warn(`[warmup] не удалось обновить страницу рецептов: ${err.message}`);
      spentAt.push(now);
      pageFailed = true;
      break;
    }
  }
  if (pageFailed) {
    pauseWarmup(now, "страница рецептов не обновилась");
    return { skipped: "paused", ...none };
  }

  // 2) Цены на ингредиенты всего, что лежит в кэше страниц, — в очередь подогрева.
  const names = [];
  for (const t of targets) {
    const cached = peekProxyCache("vkusvill_recipes", t.args, now);
    if (cached) names.push(...ingredientNamesFromRecipesPage(cached.data));
  }
  const needing = namesNeedingRefresh(db, names, now);
  queueNamesForWarming(needing);

  const batch = Math.max(0, Math.min(WARM_PRICES_PER_TICK, budgetLeft - refreshedPages));
  const { warmed, failed } = batch > 0 ? await runPriceWarmTick(db, { batch }) : { warmed: 0, failed: 0 };
  for (let i = 0; i < warmed; i++) spentAt.push(now);
  if (failed > 0) pauseWarmup(now, `не удалось получить цены: ${failed} из ${warmed}`);
  return { skipped: null, refreshedPages, queuedNames: needing.length, warmedPrices: warmed - failed };
}
