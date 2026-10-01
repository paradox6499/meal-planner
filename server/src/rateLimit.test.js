import { describe, it, expect, beforeEach } from "vitest";
import { isRateLimited, clearRateLimitState, takeBudget } from "./rateLimit.js";

const OPTS = { maxRequests: 3, windowMs: 60_000 };

describe("isRateLimited", () => {
  beforeEach(() => {
    clearRateLimitState();
  });

  it("первые запросы в пределах лимита -> не ограничены", () => {
    expect(isRateLimited("user:1", { ...OPTS, now: 0 })).toBe(false);
    expect(isRateLimited("user:1", { ...OPTS, now: 1000 })).toBe(false);
    expect(isRateLimited("user:1", { ...OPTS, now: 2000 })).toBe(false);
  });

  it("запрос сверх лимита в том же окне -> ограничен", () => {
    isRateLimited("user:1", { ...OPTS, now: 0 });
    isRateLimited("user:1", { ...OPTS, now: 1000 });
    isRateLimited("user:1", { ...OPTS, now: 2000 });
    expect(isRateLimited("user:1", { ...OPTS, now: 3000 })).toBe(true);
  });

  it("новое окно (прошло windowMs) -> счётчик сбрасывается", () => {
    isRateLimited("user:1", { ...OPTS, now: 0 });
    isRateLimited("user:1", { ...OPTS, now: 1000 });
    isRateLimited("user:1", { ...OPTS, now: 2000 });
    expect(isRateLimited("user:1", { ...OPTS, now: 3000 })).toBe(true); // всё ещё то же окно

    // ровно через windowMs после начала окна — новое окно
    expect(isRateLimited("user:1", { ...OPTS, now: 60_000 })).toBe(false);
  });

  it("разные ключи не влияют друг на друга", () => {
    isRateLimited("user:1", { ...OPTS, now: 0 });
    isRateLimited("user:1", { ...OPTS, now: 0 });
    isRateLimited("user:1", { ...OPTS, now: 0 });
    expect(isRateLimited("user:1", { ...OPTS, now: 0 })).toBe(true);
    // другой ключ — свежий счётчик, тот же now
    expect(isRateLimited("user:2", { ...OPTS, now: 0 })).toBe(false);
  });

  it("разные лимиты (maxRequests) для одного и того же key-неймспейса не путаются, если ключи разные", () => {
    // Имитация двух "бакетов" одного пользователя — общий и для /api/prices
    // (см. app.js: readAuthenticatedBody + доп. проверка в /api/prices).
    const strict = { maxRequests: 1, windowMs: 60_000 };
    expect(isRateLimited("general:1", { ...OPTS, now: 0 })).toBe(false);
    expect(isRateLimited("prices:1", { ...strict, now: 0 })).toBe(false);
    expect(isRateLimited("prices:1", { ...strict, now: 0 })).toBe(true); // строгий лимит уже исчерпан
    expect(isRateLimited("general:1", { ...OPTS, now: 0 })).toBe(false); // общий — ещё нет, отдельный счётчик
  });

  it("clearRateLimitState сбрасывает состояние между тестами", () => {
    isRateLimited("user:1", { ...OPTS, now: 0 });
    isRateLimited("user:1", { ...OPTS, now: 0 });
    isRateLimited("user:1", { ...OPTS, now: 0 });
    clearRateLimitState();
    expect(isRateLimited("user:1", { ...OPTS, now: 0 })).toBe(false);
  });
});

describe("takeBudget", () => {
  beforeEach(() => {
    clearRateLimitState();
  });
  const OPTS = { capacity: 10, windowMs: 60_000 };

  it("выдаёт запрошенное, пока хватает бюджета", () => {
    expect(takeBudget("u:1", 4, { ...OPTS, now: 0 })).toBe(4);
    expect(takeBudget("u:1", 6, { ...OPTS, now: 1000 })).toBe(6);
  });

  it("когда бюджет кончается — выдаёт остаток, потом 0", () => {
    takeBudget("u:1", 8, { ...OPTS, now: 0 });
    expect(takeBudget("u:1", 5, { ...OPTS, now: 1000 })).toBe(2);
    expect(takeBudget("u:1", 5, { ...OPTS, now: 2000 })).toBe(0);
  });

  it("новое окно — бюджет восстанавливается; разные ключи независимы", () => {
    takeBudget("u:1", 10, { ...OPTS, now: 0 });
    expect(takeBudget("u:2", 10, { ...OPTS, now: 0 })).toBe(10);
    expect(takeBudget("u:1", 3, { ...OPTS, now: 60_000 })).toBe(3);
  });

  it("clearRateLimitState сбрасывает и бюджеты", () => {
    takeBudget("u:1", 10, { ...OPTS, now: 0 });
    clearRateLimitState();
    expect(takeBudget("u:1", 10, { ...OPTS, now: 0 })).toBe(10);
  });
});
