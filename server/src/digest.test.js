import { describe, it, expect, vi, afterEach } from "vitest";
import { openDb, insertEvent } from "./db.js";
import { shouldRunDigest, buildDigestText, runDigest } from "./digest.js";

describe("shouldRunDigest", () => {
  it("false до наступления digestHour по UTC", () => {
    const now = new Date("2026-09-10T08:59:00Z");
    expect(shouldRunDigest(now, null, 9)).toBe(false);
  });

  it("true после digestHour, если дайджест ещё ни разу не отправляли", () => {
    const now = new Date("2026-09-10T09:00:00Z");
    expect(shouldRunDigest(now, null, 9)).toBe(true);
  });

  it("false, если уже отправляли сегодня", () => {
    const now = new Date("2026-09-10T10:00:00Z");
    expect(shouldRunDigest(now, "2026-09-10T09:05:00Z", 9)).toBe(false);
  });

  it("true на следующий день после digestHour", () => {
    const now = new Date("2026-09-11T09:30:00Z");
    expect(shouldRunDigest(now, "2026-09-10T09:05:00Z", 9)).toBe(true);
  });
});

describe("buildDigestText", () => {
  it("честно сообщает, что событий не было", () => {
    const text = buildDigestText({ totalEvents: 0, byName: [], recentErrors: [] }, { sinceISO: "2026-09-09T09:00:00Z", now: new Date("2026-09-10T09:00:00Z") });
    expect(text).toContain("Событий не было");
  });

  it("перечисляет события с человекочитаемыми подписями и последние ошибки", () => {
    const summary = {
      totalEvents: 7,
      byName: [{ event_name: "plan_generated", count: 5 }, { event_name: "app_error", count: 2 }],
      recentErrors: [{ telegramUserId: 42, createdAt: "2026-09-10T08:00:00Z", props: { message: "Cannot read properties of undefined" } }],
    };
    const text = buildDigestText(summary, { sinceISO: "2026-09-09T09:00:00Z", now: new Date("2026-09-10T09:00:00Z") });
    expect(text).toContain("планов собрано: 5");
    expect(text).toContain("❗ ошибок в приложении: 2");
    expect(text).toContain("Cannot read properties of undefined");
  });
});

describe("runDigest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("не шлёт и объясняет причину, если ADMIN_TELEGRAM_ID не задан", async () => {
    const db = openDb(":memory:");
    const result = await runDigest(db, { botToken: "x", adminTelegramId: null }, new Date("2026-09-10T09:00:00Z"));
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/ADMIN_TELEGRAM_ID/);
  });

  it("не шлёт вне часа дайджеста", async () => {
    const db = openDb(":memory:");
    const result = await runDigest(db, { botToken: "x", adminTelegramId: 1, digestHour: 9 }, new Date("2026-09-10T08:00:00Z"));
    expect(result.sent).toBe(false);
  });

  it("шлёт реальный HTTP-запрос к Telegram и запоминает время отправки", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: {} }) });
    vi.stubGlobal("fetch", fetchMock);

    const db = openDb(":memory:");
    insertEvent(db, { telegramUserId: 42, eventName: "plan_generated", props: null, createdAtISO: "2026-09-10T08:30:00Z" });

    const result = await runDigest(db, { botToken: "TOKEN", adminTelegramId: 777, digestHour: 9 }, new Date("2026-09-10T09:30:00Z"));
    expect(result.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot" + "TOKEN" + "/sendMessage",
      expect.objectContaining({ method: "POST" })
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.chat_id).toBe(777);
    expect(sentBody.text).toContain("планов собрано: 1");

    // повторный вызов в тот же день больше не шлёт
    const second = await runDigest(db, { botToken: "TOKEN", adminTelegramId: 777, digestHour: 9 }, new Date("2026-09-10T11:00:00Z"));
    expect(second.sent).toBe(false);
  });
});
