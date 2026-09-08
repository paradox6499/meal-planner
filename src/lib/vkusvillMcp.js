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

async function callTool(name, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
    throw new Error(`VkusVill MCP: ${name} вернул ошибку (${inner.error || "без описания"})`);
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
function toVkusvillQuantity(amount, ourUnit, productUnit) {
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
 * каталоге", разница только в том, что происходит с результатом дальше. */
export async function resolvePrices(items) {
  const settled = await Promise.allSettled(
    items.map(async (item) => {
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
    })
  );
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
