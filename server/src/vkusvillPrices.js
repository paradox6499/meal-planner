// Общий (на всех пользователей) кэш цен ВкусВилл по названию ингредиента —
// см. db.js:ingredient_prices. Идея: одна и та же сборка плана раньше КАЖДЫЙ
// раз спрашивала цену КАЖДОГО ингредиента у ВкусВилл живьём, из браузера
// (src/lib/vkusvillMcp.js:resolvePrices) — у него уже есть кэш, но
// in-memory и per-браузер: ничего не переживает перезагрузку страницы и
// ничем не делится между пользователями. А реальные названия сильно
// пересекаются между разными людьми (курица, лук, молоко — почти в каждом
// плане) — общий серверный кэш должен заметно снизить число живых запросов
// к ВкусВилл и, соответственно, как часто вообще упираемся в их rate-limit
// (живьём поймали "Превышен лимит запросов" даже на одиночный запрос при
// разборе жалобы "цены не получаются").
//
// Намеренно НЕ импортируется из src/lib/vkusvillMcp.js (там есть тот же
// протокол и та же логика ретраев) — server/ это отдельный npm-пакет,
// задеплоенный отдельно от фронтенда (Render root — server/), кросс-импорт
// файла ВНЕ этой директории был бы хрупким: сломался бы, если Render
// когда-нибудь станет разворачивать только server/ как отдельный артефакт, а
// не весь репозиторий целиком. Протокол и параметры ретраев продублированы
// сознательно, держите их в синхроне вручную, если поменяются в одном месте.

import { getIngredientPricesByName, upsertIngredientPrices } from "./db.js";

const MCP_URL = "https://mcp.vkusvill.ru/mcp";
const DEFAULT_TIMEOUT_MS = 8000;
const RETRY_DELAYS_MS = [700, 1600, 3000];
const CONCURRENCY = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// matched=true живёт в кэше дольше (цены на самом деле не скачут поминутно) —
// не-найденные позиции ("специи", опечатки, реально отсутствующий в каталоге
// товар) держим короче: если это была временная неудача (сеть/429, не
// "такого товара нет"), не хотим залипать в "не нашли" надолго.
export const MATCHED_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов
export const NOT_FOUND_TTL_MS = 2 * 60 * 60 * 1000; // 2 часа

async function callToolOnce(name, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error(`VkusVill MCP: ${err.name === "AbortError" ? `таймаут (${timeoutMs}мс)` : `сеть недоступна (${err.message})`} при вызове ${name}`);
    e.retryable = true;
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const e = new Error(`VkusVill MCP: HTTP ${res.status} при вызове ${name}`);
    e.httpStatus = res.status;
    if (res.status >= 500) e.retryable = true;
    throw e;
  }

  const outer = await res.json();
  if (outer.error) throw new Error(`VkusVill MCP: ${outer.error.message || JSON.stringify(outer.error)}`);

  const textPart = outer.result?.content?.[0]?.text;
  if (!textPart) throw new Error(`VkusVill MCP: пустой ответ на ${name}`);

  const inner = JSON.parse(textPart);
  if (!inner.ok) {
    const msg = inner.error?.message || inner.error?.code || (typeof inner.error === "string" ? inner.error : "без описания");
    const err = new Error(`VkusVill MCP: ${name} вернул ошибку (${msg})`);
    err.httpStatus = inner.error?.http_status;
    throw err;
  }
  return inner.data;
}

async function callTool(name, args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callToolOnce(name, args);
    } catch (err) {
      if ((err.httpStatus === 429 || err.retryable) && attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        await sleep(delay + Math.random() * delay * 0.3);
        continue;
      }
      throw err;
    }
  }
}

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

/** Один живой поиск товара по названию — сравните с searchProducts в
 * src/lib/vkusvillMcp.js, тот же вызов, тот же инструмент MCP. */
async function fetchLive(name) {
  const data = await callTool("vkusvill_products_search", { q: name, page: 1, sort: "popularity", vvonly: 1, mode: "short" });
  const match = data.items?.[0];
  if (!match) return { matched: false, name, price: null, productUnit: null, xmlId: null };
  return {
    matched: true,
    name,
    price: match.price?.current ?? null,
    productUnit: match.unit ?? null,
    xmlId: match.xml_id ?? null,
  };
}

function isFresh(cached, nowMs) {
  const ageMs = nowMs - new Date(cached.updatedAt).getTime();
  return ageMs < (cached.matched ? MATCHED_TTL_MS : NOT_FOUND_TTL_MS);
}

/** names: string[] (могут повторяться) -> Map<name, {matched, price,
 * productUnit, xmlId}>. Сначала читает общий кэш (db.js), для того, чего
 * там нет/устарело — идёт живьём в ВкусВилл (с тем же ограничением
 * параллелизма и ретраями, что и на фронтенде), результат пишет обратно в
 * кэш ОДНОЙ транзакцией, чтобы он послужил всем следующим пользователям,
 * спросившим те же названия. Неудачный живой запрос (после исчерпания
 * ретраев) не кэшируется вообще — как и на фронтенде (см. комментарий у
 * callToolOnce в vkusvillMcp.js): временный сбой не должен залипать в кэше
 * как будто товар не найден. */
export async function resolveIngredientPricesWithCache(db, names) {
  const uniqueNames = [...new Set(names.filter((n) => typeof n === "string" && n.trim().length > 0))];
  const result = new Map();
  if (uniqueNames.length === 0) return result;

  const nowMs = Date.now();
  const cached = getIngredientPricesByName(db, uniqueNames);
  const toFetch = [];
  for (const name of uniqueNames) {
    const hit = cached.get(name);
    if (hit && isFresh(hit, nowMs)) {
      result.set(name, { matched: hit.matched, price: hit.price, productUnit: hit.productUnit, xmlId: hit.xmlId });
    } else {
      toFetch.push(name);
    }
  }
  if (toFetch.length === 0) return result;

  const settled = await mapWithConcurrency(toFetch, CONCURRENCY, fetchLive);
  const toUpsert = [];
  const nowISO = new Date(nowMs).toISOString();
  settled.forEach((r, i) => {
    const name = toFetch[i];
    if (r.status !== "fulfilled") {
      // Живой запрос не удался даже после ретраев — отдаём "не нашли" этому
      // конкретному ответу, но НЕ кэшируем (см. комментарий выше функции).
      // Если в кэше уже была строка (просто устаревшая) — лучше отдать её,
      // чем ничего: устаревшая цена почти наверняка честнее, чем "нет цены
      // вообще" при временном сбое ВкусВилл.
      const stale = cached.get(name);
      result.set(name, stale ? { matched: stale.matched, price: stale.price, productUnit: stale.productUnit, xmlId: stale.xmlId } : { matched: false, price: null, productUnit: null, xmlId: null });
      return;
    }
    const { matched, price, productUnit, xmlId } = r.value;
    result.set(name, { matched, price, productUnit, xmlId });
    toUpsert.push({ name, matched, price, productUnit, xmlId });
  });

  if (toUpsert.length > 0) upsertIngredientPrices(db, toUpsert, nowISO);
  return result;
}
