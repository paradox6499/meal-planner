import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDb, createPendingPayment, getPaymentByYookassaId, getUserPro, getExtraPlanCredits, getProUntil } from "./db.js";
import {
  applyPaymentStatus, paymentIdempotenceKey, reconcilePendingPayments, clearReconcileState,
  notifyPaymentResult, runPaymentReconcileTick, PRO_PERIOD_DAYS, EXTRA_PLAN_PRODUCT,
} from "./payments.js";

const NOW = "2026-09-10T09:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();
const CREDS = { shopId: "1", secretKey: "s" };

const paid = (over = {}) => ({ id: "pay-1", status: "succeeded", paid: true, amountRub: 299, refundedAmountRub: 0, telegramUserId: 42, ...over });
const ykPayment = (over = {}) => ({
  id: "pay-1", status: "succeeded", paid: true, amount: { value: "299.00" }, metadata: { telegram_user_id: "42" }, ...over,
});

describe("paymentIdempotenceKey", () => {
  it("тот же пользователь, товар и минута — один ключ (двойной тап не создаёт второй платёж)", () => {
    expect(paymentIdempotenceKey(42, "pro", { nowMs: 1_200_000 })).toBe(paymentIdempotenceKey(42, "pro", { nowMs: 1_200_000 + 30_000 }));
  });
  it("следующая минута, другой пользователь или другой товар — другой ключ", () => {
    const base = paymentIdempotenceKey(42, "pro", { nowMs: 1_200_000 });
    expect(paymentIdempotenceKey(42, "pro", { nowMs: 1_200_000 + 120_000 })).not.toBe(base);
    expect(paymentIdempotenceKey(43, "pro", { nowMs: 1_200_000 })).not.toBe(base);
    expect(paymentIdempotenceKey(42, EXTRA_PLAN_PRODUCT, { nowMs: 1_200_000 })).not.toBe(base);
  });
  it("email и salt меняют ключ (поправил опечатку в email — не конфликтуем со старым ключом; повтор после отмены — новый ключ)", () => {
    const base = paymentIdempotenceKey(42, "pro", { email: "a@b.ru", nowMs: 1_200_000 });
    expect(paymentIdempotenceKey(42, "pro", { email: "c@d.ru", nowMs: 1_200_000 })).not.toBe(base);
    expect(paymentIdempotenceKey(42, "pro", { email: "a@b.ru", salt: "retry", nowMs: 1_200_000 })).not.toBe(base);
    expect(paymentIdempotenceKey(42, "pro", { email: "a@b.ru", nowMs: 1_200_000 })).toBe(base);
  });
  it("64 символа — максимум, который принимает ЮKassa", () => {
    expect(paymentIdempotenceKey(42, "pro")).toHaveLength(64);
  });
});

