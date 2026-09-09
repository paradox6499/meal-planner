// Клиент официального MCP-сервера ВкусВилл — https://mcp.vkusvill.ru/mcp
//
// Проверено вживую (curl, не догадка): handshake (initialize/session) не
// обязателен, сервер отвечает на одиночные tools/call без состояния между
// запросами. CORS открыт (Access-Control-Allow-Origin: *), поэтому дёргаем
// прямо из браузера — отдельный бэкенд под это пока не нужен.
//
// Форма ответа сервера — JSON-RPC, внутри которого ЕЩЁ ОДИН JSON строкой
// (result.content[0].text) — это не опечатка, так реально отдаёт сервер,
// разворачиваем в двух местах: outer (JSON-RPC) и inner (сам ответ MCP).
//
// Это внешний живой сервис, не наш код — при недоступности/таймауте
// вызывающий код должен откатиться на прежние оценочные данные, а не
// уронить экран. callTool() специально бросает понятную ошибку, а не
// проглатывает её — решение "что показать вместо реальных данных" остаётся
// за вызывающей стороной (UI), не за этим модулем.

const MCP_URL = "https://mcp.vkusvill.ru/mcp";
const DEFAULT_TIMEOUT_MS = 8000;

// Кэш в памяти вкладки для read-only вызовов (ничего не создают/не меняют
// на стороне ВкусВилл) — сбрасывается при перезагрузке страницы, этого
// достаточно: обычная сессия (собрать план -> заказать -> может ещё раз
// "нет в наличии") укладывается в разумный TTL. Причина завести его именно
// сейчас: "Заказать" почти всегда ищет ТЕ ЖЕ названия ингредиентов, что
// секунды назад уже искались при сборке плана (attachRealCosts в
// vkusvillRecipes.js) — без кэша это гарантированный повторный залп из
// 15-20 одинаковых запросов, а после недавнего живого rate-limit это не
// абстрактный риск. vkusvill_cart_link_create сюда НЕ входит — это
// создающий вызов, кэшировать создание нельзя.
const CACHEABLE_TOOLS = new Set(["vkusvill_products_search", "vkusvill_product_analogs", "vkusvill_recipes"]);
const CACHE_TTL_MS = 10 * 60 * 1000;
// Реалистичная сессия — от силы несколько десятков уникальных запросов
// (ингредиенты одной недели + пара "подобрать замену"), простой лимит на
// размер карты не даёт ей расти неограниченно, если вкладку не закрывают
// часами — вытесняем самую старую запись, а не городим LRU ради этого.
const CACHE_MAX_ENTRIES = 200;
const cache = new Map(); // key -> { data, expiresAt }

function cacheKeyFor(name, args) {
  return `${name}:${JSON.stringify(args)}`;
}

export function clearMcpCache() {
  cache.clear();
}

// RATE_LIMIT_RETRY_DELAYS_MS — только для http_status 429 (см. callToolOnce
// ниже). Раньше единичный 429 сразу превращался в "не нашли цену" для этого
// товара — теперь одна-две короткие паузы и повтор часто успевают проскочить,
// не заставляя пользователя вручную пересобирать весь план.
const RATE_LIMIT_RETRY_DELAYS_MS = [600, 1500];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callTool(name, args, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callToolOnce(name, args, opts);
    } catch (err) {
      if (err.httpStatus === 429 && attempt < RATE_LIMIT_RETRY_DELAYS_MS.length) {
        await sleep(RATE_LIMIT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw err;
    }
  }
}

