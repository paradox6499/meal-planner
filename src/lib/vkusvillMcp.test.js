import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toVkusvillQuantity, searchProducts, createCartLink, clearMcpCache } from "./vkusvillMcp.js";

// Используется и при сборке реальной корзины, и при пересчёте "Итого за
// продукты" на замену товара (ResultView в App.jsx) — если эта функция
// разойдётся, разойдутся ОБА места одновременно, поэтому важно закрепить
// поведение тестом, а не полагаться на то, что они просто зовут одну функцию.
describe("toVkusvillQuantity", () => {
  it("для наших ингредиентов в штуках берёт округлённое количество как есть", () => {
    expect(toVkusvillQuantity(3, "шт", "кг")).toBe(3);
    expect(toVkusvillQuantity(2.4, "шт", "шт")).toBe(2); // округление
  });

  it("для товара, продающегося на вес/объём (кг/л), переводит наши граммы/мл в кг/л", () => {
    expect(toVkusvillQuantity(2000, "г", "кг")).toBe(2); // 2000г -> 2кг
    expect(toVkusvillQuantity(500, "мл", "л")).toBe(0.5);
  });

  it("для товара, продающегося поштучно за г/мл (наша же единица), берёт округлённое количество", () => {
    expect(toVkusvillQuantity(15, "г", "г")).toBe(15);
  });

  it("клэмпит в диапазон [0.01, 40] — лимиты ВкусВилл на количество за одну позицию", () => {
    expect(toVkusvillQuantity(100000, "г", "кг")).toBe(40);
    expect(toVkusvillQuantity(0, "г", "кг")).toBe(0.01);
  });

  it("для незнакомой комбинации единиц не падает — возвращает 1 упаковку по умолчанию", () => {
    expect(toVkusvillQuantity(200, "г", "неизвестная-единица")).toBe(1);
  });
});

// Кэш read-only вызовов (см. комментарий у CACHEABLE_TOOLS в vkusvillMcp.js) —
// завели после реального rate-limit на этой неделе: "Заказать" почти всегда
// ищет те же названия, что секунды назад уже искались при сборке плана.
// Мокаем global.fetch напрямую (не сам callTool — он не экспортирован
// намеренно, тестируем через публичное API, как его вызывает остальной код).
function mockMcpResponse(data) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify({ ok: true, data }) }] } }),
  };
}

describe("кэширование read-only вызовов", () => {
  beforeEach(() => {
    clearMcpCache();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("одинаковый запрос второй раз не уходит в сеть — берётся из кэша", async () => {
    fetch.mockResolvedValue(mockMcpResponse({ items: [{ xml_id: 1, name: "Молоко" }] }));
    const a = await searchProducts({ q: "молоко" });
    const b = await searchProducts({ q: "молоко" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("разные запросы кэшируются отдельно друг от друга", async () => {
    fetch.mockResolvedValue(mockMcpResponse({ items: [] }));
    await searchProducts({ q: "молоко" });
    await searchProducts({ q: "хлеб" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("создающий вызов (cart_link_create) не кэшируется — второй раз тоже уходит в сеть", async () => {
    fetch.mockResolvedValue(mockMcpResponse({ link: "https://vkusvill.ru/cart/123" }));
    await createCartLink([{ xml_id: 1, q: 1 }]);
    await createCartLink([{ xml_id: 1, q: 1 }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("после истечения TTL запрос повторяется", async () => {
    vi.useFakeTimers();
    fetch.mockResolvedValue(mockMcpResponse({ items: [] }));
    await searchProducts({ q: "молоко" });
    vi.advanceTimersByTime(11 * 60 * 1000); // TTL — 10 минут
    await searchProducts({ q: "молоко" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("неудачный вызов не попадает в кэш — следующий такой же запрос повторяет попытку", async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(searchProducts({ q: "молоко" })).rejects.toThrow();
    fetch.mockResolvedValueOnce(mockMcpResponse({ items: [] }));
    await expect(searchProducts({ q: "молоко" })).resolves.toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("clearMcpCache() сбрасывает кэш — следующий запрос снова идёт в сеть", async () => {
    fetch.mockResolvedValue(mockMcpResponse({ items: [] }));
    await searchProducts({ q: "молоко" });
    clearMcpCache();
    await searchProducts({ q: "молоко" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
