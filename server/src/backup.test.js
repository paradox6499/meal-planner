import { describe, it, expect, vi, afterEach } from "vitest";
import { openDb, saveUserPlan, getLastBackupAt } from "./db.js";
import { shouldRunBackup, runBackup } from "./backup.js";

describe("shouldRunBackup", () => {
  it("true, если бэкапа ещё не было", () => {
    expect(shouldRunBackup(new Date("2026-09-10T09:00:00Z"), null, 24)).toBe(true);
  });

  it("false, если интервал ещё не прошёл", () => {
    expect(shouldRunBackup(new Date("2026-09-10T09:00:00Z"), "2026-09-10T00:00:00Z", 24)).toBe(false);
  });

  it("true, когда интервал прошёл", () => {
    expect(shouldRunBackup(new Date("2026-09-11T01:00:00Z"), "2026-09-10T00:00:00Z", 24)).toBe(true);
  });
});

describe("runBackup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("не шлёт и объясняет причину без ADMIN_TELEGRAM_ID", async () => {
    const db = openDb(":memory:");
    const result = await runBackup(db, { botToken: "x", adminTelegramId: null });
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/ADMIN_TELEGRAM_ID/);
  });

  it("делает VACUUM INTO снимок реальных данных и шлёт его документом, запоминает время", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: {} }) });
    vi.stubGlobal("fetch", fetchMock);

    const db = openDb(":memory:");
    saveUserPlan(db, {
      telegramUserId: 42, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30,
      mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Паста" }],
    });

    const result = await runBackup(db, { botToken: "TOKEN", adminTelegramId: 777, intervalHours: 24 }, new Date("2026-09-10T09:00:00Z"));

    expect(result.sent).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botTOKEN/sendDocument");
    expect(opts.body.get("document").name).toMatch(/^sedim-2026-09-10.*\.db$/);
    expect(getLastBackupAt(db)).toBe("2026-09-10T09:00:00.000Z");
  });

  it("не шлёт повторно до истечения интервала", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: {} }) }));
    const db = openDb(":memory:");
    await runBackup(db, { botToken: "TOKEN", adminTelegramId: 777, intervalHours: 24 }, new Date("2026-09-10T09:00:00Z"));
    const second = await runBackup(db, { botToken: "TOKEN", adminTelegramId: 777, intervalHours: 24 }, new Date("2026-09-10T15:00:00Z"));
    expect(second.sent).toBe(false);
  });

  it("не бросает исключение, если отправка не удалась — сообщает reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const db = openDb(":memory:");
    const result = await runBackup(db, { botToken: "TOKEN", adminTelegramId: 777 }, new Date("2026-09-10T09:00:00Z"));
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/network down/);
    // время бэкапа не должно обновиться при неудаче — иначе следующая попытка отложится напрасно
    expect(getLastBackupAt(db)).toBeNull();
  });
});
