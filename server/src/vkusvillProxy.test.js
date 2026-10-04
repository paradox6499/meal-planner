import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseVkusvillCallRequest, callVkusvillCached, clearProxyState, ALLOWED_TOOLS, PROXY_CACHE_TTL_MS } from "./vkusvillProxy.js";
import { resetUpstreamGate, callVkusvillTool, probeVkusvill, UPSTREAM_MAX_PER_MINUTE, queueNamesForWarming, getWarmQueueSize, clearWarmQueue, runPriceWarmTick, resolveIngredientPricesWithCache } from "./vkusvillPrices.js";
import { openDb, getIngredientPricesByName } from "./db.js";

const mcpOk = (data) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify({ ok: true, data }) }] } }) });
const mcpHttp = (status) => ({ ok: false, status, json: async () => ({}) });

beforeEach(() => {
  clearProxyState();
  resetUpstreamGate();
  clearWarmQueue();
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Math.random.mockRestore();
});

describe("parseVkusvillCallRequest", () => {
  it("принимает известный инструмент с объектом args", () => {
    expect(parseVkusvillCallRequest({ tool: "vkusvill_recipes", args: { page: 1 } })).toEqual({ ok: true, tool: "vkusvill_recipes", args: { page: 1 } });
  });
  it("все инструменты, которые реально зовёт фронтенд, разрешены", () => {
    for (const t of ["vkusvill_products_search", "vkusvill_product_analogs", "vkusvill_recipes", "vkusvill_cart_link_create"]) expect(ALLOWED_TOOLS.has(t)).toBe(true);
  });
  it("неизвестный инструмент, не-объект args, слишком большой args — отказ", () => {
    expect(parseVkusvillCallRequest({ tool: "rm_rf", args: {} }).ok).toBe(false);
    expect(parseVkusvillCallRequest({ tool: "vkusvill_recipes" }).ok).toBe(false);
    expect(parseVkusvillCallRequest({ tool: "vkusvill_recipes", args: [1] }).ok).toBe(false);
    expect(parseVkusvillCallRequest({ tool: "vkusvill_recipes", args: { q: "я".repeat(7000) } }).ok).toBe(false);
    expect(parseVkusvillCallRequest(null).ok).toBe(false);
  });
  it("корзина: от 1 до 20 позиций", () => {
    expect(parseVkusvillCallRequest({ tool: "vkusvill_cart_link_create", args: { products: [] } }).ok).toBe(false);
    expect(parseVkusvillCallRequest({ tool: "vkusvill_cart_link_create", args: { products: Array(21).fill({ xml_id: 1, q: 1 }) } }).ok).toBe(false);
    expect(parseVkusvillCallRequest({ tool: "vkusvill_cart_link_create", args: { products: [{ xml_id: 1, q: 1 }] } }).ok).toBe(true);
  });
});

