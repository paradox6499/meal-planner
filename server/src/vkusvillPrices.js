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

// Устаревшую (но ещё не «древнюю») цену отдаём СРАЗУ, а обновляем в фоне — вместо ожидания живого
// запроса на каждом протухшем названии. Цена ингредиента за сутки-двое почти не меняется, а
// секунда-две ожидания на каждое из сотни названий превращались в минуты у человека, открывшего
// приложение. Дальше этих пределов запись считается негодной и спрашивается живьём, как раньше.
export const STALE_SERVE_MATCHED_MS = 3 * 24 * 60 * 60 * 1000; // 3 суток
export const STALE_SERVE_NOT_FOUND_MS = 24 * 60 * 60 * 1000; // сутки

// Общий потолок запросов к ВкусВиллу С НАШЕГО сервера. У них лимит 60 в минуту
// (заголовок X-RateLimit-Limit в ответе mcp.vkusvill.ru) — на IP, а у нас все
// пользователи ходят с одного IP (сервера), в отличие от прямых запросов из
// браузеров, где у каждого свой. Без общего ограничителя пара одновременных
// сборок плана выбирала бы лимит за секунды и все получали бы 429. Держим
// запас до 50. Ждём слот не дольше maxWaitMs, потом честно отдаём 429.
export const UPSTREAM_MAX_PER_MINUTE = 50;
const upstreamTimes = [];
export function resetUpstreamGate() {
  upstreamTimes.length = 0;
}
/** Сколько запросов к ВкусВиллу ушло за последнюю минуту — фоновый подогрев
 * смотрит на это и уступает дорогу пользователям. */
export function getUpstreamLoad(now = Date.now()) {
  return upstreamTimes.filter((t) => now - t < 60_000).length;
}
async function acquireUpstreamSlot(maxWaitMs = 8000) {
  const startedAt = Date.now();
  for (;;) {
    const now = Date.now();
    while (upstreamTimes.length > 0 && now - upstreamTimes[0] >= 60_000) upstreamTimes.shift();
    if (upstreamTimes.length < UPSTREAM_MAX_PER_MINUTE) {
      upstreamTimes.push(now);
      return;
    }
    const waitMs = 60_000 - (now - upstreamTimes[0]) + 5;
    if (now - startedAt + waitMs > maxWaitMs) {
      const e = new Error("VkusVill MCP: наш общий лимит запросов к каталогу исчерпан, попробуйте через минуту");
      e.httpStatus = 429;
      throw e;
    }
    await sleep(waitMs);
  }
}

