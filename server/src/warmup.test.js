import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runWarmupTick, seedRecipeTargets, ingredientNamesFromRecipesPage, RECIPES_REFRESH_AFTER_MS, RECIPES_PER_TICK } from "./warmup.js";
import { clearProxyState, peekProxyCache, refreshProxyEntry, callVkusvillCached, proxyCacheKey, RECIPES_CACHE_TTL_MS, PROXY_CACHE_TTL_MS } from "./vkusvillProxy.js";
import { resetUpstreamGate, clearWarmQueue, getWarmQueueSize, getUpstreamLoad, UPSTREAM_MAX_PER_MINUTE, resolveIngredientPricesWithCache, WARM_REFRESH_AFTER_MS, namesNeedingRefresh, clearFailedNames, FAILED_NAME_RETRY_AFTER_MS } from "./vkusvillPrices.js";
import { openDb, recordPlanGeneration, recordWarmTarget, listWarmTargets, purgeOldWarmTargets, upsertIngredientPrices, getIngredientPricesByName } from "./db.js";
import { runMaintenance } from "./maintenance.js";

const mcpOk = (data) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify({ ok: true, data }) }] } }) });
const recipesPage = (names) => ({ items: [{ id: 1, name: "Рецепт", ingredients: names.map((n) => ({ name: n, quantity: "100 г" })) }] });
const H = 60 * 60 * 1000;