describe("callVkusvillCached", () => {
  it("второй такой же запрос берётся из кэша — во ВкусВилл не ходим", async () => {
    fetch.mockResolvedValue(mcpOk({ items: [1] }));
    const a = await callVkusvillCached("vkusvill_products_search", { q: "молоко" });
    const b = await callVkusvillCached("vkusvill_products_search", { q: "молоко" });
    expect(a).toEqual(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("другие args — другой запрос", async () => {
    fetch.mockResolvedValue(mcpOk({ items: [] }));
    await callVkusvillCached("vkusvill_products_search", { q: "молоко" });
    await callVkusvillCached("vkusvill_products_search", { q: "хлеб" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("одновременные одинаковые запросы склеиваются в один", async () => {
    fetch.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 20)); return mcpOk({ items: [1] }); });
    const results = await Promise.all([1, 2, 3, 4].map(() => callVkusvillCached("vkusvill_recipes", { page: 1 })));
    expect(results.every((r) => r.items.length === 1)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("корзина (создающий вызов) не кэшируется", async () => {
    fetch.mockResolvedValue(mcpOk({ link: "x" }));
    await callVkusvillCached("vkusvill_cart_link_create", { products: [{ xml_id: 1, q: 1 }] });
    await callVkusvillCached("vkusvill_cart_link_create", { products: [{ xml_id: 1, q: 1 }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("устаревшая запись не отдаётся", async () => {
    fetch.mockResolvedValue(mcpOk({ items: [1] }));
    const t0 = 1_000_000;
    await callVkusvillCached("vkusvill_products_search", { q: "a" }, { now: t0 });
    await callVkusvillCached("vkusvill_products_search", { q: "a" }, { now: t0 + PROXY_CACHE_TTL_MS + 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ошибка ВкусВилл не кэшируется — следующий запрос идёт заново", async () => {
    fetch.mockResolvedValueOnce(mcpHttp(403)).mockResolvedValueOnce(mcpOk({ items: [1] }));
    await expect(callVkusvillCached("vkusvill_products_search", { q: "a" })).rejects.toThrow(/HTTP 403/);
    expect((await callVkusvillCached("vkusvill_products_search", { q: "a" })).items).toHaveLength(1);
  });

  it("бюджет живых запросов пользователя исчерпан -> 429 (ownLimit), в сеть не ходим; на попадание в кэш бюджет не тратится", async () => {
    fetch.mockResolvedValue(mcpOk({ items: [1] }));
    const budget = vi.fn().mockReturnValueOnce(1).mockReturnValue(0);
    await callVkusvillCached("vkusvill_products_search", { q: "a" }, { takeLiveBudget: budget });
    await callVkusvillCached("vkusvill_products_search", { q: "a" }, { takeLiveBudget: budget }); // из кэша
    expect(budget).toHaveBeenCalledTimes(1);
    const err = await callVkusvillCached("vkusvill_products_search", { q: "b" }, { takeLiveBudget: budget }).catch((e) => e);
    expect(err.httpStatus).toBe(429);
    expect(err.ownLimit).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("общий ограничитель запросов к ВкусВиллу (60/мин на IP)", () => {
  it(`после ${UPSTREAM_MAX_PER_MINUTE} запросов за минуту следующий получает 429, а через минуту снова можно`, async () => {
    vi.useFakeTimers();
    fetch.mockResolvedValue(mcpOk({ items: [1] }));
    for (let i = 0; i < UPSTREAM_MAX_PER_MINUTE; i++) await callVkusvillTool("vkusvill_products_search", { q: `n${i}` });
    expect(fetch).toHaveBeenCalledTimes(UPSTREAM_MAX_PER_MINUTE);

    const blocked = callVkusvillTool("vkusvill_products_search", { q: "лишний" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await blocked;
    expect(err.httpStatus).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(UPSTREAM_MAX_PER_MINUTE); // лишний в сеть не пошёл

    await vi.advanceTimersByTimeAsync(61_000);
    await callVkusvillTool("vkusvill_products_search", { q: "после паузы" });
    expect(fetch).toHaveBeenCalledTimes(UPSTREAM_MAX_PER_MINUTE + 1);
  });
});

describe("probeVkusvill", () => {
  it("ответ с товарами -> ok", async () => {
    fetch.mockResolvedValue(mcpOk({ items: [{ id: 1 }, { id: 2 }] }));
    const r = await probeVkusvill();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("2");
  });
  it("HTTP 401/403 -> не ok, с кодом", async () => {
    fetch.mockResolvedValue(mcpHttp(403));
    const r = await probeVkusvill();
    expect(r).toMatchObject({ ok: false, httpStatus: 403 });
  });
  it("сеть недоступна -> не ok, без исключения", async () => {
    fetch.mockRejectedValue(new Error("ECONNRESET"));
    const r = await probeVkusvill(50);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/сеть недоступна/);
  }, 20000);
  it("пустой ответ -> не ok", async () => {
    fetch.mockResolvedValue(mcpOk({ items: [] }));
    expect((await probeVkusvill()).ok).toBe(false);
  });
  it("проба не тратит общий лимит (диагностика должна быть честной даже при исчерпанном лимите)", async () => {
    vi.useFakeTimers();
    fetch.mockResolvedValue(mcpOk({ items: [1] }));
    for (let i = 0; i < UPSTREAM_MAX_PER_MINUTE; i++) await callVkusvillTool("vkusvill_products_search", { q: `n${i}` });
    expect((await probeVkusvill()).ok).toBe(true);
  });
});

describe("подогрев цен: что не успели — доделывает фон", () => {
  it("названия сверх потолка ставятся в очередь, тик подогрева кладёт их в кэш и очередь пустеет", async () => {
    const db = openDb(":memory:");
    fetch.mockResolvedValue(mcpOk({ items: [{ xml_id: "1", name: "Товар 500 г", price: { current: 10 }, unit: "шт" }] }));
    await resolveIngredientPricesWithCache(db, ["a1", "a2", "a3", "a4"], { maxLiveFetches: 1 });
    expect(getWarmQueueSize()).toBe(3);

    const { warmed } = await runPriceWarmTick(db, { batch: 10 });
    expect(warmed).toBe(3);
    expect(getWarmQueueSize()).toBe(0);
    expect(getIngredientPricesByName(db, ["a1", "a2", "a3", "a4"]).size).toBe(4);
  });

  it("если ВкусВилл недоступен, подогрев не ставит названия обратно (не молотит впустую)", async () => {
    const db = openDb(":memory:");
    fetch.mockResolvedValue(mcpHttp(403));
    queueNamesForWarming(["x1", "x2"]);
    await runPriceWarmTick(db, { batch: 10 });
    expect(getWarmQueueSize()).toBe(0);
  });

  it("пустая очередь — ничего не делает", async () => {
    expect(await runPriceWarmTick(openDb(":memory:"))).toEqual({ warmed: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