describe("applyPaymentStatus", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  const pending = (over = {}) => createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: NOW, ...over });

  it("платёж, которого нет в базе -> unknown, ничего не меняется", () => {
    expect(applyPaymentStatus(db, paid(), { nowISO: NOW }).kind).toBe("unknown");
    expect(getUserPro(db, 42, NOW)).toBe(false);
  });

  it("succeeded по Pro -> продлевает на 30 дней и отдаёт текст подтверждения", () => {
    pending();
    const r = applyPaymentStatus(db, paid(), { nowISO: NOW });
    expect(r.kind).toBe("fulfilled");
    expect(r.chatId).toBe(42);
    expect(r.confirmationText).toContain("Pro активен");
    expect(getProUntil(db, 42, NOW)).toBe(new Date(NOW_MS + PRO_PERIOD_DAYS * 86_400_000).toISOString());
    expect(getPaymentByYookassaId(db, "pay-1").status).toBe("succeeded");
  });

  it("succeeded по extra_plan -> +1 кредит, Pro не выдаётся", () => {
    pending({ amountRub: 59, product: EXTRA_PLAN_PRODUCT });
    const r = applyPaymentStatus(db, paid({ amountRub: 59 }), { nowISO: NOW });
    expect(r.kind).toBe("fulfilled");
    expect(getExtraPlanCredits(db, 42)).toBe(1);
    expect(getUserPro(db, 42, NOW)).toBe(false);
  });

  it("повторное применение того же succeeded ничего не выдаёт второй раз", () => {
    pending({ amountRub: 59, product: EXTRA_PLAN_PRODUCT });
    applyPaymentStatus(db, paid({ amountRub: 59 }), { nowISO: NOW });
    const second = applyPaymentStatus(db, paid({ amountRub: 59 }), { nowISO: NOW });
    expect(second.kind).toBe("noop");
    expect(getExtraPlanCredits(db, 42)).toBe(1);
  });

  it("чужой получатель (metadata) -> owner_mismatch, оплаченное НЕ выдано, статус review", () => {
    pending();
    const r = applyPaymentStatus(db, paid({ telegramUserId: 999 }), { nowISO: NOW });
    expect(r.kind).toBe("owner_mismatch");
    expect(getUserPro(db, 42, NOW)).toBe(false);
    expect(getUserPro(db, 999, NOW)).toBe(false);
    expect(getPaymentByYookassaId(db, "pay-1").status).toBe("review");
    expect(applyPaymentStatus(db, paid({ telegramUserId: 999 }), { nowISO: NOW }).kind).toBe("noop"); // второй алерт не нужен
  });

  it("несовпадение суммы -> amount_mismatch, оплаченное НЕ выдано", () => {
    pending();
    const r = applyPaymentStatus(db, paid({ amountRub: 1 }), { nowISO: NOW });
    expect(r.kind).toBe("amount_mismatch");
    expect(getUserPro(db, 42, NOW)).toBe(false);
    expect(getPaymentByYookassaId(db, "pay-1").status).toBe("review");
  });

  it("canceled по pending -> просто обновляет статус, ничего не выдаёт", () => {
    pending();
    const r = applyPaymentStatus(db, paid({ status: "canceled", paid: false }), { nowISO: NOW });
    expect(r.kind).toBe("status_updated");
    expect(getPaymentByYookassaId(db, "pay-1").status).toBe("canceled");
    expect(getUserPro(db, 42, NOW)).toBe(false);
  });

  it("succeeded-платёж не понижается обратно запоздавшим другим статусом", () => {
    pending();
    applyPaymentStatus(db, paid(), { nowISO: NOW });
    expect(applyPaymentStatus(db, paid({ status: "canceled", paid: false }), { nowISO: NOW }).kind).toBe("noop");
    expect(getPaymentByYookassaId(db, "pay-1").status).toBe("succeeded");
  });

  describe("возвраты", () => {
    it("полный возврат за Pro -> статус refunded и оплаченный срок снимается", () => {
      pending();
      applyPaymentStatus(db, paid(), { nowISO: NOW });
      const r = applyPaymentStatus(db, paid({ refundedAmountRub: 299 }), { nowISO: NOW });
      expect(r.kind).toBe("refunded");
      expect(getPaymentByYookassaId(db, "pay-1").status).toBe("refunded");
      expect(getUserPro(db, 42, "2026-09-10T09:00:01.000Z")).toBe(false);
    });

    it("полный возврат за Pro, когда куплено ещё и раньше — снимается ровно 30 дней, остальное остаётся", () => {
      pending({ yookassaPaymentId: "pay-0" });
      applyPaymentStatus(db, paid({ id: "pay-0" }), { nowISO: NOW });
      pending();
      applyPaymentStatus(db, paid(), { nowISO: NOW });
      expect(getProUntil(db, 42, NOW)).toBe(new Date(NOW_MS + 60 * 86_400_000).toISOString());
      applyPaymentStatus(db, paid({ refundedAmountRub: 299 }), { nowISO: NOW });
      expect(getProUntil(db, 42, NOW)).toBe(new Date(NOW_MS + 30 * 86_400_000).toISOString());
    });

    it("полный возврат за extra_plan -> кредит снимается", () => {
      pending({ amountRub: 59, product: EXTRA_PLAN_PRODUCT });
      applyPaymentStatus(db, paid({ amountRub: 59 }), { nowISO: NOW });
      applyPaymentStatus(db, paid({ amountRub: 59, refundedAmountRub: 59 }), { nowISO: NOW });
      expect(getExtraPlanCredits(db, 42)).toBe(0);
    });

    it("возврат раньше выдачи (платёж ещё pending) -> refunded, ничего не выдано", () => {
      pending();
      applyPaymentStatus(db, paid({ refundedAmountRub: 299 }), { nowISO: NOW });
      expect(getPaymentByYookassaId(db, "pay-1").status).toBe("refunded");
      expect(getUserPro(db, 42, NOW)).toBe(false);
    });

    it("частичный возврат -> partial_refund, ничего автоматически не меняется", () => {
      pending();
      applyPaymentStatus(db, paid(), { nowISO: NOW });
      const r = applyPaymentStatus(db, paid({ refundedAmountRub: 100 }), { nowISO: NOW });
      expect(r.kind).toBe("partial_refund");
      expect(getPaymentByYookassaId(db, "pay-1").status).toBe("succeeded");
      expect(getUserPro(db, 42, NOW)).toBe(true);
    });

    // Перепроверка аудита 04.10.2026, п. 4.2: иначе сверка алертила бы каждые 10 минут двое суток.
    it("частичный возврат по платежу, который у нас ещё pending, -> review (выходит из сверки), оплаченное не выдаётся", () => {
      pending();
      const r = applyPaymentStatus(db, paid({ refundedAmountRub: 100 }), { nowISO: NOW });
      expect(r.kind).toBe("partial_refund");
      expect(getPaymentByYookassaId(db, "pay-1").status).toBe("review");
      expect(getUserPro(db, 42, NOW)).toBe(false);
      expect(applyPaymentStatus(db, paid({ refundedAmountRub: 100 }), { nowISO: NOW }).kind).toBe("noop");
    });

    it("повторное уведомление о том же возврате не снимает срок второй раз", () => {
      pending({ yookassaPaymentId: "pay-0" });
      applyPaymentStatus(db, paid({ id: "pay-0" }), { nowISO: NOW });
      pending();
      applyPaymentStatus(db, paid(), { nowISO: NOW });
      applyPaymentStatus(db, paid({ refundedAmountRub: 299 }), { nowISO: NOW });
      applyPaymentStatus(db, paid({ refundedAmountRub: 299 }), { nowISO: NOW });
      expect(getProUntil(db, 42, NOW)).toBe(new Date(NOW_MS + 30 * 86_400_000).toISOString());
    });
  });
});

