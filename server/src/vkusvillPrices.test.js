import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDb, getIngredientPricesByName, upsertIngredientPrices } from "./db.js";
import { resolveIngredientPricesWithCache, MATCHED_TTL_MS, NOT_FOUND_TTL_MS } from "./vkusvillPrices.js";

function mockMcpResponse(data) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify({ ok: true, data }) }] } }) };
}
function mockMcpError(errorObj) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify({ ok: false, error: errorObj }) }] } }) };
}
const RATE_LIMIT_ERROR = { code: "invalid_input", message: "Превышен лимит запросов, попробуйте позже", http_status: 429 };

describe("resolveIngredientPricesWithCache", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Math.random.mockRestore();
  });

  it("свежая запись в кэше — не ходит в сеть вообще", async () => {
    upsertIngredientPrices(db, [{ name: "Лук", matched: true, price: 58, productUnit: "кг", xmlId: "1" }], new Date().toISOString());
    const result = await resolveIngredientPricesWithCache(db, ["Лук"]);
    expect(result.get("Лук")).toEqual({ matched: true, price: 58, productUnit: "кг", xmlId: "1", packageAmount: null, packageUnit: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("нет в кэше — идёт живьём и сохраняет результат для следующего раза", async () => {
    fetch.mockResolvedValue(mockMcpResponse({ items: [{ xml_id: "9", name: "Гречка", price: { current: 95 }, unit: "кг" }] }));
    const result = await resolveIngredientPricesWithCache(db, ["Гречка"]);
    expect(result.get("Гречка")).toEqual({ matched: true, price: 95, productUnit: "кг", xmlId: "9", packageAmount: null, packageUnit: null });
    expect(fetch).toHaveBeenCalledTimes(1);

    // теперь в кэше — повторный вызов не должен снова идти в сеть
    fetch.mockClear();
    const second = await resolveIngredientPricesWithCache(db, ["Гречка"]);
    expect(second.get("Гречка")).toEqual({ matched: true, price: 95, productUnit: "кг", xmlId: "9", packageAmount: null, packageUnit: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("товар не найден в каталоге — кэширует matched:false тоже", async () => {
    fetch.mockResolvedValue(mockMcpResponse({ items: [] }));
    const result = await resolveIngredientPricesWithCache(db, ["Несуществующий ингредиент"]);
    expect(result.get("Несуществующий ингредиент")).toEqual({ matched: false, price: null, productUnit: null, xmlId: null, packageAmount: null, packageUnit: null });

    const cached = getIngredientPricesByName(db, ["Несуществующий ингредиент"]);
    expect(cached.get("Несуществующий ингредиент").matched).toBe(false);
  });

  it("устаревшая matched-запись (старше MATCHED_TTL_MS) — переспрашивает живьём", async () => {
    const staleAt = new Date(Date.now() - MATCHED_TTL_MS - 1000).toISOString();
    upsertIngredientPrices(db, [{ name: "Молоко", matched: true, price: 80, productUnit: "л", xmlId: "old" }], staleAt);
    fetch.mockResolvedValue(mockMcpResponse({ items: [{ xml_id: "new", name: "Молоко", price: { current: 90 }, unit: "л" }] }));

    const result = await resolveIngredientPricesWithCache(db, ["Молоко"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.get("Молоко")).toEqual({ matched: true, price: 90, productUnit: "л", xmlId: "new", packageAmount: null, packageUnit: null });
  });

  it("устаревшая matched:false запись живёт МЕНЬШЕ (NOT_FOUND_TTL_MS < MATCHED_TTL_MS) — переспрашивает раньше, чем matched:true", async () => {
    const between = new Date(Date.now() - NOT_FOUND_TTL_MS - 1000).toISOString(); // старше not-found TTL, но моложе matched TTL
    upsertIngredientPrices(db, [{ name: "Специи", matched: false, price: null, productUnit: null, xmlId: null }], between);
    fetch.mockResolvedValue(mockMcpResponse({ items: [{ xml_id: "1", name: "Специи набор", price: { current: 40 }, unit: "шт" }] }));

    const result = await resolveIngredientPricesWithCache(db, ["Специи"]);
    expect(fetch).toHaveBeenCalledTimes(1); // раньше matched:true с тем же возрастом не переспросил бы вообще
    expect(result.get("Специи").matched).toBe(true);
  });

  it("живой запрос не удался после исчерпания ретраев — не кэширует провал, отдаёт устаревшую запись, если она была", async () => {
    const staleAt = new Date(Date.now() - MATCHED_TTL_MS - 1000).toISOString();
    upsertIngredientPrices(db, [{ name: "Сыр", matched: true, price: 500, productUnit: "кг", xmlId: "old-sыр" }], staleAt);
    vi.useFakeTimers();
    fetch.mockResolvedValue(mockMcpError(RATE_LIMIT_ERROR));

    const promise = resolveIngredientPricesWithCache(db, ["Сыр"]);
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(1600);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    // отдаёт устаревшую, но не пропавшую совсем цену — честнее, чем "нет цены" при временном сбое
    expect(result.get("Сыр")).toEqual({ matched: true, price: 500, productUnit: "кг", xmlId: "old-sыр", packageAmount: null, packageUnit: null });
    // провал НЕ переписал кэш — там всё ещё старая запись с тем же updated_at
    const cached = getIngredientPricesByName(db, ["Сыр"]);
    expect(cached.get("Сыр").updatedAt).toBe(staleAt);
  });

  it("живой запрос не удался и в кэше вообще ничего не было — matched:false, без записи в кэш", async () => {
    vi.useFakeTimers();
    fetch.mockResolvedValue(mockMcpError(RATE_LIMIT_ERROR));
    const promise = resolveIngredientPricesWithCache(db, ["Совсем новый ингредиент"]);
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(1600);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result.get("Совсем новый ингредиент")).toEqual({ matched: false, price: null, productUnit: null, xmlId: null, packageAmount: null, packageUnit: null });
    expect(getIngredientPricesByName(db, ["Совсем новый ингредиент"]).size).toBe(0);
  });

  it("повторяющиеся имена во входном списке — резолвится и запрашивается только один раз", async () => {
    fetch.mockResolvedValue(mockMcpResponse({ items: [{ xml_id: "1", name: "Яйцо", price: { current: 8 }, unit: "шт" }] }));
    const result = await resolveIngredientPricesWithCache(db, ["Яйцо", "Яйцо", "Яйцо"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(1);
  });

  it("пустой список -> пустая карта, без сети", async () => {
    const result = await resolveIngredientPricesWithCache(db, []);
    expect(result.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  // Регрессия на живую жалобу "не удалось получить цены почти ни на один
  // товар": подавляющее большинство обычных товаров ВкусВилл продаются
  // "поштучно" (unit: "шт" = 1 упаковка), а вес зашит только в название.
  it("товар 'шт' с весом в названии -> packageAmount распознан и попадает в кэш", async () => {
    fetch.mockResolvedValue(mockMcpResponse({ items: [{ xml_id: "1", name: "Фарш из индейки, 500&nbsp;г", price: { current: 443 }, unit: "шт" }] }));
    const result = await resolveIngredientPricesWithCache(db, ["Фарш из индейки"]);
    expect(result.get("Фарш из индейки")).toEqual({ matched: true, price: 443, productUnit: "шт", xmlId: "1", packageAmount: 500, packageUnit: "г" });

    // и переживает попадание в кэш (не теряется при повторном чтении)
    fetch.mockClear();
    const second = await resolveIngredientPricesWithCache(db, ["Фарш из индейки"]);
    expect(second.get("Фарш из индейки")).toEqual({ matched: true, price: 443, productUnit: "шт", xmlId: "1", packageAmount: 500, packageUnit: "г" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
