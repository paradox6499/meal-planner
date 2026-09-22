import { describe, it, expect, vi, afterEach } from "vitest";
import { createPayment, fetchPaymentStatus } from "./yookassa.js";

const CREDS = { shopId: "1460694", secretKey: "test_secret" };

describe("createPayment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("шлёт корректный запрос с Basic-авторизацией и Idempotence-Key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "pay-1", status: "pending", confirmation: { confirmation_url: "https://yookassa.ru/checkout/pay-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPayment(CREDS, {
      amountRub: 299, description: "Съедим Pro — 30 дней", returnUrl: "https://t.me/s_edim_bot", telegramUserId: 42, idempotenceKey: "idem-1", receiptEmail: "user@example.com",
    });

    expect(result).toEqual({ id: "pay-1", status: "pending", confirmationUrl: "https://yookassa.ru/checkout/pay-1" });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.yookassa.ru/v3/payments");
    expect(opts.headers.Authorization).toBe("Basic " + Buffer.from("1460694:test_secret").toString("base64"));
    expect(opts.headers["Idempotence-Key"]).toBe("idem-1");
    const body = JSON.parse(opts.body);
    expect(body.amount).toEqual({ value: "299.00", currency: "RUB" });
    expect(body.metadata).toEqual({ telegram_user_id: "42" });
    expect(body.confirmation).toEqual({ type: "redirect", return_url: "https://t.me/s_edim_bot" });
  });

  // Регрессия на живую жалобу в чате: "ЮKassa createPayment: Receipt is
  // missing or illegal" — магазин подключён с онлайн-кассой (обычная схема
  // для ИП), она требует фискальный чек на каждый платёж по 54-ФЗ. Без
  // receipt.customer (email/телефон) и receipt.items ЮKassa отклоняет запрос
  // целиком, даже если сумма и всё остальное верны.
  it("отправляет receipt с email покупателя и позицией на ту же сумму (обязателен для этого магазина, 54-ФЗ)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "pay-1", status: "pending", confirmation: { confirmation_url: "https://yookassa.ru/checkout/pay-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createPayment(CREDS, {
      amountRub: 299, description: "Съедим Pro — 30 дней", returnUrl: "https://t.me/s_edim_bot", telegramUserId: 42, idempotenceKey: "idem-1", receiptEmail: "user@example.com",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.receipt.customer).toEqual({ email: "user@example.com" });
    expect(body.receipt.items).toEqual([
      { description: "Съедим Pro — 30 дней", quantity: "1.00", amount: { value: "299.00", currency: "RUB" }, vat_code: 1, payment_mode: "full_payment", payment_subject: "service" },
    ]);
  });

  it("бросает читаемую ошибку при отказе ЮKassa", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ code: "invalid_request", description: "Некорректная сумма" }),
    }));
    await expect(
      createPayment(CREDS, { amountRub: 0, description: "x", returnUrl: "x", telegramUserId: 1, idempotenceKey: "x", receiptEmail: "user@example.com" })
    ).rejects.toThrow(/Некорректная сумма/);
  });
});

describe("fetchPaymentStatus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("возвращает статус, оплачено ли, сумму и telegram_user_id из metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "pay-1", status: "succeeded", paid: true, amount: { value: "299.00" }, metadata: { telegram_user_id: "42" } }),
    }));
    const result = await fetchPaymentStatus(CREDS, "pay-1");
    expect(result).toEqual({ id: "pay-1", status: "succeeded", paid: true, amountRub: 299, telegramUserId: 42 });
  });

  it("GET с Basic-авторизацией по правильному URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "pay-1", status: "pending", paid: false, amount: { value: "1" } }) });
    vi.stubGlobal("fetch", fetchMock);
    await fetchPaymentStatus(CREDS, "pay-1");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.yookassa.ru/v3/payments/pay-1");
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Basic " + Buffer.from("1460694:test_secret").toString("base64"));
  });

  it("бросает читаемую ошибку, если платёж не найден", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ code: "not_found", description: "Платёж не найден" }) }));
    await expect(fetchPaymentStatus(CREDS, "unknown")).rejects.toThrow(/не найден/);
  });
});