describe("reconcilePendingPayments", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
    clearReconcileState();
  });
  afterEach(() => vi.unstubAllGlobals());
  const stubYk = (impl) => vi.stubGlobal("fetch", vi.fn(impl));

  it("зависший pending, который у ЮKassa уже succeeded, — выдаётся без вебхука", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: NOW });
    stubYk(async () => ({ ok: true, json: async () => ykPayment() }));
    const results = await reconcilePendingPayments(db, CREDS, { nowMs: NOW_MS + 60_000 });
    expect(results.map((r) => r.kind)).toEqual(["fulfilled"]);
    expect(getUserPro(db, 42, "2026-09-10T09:02:00.000Z")).toBe(true);
  });

  it("слишком старый pending (> 48 ч) не сверяется", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: NOW });
    stubYk(async () => ({ ok: true, json: async () => ykPayment() }));
    const results = await reconcilePendingPayments(db, CREDS, { nowMs: NOW_MS + 49 * 3_600_000 });
    expect(results).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("не дёргает ЮKassa по одному и тому же платежу чаще minIntervalMs", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: NOW });
    stubYk(async () => ({ ok: true, json: async () => ykPayment({ status: "pending", paid: false }) }));
    await reconcilePendingPayments(db, CREDS, { nowMs: NOW_MS + 1000 });
    await reconcilePendingPayments(db, CREDS, { nowMs: NOW_MS + 5000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await reconcilePendingPayments(db, CREDS, { nowMs: NOW_MS + 20_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("сбой ЮKassa API не бросает исключение и оставляет платёж pending для следующей попытки", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: NOW });
    stubYk(async () => ({ ok: false, json: async () => ({ code: "internal_server_error" }) }));
    const results = await reconcilePendingPayments(db, CREDS, { nowMs: NOW_MS + 1000 });
    expect(results).toEqual([]);
    expect(getPaymentByYookassaId(db, "pay-1").status).toBe("pending");
  });

  it("с telegramUserId сверяет только платежи этого пользователя", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: NOW });
    createPendingPayment(db, { yookassaPaymentId: "pay-2", telegramUserId: 43, amountRub: 299, createdAtISO: NOW });
    stubYk(async (url) => ({ ok: true, json: async () => ykPayment({ id: String(url).split("/").pop(), metadata: { telegram_user_id: "42" } }) }));
    await reconcilePendingPayments(db, CREDS, { telegramUserId: 42, nowMs: NOW_MS + 1000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain("pay-1");
  });
});