let db;
beforeEach(() => {
  db = openDb(":memory:");
  clearProxyState();
  resetUpstreamGate();
  clearWarmQueue();
  clearFailedNames();
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("seedRecipeTargets", () => {
  it("страницы 1 и 2 трёх категорий, аргументы в том порядке, как их шлёт фронтенд", () => {
    const seeds = seedRecipeTargets();
    expect(seeds).toHaveLength(6);
    expect(Object.keys(seeds[0].args)).toEqual([
      "q", "page", "sort", "id_feature_filter", "id_cooking_time_filter", "id_cooking_method_filter",
      "id_complexity_filter", "id_category_filter", "id_exclude_allergens_filter",
    ]);
    expect(new Set(seeds.map((s) => s.args.id_category_filter))).toEqual(new Set([332, 339, 335]));
  });
});

describe("ingredientNamesFromRecipesPage", () => {
  it("достаёт названия как есть, пропускает пустые и битые данные", () => {
    expect(ingredientNamesFromRecipesPage(recipesPage(["Лук репчатый", " ", "Морковь"]))).toEqual(["Лук репчатый", "Морковь"]);
    expect(ingredientNamesFromRecipesPage(null)).toEqual([]);
    expect(ingredientNamesFromRecipesPage({ items: [{ ingredients: null }, {}] })).toEqual([]);
  });
});

describe("кэш прокси: срок для рецептов дольше, чем для остального", () => {
  it("страница рецептов живёт 6 часов, поиск товаров — 30 минут", async () => {
    fetch.mockResolvedValue(mcpOk({ items: [] }));
    const t0 = 1_000_000;
    await callVkusvillCached("vkusvill_recipes", { page: 1 }, { now: t0 });
    await callVkusvillCached("vkusvill_products_search", { q: "лук" }, { now: t0 });
    expect(peekProxyCache("vkusvill_recipes", { page: 1 }, t0 + RECIPES_CACHE_TTL_MS - 1)).not.toBeNull();
    expect(peekProxyCache("vkusvill_recipes", { page: 1 }, t0 + RECIPES_CACHE_TTL_MS + 1)).toBeNull();
    expect(peekProxyCache("vkusvill_products_search", { q: "лук" }, t0 + PROXY_CACHE_TTL_MS - 1)).not.toBeNull();
    expect(peekProxyCache("vkusvill_products_search", { q: "лук" }, t0 + PROXY_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("refreshProxyEntry подменяет запись только по успеху; при ошибке остаётся старая", async () => {
    fetch.mockResolvedValueOnce(mcpOk({ v: 1 }));
    await callVkusvillCached("vkusvill_recipes", { page: 1 }, { now: 1000 });
    fetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    await expect(refreshProxyEntry("vkusvill_recipes", { page: 1 }, 2000)).rejects.toThrow();
    expect(peekProxyCache("vkusvill_recipes", { page: 1 }, 3000).data).toEqual({ v: 1 });
    fetch.mockResolvedValue(mcpOk({ v: 2 }));
    await refreshProxyEntry("vkusvill_recipes", { page: 1 }, 4000);
    const hit = peekProxyCache("vkusvill_recipes", { page: 1 }, 5000);
    expect(hit.data).toEqual({ v: 2 });
    expect(hit.ageMs).toBe(1000);
  });

  it("некэшируемый инструмент обновлять нельзя", async () => {
    await expect(refreshProxyEntry("vkusvill_cart_link_create", { products: [] })).rejects.toThrow("не кэшируется");
  });
});

describe("спрос на страницы (warm_targets)", () => {
  it("счётчик растёт, самые частые — первыми, забытые отсеиваются по дате", () => {
    recordWarmTarget(db, "a", JSON.stringify({ page: 1 }), "2026-10-01T00:00:00.000Z");
    recordWarmTarget(db, "a", JSON.stringify({ page: 1 }), "2026-10-02T00:00:00.000Z");
    recordWarmTarget(db, "b", JSON.stringify({ page: 2 }), "2026-10-03T00:00:00.000Z");
    const list = listWarmTargets(db, { sinceISO: "2026-09-01T00:00:00.000Z", limit: 10 });
    expect(list.map((t) => [t.key, t.hits])).toEqual([["a", 2], ["b", 1]]);
    expect(list[0].args).toEqual({ page: 1 });
    expect(purgeOldWarmTargets(db, "2026-10-02T12:00:00.000Z")).toBe(1); // "a" последний раз 10-02 00:00
    expect(listWarmTargets(db, { sinceISO: "2026-09-01T00:00:00.000Z", limit: 10 }).map((t) => t.key)).toEqual(["b"]);
  });

  it("уборка БД чистит давно не запрашиваемые сочетания", () => {
    const now = new Date("2026-10-20T00:00:00.000Z");
    recordWarmTarget(db, "old", "{}", "2026-09-01T00:00:00.000Z");
    recordWarmTarget(db, "new", "{}", "2026-10-19T00:00:00.000Z");
    runMaintenance(db, now);
    expect(listWarmTargets(db, { sinceISO: "2020-01-01T00:00:00.000Z", limit: 10 }).map((t) => t.key)).toEqual(["new"]);
  });
});

describe("журнал сборок и уборка", () => {
  it("уборка чистит журнал старше 400 дней, свежие строки остаются", () => {
    const now = new Date("2026-10-20T00:00:00.000Z");
    recordPlanGeneration(db, { telegramUserId: 1, source: "credit", createdAtISO: "2025-01-01T00:00:00.000Z" });
    recordPlanGeneration(db, { telegramUserId: 1, source: "free", createdAtISO: "2026-10-19T00:00:00.000Z" });
    runMaintenance(db, now);
    expect(db.prepare("SELECT source FROM plan_generations").all().map((r) => r.source)).toEqual(["free"]);
  });
});

describe("runWarmupTick", () => {
  it("на пустой базе тянет базовые страницы (не больше RECIPES_PER_TICK за тик) и ставит цены ингредиентов в работу", async () => {
    fetch.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      const q = body.params?.arguments?.q;
      if (body.params?.name === "vkusvill_recipes") return mcpOk(recipesPage(["Лук репчатый", "Морковь"]));
      return mcpOk({ items: [{ xml_id: "1", name: q, price: { current: 50 }, unit: "кг" }] });
    });
    const r = await runWarmupTick(db, { now: Date.now() });
    expect(r.skipped).toBeNull();
    expect(r.refreshedPages).toBe(RECIPES_PER_TICK);
    // цены двух названий получены тем же тиком и лежат в общем кэше
    const prices = getIngredientPricesByName(db, ["Лук репчатый", "Морковь"]);
    expect(prices.get("Лук репчатый")?.matched).toBe(true);
    expect(prices.get("Морковь")?.price).toBe(50);
  });

  it("свежие страницы повторно не тянет; через 4 часа обновляет", async () => {
    fetch.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      return body.params?.name === "vkusvill_recipes" ? mcpOk(recipesPage([])) : mcpOk({ items: [] });
    });
    const t0 = Date.now();
    // за три тика (по RECIPES_PER_TICK страниц) обновятся все 6 базовых страниц
    for (let i = 0; i < 6 / RECIPES_PER_TICK; i++) { await runWarmupTick(db, { now: t0 }); resetUpstreamGate(); }
    const third = await runWarmupTick(db, { now: t0 });
    expect(third.refreshedPages).toBe(0); // все шесть уже свежие
    resetUpstreamGate();
    const later = await runWarmupTick(db, { now: t0 + RECIPES_REFRESH_AFTER_MS + 1000 });
    expect(later.refreshedPages).toBe(RECIPES_PER_TICK);
  });

  it("частые страницы из спроса подогреваются так же, как базовые", async () => {
    const args = { q: "борщ", page: 1, sort: "popularity", id_category_filter: 332 };
    recordWarmTarget(db, proxyCacheKey("vkusvill_recipes", args), JSON.stringify(args), new Date().toISOString());
    fetch.mockResolvedValue(mcpOk(recipesPage([])));
    await runWarmupTick(db, { now: Date.now() });
    const sent = fetch.mock.calls.map(([, o]) => JSON.parse(o.body).params.arguments);
    expect(sent.some((a) => a.q === "борщ")).toBe(true); // идёт раньше базовых — у него есть спрос
  });

  it("уступает пользователям: при загруженном лимите ничего не делает", async () => {
    // забиваем лимит живыми запросами
    fetch.mockResolvedValue(mcpOk({ items: [] }));
    for (let i = 0; i < UPSTREAM_MAX_PER_MINUTE - 5; i++) await callVkusvillCached("vkusvill_products_search", { q: `x${i}` });
    expect(getUpstreamLoad()).toBeGreaterThan(25);
    fetch.mockClear();
    const r = await runWarmupTick(db, { now: Date.now() });
    expect(r.skipped).toBe("busy");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ВкусВилл не отвечает — тик не падает и не молотит все страницы подряд", async () => {
    fetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const r = await runWarmupTick(db, { now: Date.now() });
    expect(r.refreshedPages).toBe(0);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(2); // одна попытка и стоп (не 6)
  });
});

describe("цены: заблаговременное обновление и срок ответа", () => {
  const entry = (name) => ({ name, matched: true, price: 10, productUnit: "кг", xmlId: "1", packageAmount: null, packageUnit: null });

  it("namesNeedingRefresh: нет записи или старше 8 часов", () => {
    const now = Date.now();
    upsertIngredientPrices(db, [entry("свежая")], new Date(now - 1 * H).toISOString());
    upsertIngredientPrices(db, [entry("устаревающая")], new Date(now - (WARM_REFRESH_AFTER_MS + H)).toISOString());
    expect(namesNeedingRefresh(db, ["свежая", "устаревающая", "новая", "новая"], now).sort()).toEqual(["новая", "устаревающая"].sort());
  });

  it("подогрев перекачивает цену, которой 9 часов (ещё в пределах 12), а обычный запрос — нет", async () => {
    const now = Date.now();
    upsertIngredientPrices(db, [entry("лук")], new Date(now - 9 * H).toISOString());
    fetch.mockResolvedValue(mcpOk({ items: [{ xml_id: "2", name: "Лук", price: { current: 99 }, unit: "кг" }] }));
    await resolveIngredientPricesWithCache(db, ["лук"]);
    expect(fetch).not.toHaveBeenCalled();
    await resolveIngredientPricesWithCache(db, ["лук"], { warm: true, maxAgeMs: WARM_REFRESH_AFTER_MS });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getIngredientPricesByName(db, ["лук"]).get("лук").price).toBe(99);
  });

  it("название, запрос по которому не удался, подогрев не повторяет целый час", async () => {
    fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    const t0 = Date.now();
    await resolveIngredientPricesWithCache(db, ["Для заливки:"], { warm: true });
    expect(namesNeedingRefresh(db, ["Для заливки:", "Лук"], t0 + 1000)).toEqual(["Лук"]); // неудавшееся пропущено
    expect(namesNeedingRefresh(db, ["Для заливки:"], t0 + FAILED_NAME_RETRY_AFTER_MS + 1000)).toEqual(["Для заливки:"]); // через час — снова
  });

  it("deadlineMs: что не успели — отдаём как «не найдено», в очередь подогрева; начатое допишется в кэш само", async () => {
    // каждый запрос идёт 300 мс, параллелизм 4, срок 100 мс: успеют начаться первые 4
    fetch.mockImplementation(async (url, opts) => {
      await new Promise((r) => setTimeout(r, 300));
      const q = JSON.parse(opts.body).params.arguments.q;
      return mcpOk({ items: [{ xml_id: "1", name: q, price: { current: 5 }, unit: "кг" }] });
    });
    const names = Array.from({ length: 12 }, (_, i) => `товар${i}`);
    const res = await resolveIngredientPricesWithCache(db, names, { deadlineMs: 100 });
    // первые четыре дошли до запроса и закончились; остальные не начинались
    const matched = names.filter((n) => res.get(n).matched);
    expect(matched.length).toBe(4);
    expect(names.filter((n) => !res.get(n).matched).length).toBe(8);
    expect(getWarmQueueSize()).toBe(8);
    // неначатые не записаны в кэш как «не найдено»
    expect(getIngredientPricesByName(db, names).size).toBe(4);
  });
});