async function callToolOnce(name, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cacheable = CACHEABLE_TOOLS.has(name);
  const cacheKey = cacheable ? cacheKeyFor(name, args) : null;
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.data;
    if (hit) cache.delete(cacheKey); // протухла — не оставляем мусор в карте
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`VkusVill MCP: таймаут (${timeoutMs}мс) при вызове ${name}`);
    }
    throw new Error(`VkusVill MCP: сеть недоступна (${err.message})`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`VkusVill MCP: HTTP ${res.status} при вызове ${name}`);
  }

  const outer = await res.json();
  if (outer.error) {
    throw new Error(`VkusVill MCP: ${outer.error.message || JSON.stringify(outer.error)}`);
  }

  const textPart = outer.result?.content?.[0]?.text;
  if (!textPart) {
    throw new Error(`VkusVill MCP: пустой ответ на ${name}`);
  }

  const inner = JSON.parse(textPart);
  if (!inner.ok) {
    // inner.error — ВСЕГДА объект {code, message, http_status, retryable},
    // не строка (проверено вживую) — `${inner.error}` тут коерсил бы его в
    // "[object Object]" вместо текста, это и был баг "vernul oshibku
    // ([object Object])" из чата. message — то, что реально стоит показать
    // человеку (например "Превышен лимит запросов, попробуйте позже").
    //
    // На живом 429 сам ответ противоречив: inner.error.retryable === false,
    // но ВЕРХНИЙ уровень inner.retryable === true и inner.code === "rate_limited"
    // одновременно. Полагаться на inner.error.retryable нельзя — он там,
    // где реально проверял, всегда false вне зависимости от сути ошибки.
    // http_status — единственное надёжное поле для решения "стоит ли
    // повторить попытку" (см. callTool: ретраит именно на 429).
    const msg = inner.error?.message || inner.error?.code || (typeof inner.error === "string" ? inner.error : "без описания");
    const err = new Error(`VkusVill MCP: ${name} вернул ошибку (${msg})`);
    err.code = inner.error?.code || inner.code;
    err.httpStatus = inner.error?.http_status;
    throw err;
  }

  // Кэшируем только УСПЕШНЫЙ ответ — ошибка/таймаут выбрасывается выше и до
  // этой строки не доходит, так что неудачный вызов никогда не залипнет в
  // кэше как будто он и правда так ответил.
  if (cacheKey) {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { data: inner.data, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return inner.data;
}

/** Поиск товаров ВкусВилл. mode: "short" (по умолчанию) | "full" | "custom" (+fields). */
export function searchProducts({
  q, page = 1, category_id, sort = "popularity", vvonly = 1, mode = "short", fields,
} = {}) {
  return callTool("vkusvill_products_search", { q, page, category_id, sort, vvonly, mode, fields });
}

export function getProductDetails(id) {
  return callTool("vkusvill_product_details", { id });
}

export function getProductByBarcode(barcode) {
  return callTool("vkusvill_product_barcode", { barcode });
}

export function getProductAnalogs(id) {
  return callTool("vkusvill_product_analogs", { id });
}

export function getDiscountProducts({ type = "card", page = 1, sort = "popularity", vvonly = 1 } = {}) {
  return callTool("vkusvill_products_discount", { type, page, sort, vvonly });
}

export function getShops({
  page = 1, id_region_filter = 0, id_city_filter = 0, id_subway_filter = 0, id_feature_filter = 0,
} = {}) {
  return callTool("vkusvill_shops", { page, id_region_filter, id_city_filter, id_subway_filter, id_feature_filter });
}

/** page=1 без q возвращает meta.filters — справочник доступных ID для
 * *_filter аргументов ниже (аллергены, способ готовки, категории и т.п.). */
export function searchRecipes({
  q = "", page = 1, sort = "popularity",
  id_feature_filter = 0, id_cooking_time_filter = 0, id_cooking_method_filter = 0,
  id_complexity_filter = 0, id_category_filter = 0, id_exclude_allergens_filter = [],
} = {}) {
  return callTool("vkusvill_recipes", {
    q, page, sort, id_feature_filter, id_cooking_time_filter, id_cooking_method_filter,
    id_complexity_filter, id_category_filter, id_exclude_allergens_filter,
  });
}

/** products: [{ xml_id, q }] — 1..20 позиций, q (количество) в диапазоне 0.01..40. */
export function createCartLink(products) {
  return callTool("vkusvill_cart_link_create", { products });
}

// Наши ингредиенты — граммы/миллилитры/штуки на порцию (см. recipes.js).
// Товар ВкусВилл продаётся в СВОЕЙ единице (кг/л/шт/уп...) — это первое
// приближение пересчёта, не точная торговая логика (округления в бОльшую
// сторону, чем нужно математически, — это осознанно: докупить лишнее не
// страшно, купить меньше нужного для рецепта — страшнее).
// export — нужна снаружи (ResultView в App.jsx) для честного пересчёта
// "Итого за продукты" при замене товара: сколько единиц товара-замены реально
// уйдёт в корзину, столько и должно учитываться в сумме, а не голая цена за
// одну штуку/кг замены без учёта нужного количества.
export function toVkusvillQuantity(amount, ourUnit, productUnit) {
  const clamp = (n) => Math.min(40, Math.max(0.01, n));
  if (ourUnit === "шт") return clamp(Math.round(amount));
  if (productUnit === "кг" || productUnit === "л") return clamp(Math.round((amount / 1000) * 100) / 100);
  if (productUnit === "г" || productUnit === "мл") return clamp(Math.round(amount));
  return 1; // незнакомая единица товара — берём одну упаковку как разумный дефолт
}

/** Ищет каждый пункт списка ([{name, amount, unit}]) в каталоге ВкусВилл
 * параллельно, возвращает лучшее совпадение с реальной ценой и количеством
 * в единице товара. Общая часть для сборки корзины (buildCartFromShoppingList)
 * и для подсчёта настоящей стоимости рецептов (vkusvillRecipes.js) — обе
 * задачи по сути "сколько это будет стоить и что из этого реально есть в
 * каталоге", разница только в том, что происходит с результатом дальше.
 *
 * Если пункт уже несёт xmlId (пользователь явно выбрал товар-замену через
 * "Нет в наличии" в ResultView, см. getSubstituteOptions в
 * vkusvillRecipes.js) — поиск не повторяем, берём то, что уже знаем: искать
 * заново по названию самого товара-замены не только лишний запрос, но и
 * риск найти НЕ ЕГО (мало ли похожих товаров в каталоге). */
// Раньше resolvePrices запускало ВСЕ поиски одним Promise.allSettled разом —
// для плана из ~40 уникальных ингредиентов это 40 одновременных запросов к
// MCP в один момент. Поймали живьём в чате: именно это, похоже, и triggers
// rate-limit ВкусВилл (лимит скорее burst — "не больше N запросов
// одновременно/в секунду", а не общий объём за минуту) — сумма "Итого"
// схлопывалась в 0 ₽ сразу после сборки плана. mapWithConcurrency ограничивает
// параллелизм, не убирая его совсем (полностью последовательно 40 запросов
// были бы неприемлемо медленными).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const SEARCH_CONCURRENCY = 6;

export async function resolvePrices(items) {
  const settled = await mapWithConcurrency(items, SEARCH_CONCURRENCY, async (item) => {
    if (item.xmlId) {
      return {
        matched: true,
        name: item.name,
        xml_id: item.xmlId,
        price: item.knownPrice ?? null,
        productUnit: item.knownUnit,
        q: toVkusvillQuantity(item.amount, item.unit, item.knownUnit),
      };
    }
    const data = await searchProducts({ q: item.name, mode: "short", vvonly: 0 });
    const match = data.items?.[0];
    if (!match) return { matched: false, name: item.name };
    return {
      matched: true,
      name: item.name,
      xml_id: match.xml_id,
      price: match.price?.current ?? null,
      productUnit: match.unit,
      q: toVkusvillQuantity(item.amount, item.unit, match.unit),
    };
  });
  return settled.map((r) => (r.status === "fulfilled" ? r.value : { matched: false, name: "?" }));
}

/** Берёт плоский список покупок ([{name, amount, unit}], как в App.jsx
 * plan.grouped[].items) и превращает в ссылку на реальную корзину ВкусВилл.
 * Часть ингредиентов может не найтись (пряности, самодельные заготовки) —
 * это ожидаемо, не ошибка; такие просто не попадают в корзину, а не роняют
 * весь заказ.
 *
 * Ограничение самого VkusVill: максимум 20 позиций в ссылке — если список
 * покупок больше, берутся первые 20 найденных (без приоритизации по важности,
 * это первое приближение, не решение продуктового вопроса "что важнее").*/
export async function buildCartFromShoppingList(items) {
  const resolved = await resolvePrices(items);
  const matched = resolved.filter((r) => r.matched);
  const unmatched = resolved.filter((r) => !r.matched).map((r) => r.name);

  if (matched.length === 0) {
    throw new Error("Не нашли ни одного товара ВкусВилл по списку покупок");
  }

  const capped = matched.slice(0, 20);
  const { link } = await createCartLink(capped.map(({ xml_id, q }) => ({ xml_id, q })));

  return { link, matchedCount: capped.length, totalCount: items.length, unmatched };
}