describe("notifyPaymentResult", () => {
  afterEach(() => vi.unstubAllGlobals());
  const OPTS = { botToken: "T", adminTelegramId: 777, webAppUrl: "https://example.com/app/" };
  const stubTelegram = (ok = true) => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, json: async () => (ok ? { ok: true, result: {} } : { ok: false, description: "Forbidden" }) };
    }));
    return calls;
  };

  it("fulfilled -> сообщение пользователю с кнопкой, открывающей Mini App", async () => {
    const calls = stubTelegram();
    await notifyPaymentResult({ kind: "fulfilled", chatId: 42, confirmationText: "✅ Оплата прошла" }, OPTS);
    expect(calls).toHaveLength(1);
    expect(calls[0].chat_id).toBe(42);
    expect(calls[0].reply_markup.inline_keyboard[0][0].web_app.url).toBe("https://example.com/app/");
  });

  it("сбой Telegram не бросает исключение", async () => {
    stubTelegram(false);
    await expect(notifyPaymentResult({ kind: "fulfilled", chatId: 42, confirmationText: "x" }, OPTS)).resolves.toBeUndefined();
  });

  it("возврат и подозрительные платежи -> алерт админу, обычные результаты -> тишина", async () => {
    const calls = stubTelegram();
    const existing = { yookassa_payment_id: "pay-1", telegram_user_id: 42 };
    await notifyPaymentResult({ kind: "refunded", existing, detail: "pro, 299 ₽" }, OPTS);
    await notifyPaymentResult({ kind: "amount_mismatch", existing, detail: "x" }, OPTS);
    await notifyPaymentResult({ kind: "unknown", detail: "metadata.telegram_user_id=1" }, OPTS);
    await notifyPaymentResult({ kind: "noop" }, OPTS);
    await notifyPaymentResult({ kind: "status_updated" }, OPTS);
    expect(calls.map((c) => c.chat_id)).toEqual([777, 777, 777]);
    expect(calls[0].text).toContain("Возврат");
  });

  it("без adminTelegramId алерты не отправляются", async () => {
    const calls = stubTelegram();
    await notifyPaymentResult({ kind: "refunded", existing: { yookassa_payment_id: "p", telegram_user_id: 1 }, detail: "x" }, { botToken: "T" });
    expect(calls).toHaveLength(0);
  });
});

describe("runPaymentReconcileTick", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("подхватывает зависший платёж, выдаёт оплаченное и шлёт подтверждение", async () => {
    clearReconcileState();
    const db = openDb(":memory:");
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: NOW });
    const telegram = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      if (String(url).includes("api.yookassa.ru")) return { ok: true, json: async () => ykPayment() };
      telegram.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }));
    const results = await runPaymentReconcileTick(db, CREDS, { botToken: "T" }, NOW_MS + 600_000);
    expect(results.map((r) => r.kind)).toEqual(["fulfilled"]);
    expect(telegram).toHaveLength(1);
    expect(getUserPro(db, 42, "2026-09-10T09:11:00.000Z")).toBe(true);
  });
});
