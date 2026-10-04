// Прокси к MCP ВкусВилл для фронтенда (POST /api/vkusvill/call).
//
// ЗАЧЕМ. Браузер (и WebView Telegram) не может ходить в mcp.vkusvill.ru
// напрямую: запрос с Content-Type: application/json запускает CORS-preflight
// (OPTIONS), а ВкусВилл (за QRATOR) с 04.10.2026 отвечает на него 401 без
// Access-Control-Allow-* — до самого POST браузер не доходит. Проверено curl'ом
// для любого Origin. Результат на реальном телефоне: каталог "не ответил", план
// собирается из базового набора рецептов без цен. Серверные запросы CORS не
// знают — поэтому фронтенд теперь ходит сюда, а мы — во ВкусВилл.
//
// ЧТО ЕЩЁ ДАЁТ. Общий кэш для всех пользователей (у ВкусВилла 60 запросов в
// минуту на IP, а у нас IP один — без кэша и склейки одинаковых запросов хватило
// бы нескольких одновременных сборок плана) и склейку одновременных одинаковых
// запросов в один.
import { callVkusvillTool } from "./vkusvillPrices.js";

// Только то, что реально использует фронтенд (src/lib/vkusvillMcp.js) — не
// открытый прокси к чему угодно.
export const ALLOWED_TOOLS = new Set([
  "vkusvill_products_search",
  "vkusvill_product_details",
  "vkusvill_product_barcode",
  "vkusvill_product_analogs",
  "vkusvill_products_discount",
  "vkusvill_shops",
  "vkusvill_recipes",
  "vkusvill_cart_link_create",
]);

// Только чтение — кэшируем. cart_link_create создаёт ссылку, кэшировать нельзя.
const CACHEABLE_TOOLS = new Set([
  "vkusvill_products_search",
  "vkusvill_product_details",
  "vkusvill_product_barcode",
  "vkusvill_product_analogs",
  "vkusvill_recipes",
  "vkusvill_shops",
]);

export const PROXY_CACHE_TTL_MS = 30 * 60 * 1000;
// Страницы рецептов меняются редко (это не цены), а тянутся дорого — держим
// дольше; фоновый подогрев (warmup.js) обновляет их заранее, до конца срока.
export const RECIPES_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ttlFor = (tool) => (tool === "vkusvill_recipes" ? RECIPES_CACHE_TTL_MS : PROXY_CACHE_TTL_MS);
export const proxyCacheKey = (tool, args) => `${tool}:${JSON.stringify(args)}`;
// Страницы рецептов бывают тяжёлыми (состав, шаги) — потолок на число записей, а
// не на байты; самую старую вытесняем, LRU ради этого не городим.
export const PROXY_CACHE_MAX_ENTRIES = 400;
export const MAX_ARGS_JSON_LENGTH = 6000;

const cache = new Map(); // key -> { data, expiresAt }
const inflight = new Map(); // key -> Promise<data>

export function clearProxyState() {
  cache.clear();
  inflight.clear();
}

/** @returns {{ok: true, tool: string, args: object} | {ok: false, error: string}} */
export function parseVkusvillCallRequest(body) {
  const { tool, args } = body ?? {};
  if (typeof tool !== "string" || !ALLOWED_TOOLS.has(tool)) return { ok: false, error: "неизвестный инструмент каталога" };
  if (args === undefined || args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "args должен быть объектом" };
  }
  if (JSON.stringify(args).length > MAX_ARGS_JSON_LENGTH) return { ok: false, error: "args слишком большой" };
  if (tool === "vkusvill_cart_link_create" && (!Array.isArray(args.products) || args.products.length === 0 || args.products.length > 20)) {
    return { ok: false, error: "products: от 1 до 20 позиций" };
  }
  return { ok: true, tool, args };
}

/**
 * @param takeLiveBudget — (n) => сколько из n живых запросов разрешено этому
 *   пользователю; вызывается ТОЛЬКО на промахе кэша (попадания в кэш бесплатны).
 */
export async function callVkusvillCached(tool, args, { takeLiveBudget = null, now = Date.now() } = {}) {
  const cacheable = CACHEABLE_TOOLS.has(tool);
  const key = proxyCacheKey(tool, args);

  if (cacheable) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.data;
    if (hit) cache.delete(key);
    const pending = inflight.get(key);
    if (pending) return pending; // тот же запрос уже летит — не плодим второй
  }

  if (takeLiveBudget && takeLiveBudget(1) < 1) {
    const e = new Error("слишком много обращений к каталогу, попробуйте через минуту");
    e.httpStatus = 429;
    e.ownLimit = true;
    throw e;
  }

  const promise = callVkusvillTool(tool, args);
  if (cacheable) inflight.set(key, promise);
  try {
    const data = await promise;
    if (cacheable) {
      if (cache.size >= PROXY_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(key, { data, expiresAt: now + ttlFor(tool), storedAt: now });
    }
    return data;
  } finally {
    if (cacheable) inflight.delete(key);
  }
}

/** Что лежит в кэше по этому вызову (без обращения к ВкусВиллу): данные и их
 * возраст в мс, либо null. Для фонового подогрева. */
export function peekProxyCache(tool, args, now = Date.now()) {
  const hit = cache.get(proxyCacheKey(tool, args));
  if (!hit || hit.expiresAt <= now) return null;
  return { data: hit.data, ageMs: now - (hit.storedAt ?? now) };
}

/** Заранее обновляет запись кэша живым запросом (подогрев). Пока идёт запрос,
 * пользователи продолжают получать старую запись — подмена только по успеху.
 * При ошибке старая запись остаётся как была, ошибка пробрасывается. */
export async function refreshProxyEntry(tool, args, now = Date.now()) {
  if (!CACHEABLE_TOOLS.has(tool)) throw new Error("инструмент не кэшируется");
  const data = await callVkusvillTool(tool, args);
  const key = proxyCacheKey(tool, args);
  cache.delete(key); // заново в конец очереди вытеснения: подогретое — самое нужное
  if (cache.size >= PROXY_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expiresAt: now + ttlFor(tool), storedAt: now });
  return data;
}