async function callToolOnce(name, args, timeoutMs = DEFAULT_TIMEOUT_MS, { skipGate = false } = {}) {
  if (!skipGate) await acquireUpstreamSlot();
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

export async function callVkusvillTool(name, args) {
  return callTool(name, args);
}

/** Одна проверка "отвечает ли ВкусВилл С НАШЕГО сервера" — без повторов и без
 * общего ограничителя (это диагностика: ответ должен быть честным "да/нет, и
 * почему", а не "подождали и получилось"). Нужна, потому что браузерные
 * вызовы к mcp.vkusvill.ru перестали проходить (CORS-preflight отвечает 401),
 * и важно знать, проходят ли серверные с адреса, где стоит наш сервер. */
export async function probeVkusvill(timeoutMs = 8000) {
  const startedAt = Date.now();
  try {
    const data = await callToolOnce("vkusvill_products_search", { q: "молоко", page: 1, sort: "popularity", vvonly: 1, mode: "short" }, timeoutMs, { skipGate: true });
    const items = Array.isArray(data?.items) ? data.items.length : 0;
    return { ok: items > 0, ms: Date.now() - startedAt, detail: items > 0 ? `найдено товаров: ${items}` : "ответ пустой" };
  } catch (err) {
    return { ok: false, ms: Date.now() - startedAt, detail: err.message, httpStatus: err.httpStatus ?? null };
  }
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

// Найдено при живом прогоне (жалоба "не удалось получить цены почти ни на
// один товар"): почти ВСЕ обычные товары ВкусВилл (крупы, фарш, сахар)
// продаются "поштучно" (unit: "шт" = 1 упаковка), а настоящий вес/объём
// зашит только в текст названия ("Фарш из индейки, 500 г", "Сахар-песок,
// 1 кг") — без этого товар "шт" почти никогда не совпадал бы с ингредиентом
// рецепта в граммах/мл (см. resolveIngredientCost в src/lib/vkusvillRecipes.js
// — та же логика сравнения "род единиц"). Дублирует parsePackageAmount из
// src/lib/vkusvillMcp.js сознательно — см. комментарий в шапке файла про
// то, почему этот модуль не импортирует оттуда.
function parsePackageAmount(productName) {
  if (!productName) return null;
  const normalized = productName.replace(/&nbsp;/gi, " ");
  // (?![а-яёА-ЯЁ]) вместо \b — та же ASCII-only ловушка \b/\w на кириллице,
  // что уже ловили в src/lib/vkusvillRecipes.js: единица почти всегда
  // последнее слово названия, \b там не находит границу.
  const match = /(\d+(?:[.,]\d+)?)\s*(кг|г|мл|л)(?![а-яёА-ЯЁ])/i.exec(normalized);
  if (!match) return null;
  let amount = parseFloat(match[1].replace(",", "."));
  let unit = match[2].toLowerCase();
  if (unit === "кг") { amount *= 1000; unit = "г"; }
  if (unit === "л") { amount *= 1000; unit = "мл"; }
  return { amount, unit };
}

/** Один живой поиск товара по названию — сравните с searchProducts в
 * src/lib/vkusvillMcp.js, тот же вызов, тот же инструмент MCP. */
async function fetchLive(name) {
  const data = await callTool("vkusvill_products_search", { q: name, page: 1, sort: "popularity", vvonly: 1, mode: "short" });
  const match = data.items?.[0];
  if (!match) return { matched: false, name, price: null, productUnit: null, xmlId: null, packageAmount: null, packageUnit: null };
  const pkg = match.unit === "шт" ? parsePackageAmount(match.name) : null;
  return {
    matched: true,
    name,
    price: match.price?.current ?? null,
    productUnit: match.unit ?? null,
    xmlId: match.xml_id ?? null,
    packageAmount: pkg?.amount ?? null,
    packageUnit: pkg?.unit ?? null,
  };
}

// Подогрев обновляет цену заранее, не дожидаясь конца срока (MATCHED_TTL_MS):
// пользователь почти всегда застаёт запись, которой не больше этих часов.
export const WARM_REFRESH_AFTER_MS = 8 * 60 * 60 * 1000;

function isServableStale(cached, nowMs) {
  const ageMs = nowMs - new Date(cached.updatedAt).getTime();
  return ageMs < (cached.matched ? STALE_SERVE_MATCHED_MS : STALE_SERVE_NOT_FOUND_MS);
}

function isFresh(cached, nowMs, maxAgeMs = Infinity) {
  const ageMs = nowMs - new Date(cached.updatedAt).getTime();
  return ageMs < Math.min(maxAgeMs, cached.matched ? MATCHED_TTL_MS : NOT_FOUND_TTL_MS);
}

// Названия, запрос по которым не удался: подогрев не пробует их снова целый час.
// Без этого одно название, на которое каталог стабильно отвечает ошибкой, уходило в
// очередь каждую минуту и бесконечно повторялось (с ретраями — десятки запросов к
// ВкусВиллу в час впустую; они ещё и похожи на поведение бота для защиты каталога).
export const FAILED_NAME_RETRY_AFTER_MS = 60 * 60 * 1000;
const failedAt = new Map(); // name -> timestamp неудачи
export function clearFailedNames() {
  failedAt.clear();
}

/** Из списка названий — те, для которых в кэше нет записи или она старше
 * WARM_REFRESH_AFTER_MS (то есть пора обновлять заранее); недавно не
 * получившиеся пропускаем (см. FAILED_NAME_RETRY_AFTER_MS). */
export function namesNeedingRefresh(db, names, nowMs = Date.now()) {
  const unique = [...new Set(names)];
  const cached = getIngredientPricesByName(db, unique);
  return unique.filter((n) => {
    const failed = failedAt.get(n);
    if (failed != null && nowMs - failed < FAILED_NAME_RETRY_AFTER_MS) return false;
    const hit = cached.get(n);
    return !hit || !isFresh(hit, nowMs, WARM_REFRESH_AFTER_MS);
  });
}

/** names: string[] (могут повторяться) -> Map<name, {matched, price,
 * productUnit, xmlId, packageAmount, packageUnit}>. Сначала читает общий
 * кэш (db.js), для того, чего там нет/устарело — идёт живьём в ВкусВилл (с
 * тем же ограничением параллелизма и ретраями, что и на фронтенде),
 * результат пишет обратно в кэш ОДНОЙ транзакцией, чтобы он послужил всем
 * следующим пользователям, спросившим те же названия. Неудачный живой
 * запрос (после исчерпания ретраев) не кэшируется вообще — как и на
 * фронтенде (см. комментарий у callToolOnce в vkusvillMcp.js): временный
 * сбой не должен залипать в кэше как будто товар не найден. */
// Названия, до которых в этот раз не дошли (потолок запросов или общий лимит
// ВкусВилла) — их по одному подогревает фоновый тик (runPriceWarmTick), чтобы
// при следующей сборке цены уже лежали в кэше. Без этого каждый новый пользователь
// на холодном кэше упирался бы в те же 50 запросов в минуту заново.
const WARM_QUEUE_MAX = 2000;
const warmQueue = new Set();
export function queueNamesForWarming(names) {
  for (const n of names) {
    if (warmQueue.size >= WARM_QUEUE_MAX) break;
    warmQueue.add(n);
  }
}
export function getWarmQueueSize() {
  return warmQueue.size;
}
export function clearWarmQueue() {
  warmQueue.clear();
}
/** Один проход фонового подогрева: берёт до batch названий из очереди и
 * получает для них цены (общий ограничитель запросов тот же, что у
 * пользователей — подогрев никого не вытесняет дольше нескольких секунд).
 * Неудавшиеся назад в очередь НЕ ставим — если ВкусВилл недоступен, тик не
 * должен молотить впустую; следующий пользовательский запрос поставит их сам. */
export async function runPriceWarmTick(db, { batch = 20 } = {}) {
  const names = [...warmQueue].slice(0, batch);
  names.forEach((n) => warmQueue.delete(n));
  if (names.length === 0) return { warmed: 0 };
  await resolveIngredientPricesWithCache(db, names, { maxLiveFetches: batch, warm: true, maxAgeMs: WARM_REFRESH_AFTER_MS });
  return { warmed: names.length };
}

// deadlineMs — ответить пользователю не позже, чем через столько: на холодном
// кэше сотня названий не укладывается в наши 50 запросов в минуту, и ждать
// минутами (клиент всё равно бросит запрос) незачем. Что не успели — остаётся
// в работе: уже летящие запросы допишут свой результат в кэш сами, остальные
// уходят в очередь подогрева.
export async function resolveIngredientPricesWithCache(db, names, { maxLiveFetches = Infinity, takeLiveBudget = null, warm = false, maxAgeMs = Infinity, deadlineMs = null } = {}) {
  const uniqueNames = [...new Set(names.filter((n) => typeof n === "string" && n.trim().length > 0))];
  const result = new Map();
  if (uniqueNames.length === 0) return result;

  const nowMs = Date.now();
  const cached = getIngredientPricesByName(db, uniqueNames);
  const toFetch = [];
  const servedStale = [];
  for (const name of uniqueNames) {
    const hit = cached.get(name);
    if (hit && (isFresh(hit, nowMs, maxAgeMs) || (!warm && isServableStale(hit, nowMs)))) {
      result.set(name, { matched: hit.matched, price: hit.price, productUnit: hit.productUnit, xmlId: hit.xmlId, packageAmount: hit.packageAmount, packageUnit: hit.packageUnit });
      if (!isFresh(hit, nowMs)) servedStale.push(name); // отдали сразу, обновим в фоне
    } else {
      toFetch.push(name);
    }
  }
  if (servedStale.length > 0) queueNamesForWarming(servedStale);
  if (toFetch.length === 0) return result;

  // Потолок живых запросов (аудит 29.09.2026): один пользователь с одной
  // действительной сессией мог присылать сотни выдуманных названий и
  // заваливать общий rate-limit ВкусВилл, а каждое название навсегда
  // оседало в ingredient_prices. Всё, что не влезло в потолок (за запрос и за
  // час на пользователя, см. takeLiveBudget), получает честное "цена не
  // найдена" БЕЗ записи в кэш — следующий запрос попробует снова.
  let allowed = Math.min(toFetch.length, maxLiveFetches);
  if (takeLiveBudget) allowed = takeLiveBudget(allowed);
  const skipped = toFetch.slice(allowed);
  toFetch.length = allowed;
  if (!warm) queueNamesForWarming(skipped);
  for (const name of skipped) {
    const stale = cached.get(name);
    result.set(
      name,
      stale
        ? { matched: stale.matched, price: stale.price, productUnit: stale.productUnit, xmlId: stale.xmlId, packageAmount: stale.packageAmount, packageUnit: stale.packageUnit }
        : { matched: false, price: null, productUnit: null, xmlId: null, packageAmount: null, packageUnit: null }
    );
  }
  if (toFetch.length === 0) return result;

  const deadlineAt = deadlineMs != null ? Date.now() + deadlineMs : null;
  const outcomes = new Map(); // name -> {value} | {error} | отсутствует (не дошли до запроса)
  const work = mapWithConcurrency(toFetch, CONCURRENCY, async (name) => {
    if (deadlineAt != null && Date.now() > deadlineAt) return; // не начинаем новый запрос после срока
    try {
      const value = await fetchLive(name);
      // Пишем сразу, а не пачкой в конце: если мы уже ответили по сроку, запрос
      // всё равно доработает и его результат достанется следующим пользователям.
      upsertIngredientPrices(db, [{ name, ...value }], new Date().toISOString());
      outcomes.set(name, { value });
    } catch (err) {
      outcomes.set(name, { error: err });
    }
  });
  // Страховка от зависшего запроса: ждём не дольше срока + запас на уже начатые.
  if (deadlineAt != null) await Promise.race([work, sleep(deadlineMs + 4000)]);
  else await work;

  for (const name of toFetch) {
    const out = outcomes.get(name);
    if (out?.value) {
      const { matched, price, productUnit, xmlId, packageAmount, packageUnit } = out.value;
      result.set(name, { matched, price, productUnit, xmlId, packageAmount, packageUnit });
      continue;
    }
    // Запрос не удался (после ретраев), не дошёл до выполнения или не уложился в
    // срок. Не кэшируем как "не найдено" — временный сбой не должен залипать.
    if (out?.error) failedAt.set(name, Date.now());
    // Если в кэше есть устаревшая запись — отдаём её: она почти наверняка
    // честнее, чем "нет цены вообще".
    const stale = cached.get(name);
    if (!warm) queueNamesForWarming([name]);
    result.set(
      name,
      stale
        ? { matched: stale.matched, price: stale.price, productUnit: stale.productUnit, xmlId: stale.xmlId, packageAmount: stale.packageAmount, packageUnit: stale.packageUnit }
        : { matched: false, price: null, productUnit: null, xmlId: null, packageAmount: null, packageUnit: null }
    );
  }
  return result;
}
