import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toVkusvillQuantity, searchProducts, createCartLink, clearMcpCache, resolvePrices, parsePackageAmount } from "./vkusvillMcp.js";

// Используется и при сборке реальной корзины, и при пересчёте "Итого за
// продукты" на замену товара (ResultView в App.jsx) — если эта функция
// разойдётся, разойдутся ОБА места одновременно, поэтому важно закрепить
// поведение тестом, а не полагаться на то, что они просто зовут одну функцию.
// Регрессия на живую жалобу "не удалось получить цены почти ни на один
// товар": priceByName резолвился на 100%, но цена блюда выставлялась только
// для ~7% рецептов — причина в том, что почти все товары ВкусВилл продаются
// "поштучно" (unit: "шт" = 1 упаковка), а вес/объём зашит только в название
// ("Фарш из индейки, 500 г").
describe("parsePackageAmount", () => {
  it("достаёт вес/объём из названия товара, переводит кг/л в г/мл", () => {
    expect(parsePackageAmount("Фарш из индейки, 500 г")).toEqual({ amount: 500, unit: "г" });
    expect(parsePackageAmount("Сахар-песок, 1 кг")).toEqual({ amount: 1000, unit: "г" });
    expect(parsePackageAmount("Молоко, 900 мл")).toEqual({ amount: 900, unit: "мл" });
    expect(parsePackageAmount("Масло растительное, 1 л")).toEqual({ amount: 1000, unit: "мл" });
  });

  it("понимает &nbsp; между числом и единицей (как реально приходит от ВкусВилл)", () => {
    expect(parsePackageAmount("Чечевица красная, 450&nbsp;г")).toEqual({ amount: 450, unit: "г" });
  });

  it("дробные значения", () => {
    expect(parsePackageAmount("Творог, 0.5 кг")).toEqual({ amount: 500, unit: "г" });
    expect(parsePackageAmount("Сливки, 0,33 л")).toEqual({ amount: 330, unit: "мл" });
  });

  it("нет распознаваемого веса в названии -> null, не гадает", () => {
    expect(parsePackageAmount("Хлеб бородинский")).toBeNull();
    expect(parsePackageAmount("")).toBeNull();
    expect(parsePackageAmount(null)).toBeNull();
    expect(parsePackageAmount(undefined)).toBeNull();
  });
});

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
    // 400, не 500/429/таймаут — специально НЕ retryable-ошибка здесь, иначе
    // сам вызов внутренне ретраил бы несколько раз (см. отдельный describe
    // ниже про повтор на 5xx/таймаут/сеть) и сбивал бы счётчик fetch.
    fetch.mockResolvedValueOnce({ ok: false, status: 400 });
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
    // Ретраи теперь добавляют случайный джиттер сверху базовой задержки (см.
    // vkusvillMcp.js) — фиксируем Math.random на 0, чтобы задержка равнялась
    // ровно базовому значению и таймеры в тестах продвигались предсказуемо.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Math.random.mockRestore();
  });

  it("повторяет попытку после 429 и в итоге успевает получить успешный ответ", async () => {
    vi.useFakeTimers();
    fetch
      .mockResolvedValueOnce(mockMcpError(RATE_LIMIT_ERROR))
      .mockResolvedValueOnce(mockMcpResponse({ items: [{ xml_id: 1, name: "Молоко" }] }));
    const promise = searchProducts({ q: "молоко" });
    await vi.advanceTimersByTimeAsync(700); // первая задержка ретрая
    const result = await promise;
    expect(result.items[0].name).toBe("Молоко");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("после исчерпания попыток на постоянном 429 всё равно бросает читаемую ошибку", async () => {
    vi.useFakeTimers();
    fetch.mockResolvedValue(mockMcpError(RATE_LIMIT_ERROR));
    const promise = searchProducts({ q: "молоко" });
    const assertion = expect(promise).rejects.toThrow(/лимит запросов/);
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(1600);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(4); // исходная попытка + 3 ретрая
  });

  it("не ретраит ошибки, отличные от 429 (например, некорректный запрос)", async () => {
    fetch.mockResolvedValue(mockMcpError({ code: "invalid_input", message: "Некорректный id товара", http_status: 400, retryable: false }));
    await expect(searchProducts({ q: "молоко" })).rejects.toThrow(/Некорректный id товара/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// Регрессия: раньше повторялся ТОЛЬКО 429 — таймаут/сетевой сбой/5xx
// проваливались с первой же попытки без единого ретрая, хотя эти ошибки
// обычно временные (перегрузка на секунду-две, моргнувшее соединение) не
// меньше, чем rate-limit.
describe("повтор запроса при таймауте/сетевом сбое/5xx — те же причины, что и 429, раньше не ретраились вовсе", () => {
  beforeEach(() => {
    clearMcpCache();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Math.random.mockRestore();
  });

  it("повторяет попытку после таймаута (AbortError) и получает успешный ответ", async () => {
    vi.useFakeTimers();
    const abortErr = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    fetch.mockRejectedValueOnce(abortErr).mockResolvedValueOnce(mockMcpResponse({ items: [{ xml_id: 1, name: "Молоко" }] }));
    const promise = searchProducts({ q: "молоко" });
    await vi.advanceTimersByTimeAsync(700);
    const result = await promise;
    expect(result.items[0].name).toBe("Молоко");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("повторяет попытку после сетевой ошибки (не AbortError) и получает успешный ответ", async () => {
    vi.useFakeTimers();
    fetch.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(mockMcpResponse({ items: [{ xml_id: 1, name: "Молоко" }] }));
    const promise = searchProducts({ q: "молоко" });
    await vi.advanceTimersByTimeAsync(700);
    const result = await promise;
    expect(result.items[0].name).toBe("Молоко");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("повторяет попытку после HTTP 503 и получает успешный ответ", async () => {
    vi.useFakeTimers();
    fetch.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(mockMcpResponse({ items: [{ xml_id: 1, name: "Молоко" }] }));
    const promise = searchProducts({ q: "молоко" });
    await vi.advanceTimersByTimeAsync(700);
    const result = await promise;
    expect(result.items[0].name).toBe("Молоко");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("НЕ повторяет попытку после HTTP 400/404 (клиентская ошибка, не временная)", async () => {
    fetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(searchProducts({ q: "молоко" })).rejects.toThrow(/HTTP 404/);
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

  // Регрессия: раньше проваленный (после исчерпания ретраев) запрос терял
  // имя ингредиента — падал в результат как {matched:false, name:"?"},
  // хотя на итоговую сумму это и не влияло, диагностировать "какой именно
  // ингредиент не нашёлся" по логам было невозможно.
  it("проваленный запрос сохраняет исходное имя ингредиента, а не '?'", async () => {
    fetch.mockResolvedValue({ ok: false, status: 400 }); // не retryable (не 429/5xx) — падает сразу, без ожидания ретраев
    const items = [{ name: "Куриное филе", amount: 1, unit: "шт" }, { name: "Гречка", amount: 1, unit: "шт" }];
    const resolved = await resolvePrices(items);
    expect(resolved).toEqual([
      { matched: false, name: "Куриное филе" },
      { matched: false, name: "Гречка" },
    ]);
  });

  // Регрессия на живую жалобу "не удалось получить цены почти ни на один
  // товар" — см. parsePackageAmount выше за полным объяснением.
  it("товар 'шт' с весом в названии -> packageAmount/packageUnit распознаны", async () => {
    fetch.mockResolvedValue(mockMcpResponse({ items: [{ xml_id: 1, name: "Фарш из индейки, 500&nbsp;г", price: { current: 443 }, unit: "шт" }] }));
    const [resolved] = await resolvePrices([{ name: "Фарш из индейки", amount: 1, unit: "шт" }]);
    expect(resolved.packageAmount).toBe(500);
    expect(resolved.packageUnit).toBe("г");
  });

  it("товар уже на вес/объём (не 'шт') -> packageAmount не парсится (незачем)", async () => {
    fetch.mockResolvedValue(mockMcpResponse({ items: [{ xml_id: 1, name: "Морковь мытая, 500 г", price: { current: 60 }, unit: "кг" }] }));
    const [resolved] = await resolvePrices([{ name: "Морковь", amount: 1, unit: "шт" }]);
    expect(resolved.packageAmount).toBeNull();
    expect(resolved.packageUnit).toBeNull();
  });

  it("товар 'шт' без распознаваемого веса в названии -> packageAmount null, не падает", async () => {
    fetch.mockResolvedValue(mockMcpResponse({ items: [{ xml_id: 1, name: "Хлеб бородинский", price: { current: 80 }, unit: "шт" }] }));
    const [resolved] = await resolvePrices([{ name: "Хлеб", amount: 1, unit: "шт" }]);
    expect(resolved.packageAmount).toBeNull();
    expect(resolved.packageUnit).toBeNull();
  });
});
