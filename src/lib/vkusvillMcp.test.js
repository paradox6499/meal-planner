import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toVkusvillQuantity, searchProducts, createCartLink, clearMcpCache, resolvePrices } from "./vkusvillMcp.js";

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

// Живой пример ответа ВкусВилл на реальный rate-limit (зафиксировано вживую
// в чате): inner.error.retryable === false, но ВЕРХНИЙ уровень (inner.code /
// inner.retryable) говорит другое — единственное надёжное поле здесь
// http_status. mockMcpError воспроизводит именно эту форму ответа.
function mockMcpError(errorObj, topLevelExtra = {}) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify({ ok: false, error: errorObj, ...topLevelExtra }) }] } }),
  };
}
const RATE_LIMIT_ERROR = { code: "invalid_input", message: "Превышен лимит запросов, попробуйте позже", http_status: 429, retryable: false };

describe("повтор запроса при 429 (rate limit) — регрессия: 'Итого' схлопывалось в 0 ₽ после реального rate-limit ВкусВилл", () => {
  beforeEach(() => {
    clearMcpCache();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("повторяет попытку после 429 и в итоге успевает получить успешный ответ", async () => {
    vi.useFakeTimers();
    fetch
      .mockResolvedValueOnce(mockMcpError(RATE_LIMIT_ERROR))
      .mockResolvedValueOnce(mockMcpResponse({ items: [{ xml_id: 1, name: "Молоко" }] }));
    const promise = searchProducts({ q: "молоко" });
    await vi.advanceTimersByTimeAsync(600); // первая задержка ретрая
    const result = await promise;
    expect(result.items[0].name).toBe("Молоко");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("после исчерпания попыток на постоянном 429 всё равно бросает читаемую ошибку", async () => {
    vi.useFakeTimers();
    fetch.mockResolvedValue(mockMcpError(RATE_LIMIT_ERROR));
    const promise = searchProducts({ q: "молоко" });
    const assertion = expect(promise).rejects.toThrow(/лимит запросов/);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(3); // исходная попытка + 2 ретрая
  });

  it("не ретраит ошибки, отличные от 429 (например, некорректный запрос)", async () => {
    fetch.mockResolvedValue(mockMcpError({ code: "invalid_input", message: "Некорректный id товара", http_status: 400, retryable: false }));
    await expect(searchProducts({ q: "молоко" })).rejects.toThrow(/Некорректный id товара/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePrices — ограничение параллелизма (регрессия: 40 одновременных запросов triggers rate-limit)", () => {
  beforeEach(() => {
    clearMcpCache();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("никогда не держит больше 6 запросов в полёте одновременно", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    fetch.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 4));
      inFlight--;
      return mockMcpResponse({ items: [{ xml_id: 1, name: "товар", price: { current: 10 }, unit: "шт" }] });
    });
    const items = Array.from({ length: 20 }, (_, i) => ({ name: `товар${i}`, amount: 1, unit: "шт" }));
    await resolvePrices(items);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(fetch).toHaveBeenCalledTimes(20); // все всё равно обработаны, просто волнами
  });

  it("результат для каждого товара приходит в правильном порядке несмотря на параллельность", async () => {
    fetch.mockImplementation(async (url, opts) => {
      const q = JSON.parse(opts.body).params.arguments.q;
      return mockMcpResponse({ items: [{ xml_id: 1, name: q, price: { current: 5 }, unit: "шт" }] });
    });
    const items = Array.from({ length: 10 }, (_, i) => ({ name: `товар${i}`, amount: 1, unit: "шт" }));
    const resolved = await resolvePrices(items);
    expect(resolved.map((r) => r.name)).toEqual(items.map((it) => it.name));
  });
});
