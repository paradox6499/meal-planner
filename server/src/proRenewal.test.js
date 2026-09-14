import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, extendUserPro, getUsersWithProExpiringSoon, markRenewalReminderSent } from "./db.js";
import { runProRenewalTick, RENEWAL_REMINDER_WINDOW_MS } from "./proRenewal.js";

vi.mock("./telegram.js", () => ({ sendTelegramMessage: vi.fn() }));
import { sendTelegramMessage } from "./telegram.js";

const NOW = new Date("2026-09-10T09:00:00.000Z");
const NOW_ISO = NOW.toISOString();

describe("getUsersWithProExpiringSoon / runProRenewalTick", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
    vi.clearAllMocks();
  });

  it("находит пользователя, у которого pro_until в пределах окна", async () => {
    extendUserPro(db, 42, { fromISO: NOW_ISO, addDays: 2 }); // истекает через 2 дня — внутри окна в 3 дня
    sendTelegramMessage.mockResolvedValue({ message_id: 1 });

    const results = await runProRenewalTick(db, "BOT:TOKEN", NOW);
    expect(results).toEqual([{ telegramUserId: 42, ok: true }]);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessage.mock.calls[0][1]).toBe(42);
  });

  it("НЕ находит пользователя, у которого pro_until далеко за пределами окна", async () => {
    extendUserPro(db, 42, { fromISO: NOW_ISO, addDays: 20 });
    const due = getUsersWithProExpiringSoon(db, { nowISO: NOW_ISO, windowMs: RENEWAL_REMINDER_WINDOW_MS });
    expect(due).toHaveLength(0);
  });

  it("НЕ находит пользователя, у которого подписка уже истекла", async () => {
    extendUserPro(db, 42, { fromISO: new Date(NOW.getTime() - 10 * 24 * 3_600_000).toISOString(), addDays: 5 }); // истекла 5 дней назад
    const due = getUsersWithProExpiringSoon(db, { nowISO: NOW_ISO, windowMs: RENEWAL_REMINDER_WINDOW_MS });
    expect(due).toHaveLength(0);
  });

  it("не повторяет напоминание об ОДНОМ И ТОМ ЖЕ истечении дважды", async () => {
    extendUserPro(db, 42, { fromISO: NOW_ISO, addDays: 2 });
    sendTelegramMessage.mockResolvedValue({ message_id: 1 });

    await runProRenewalTick(db, "BOT:TOKEN", NOW);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);

    const secondTick = await runProRenewalTick(db, "BOT:TOKEN", new Date(NOW.getTime() + 3_600_000));
    expect(secondTick).toEqual([]);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("после ПРОДЛЕНИЯ подписки (новый, более поздний pro_until) напоминание может прийти снова для нового истечения", async () => {
    extendUserPro(db, 42, { fromISO: NOW_ISO, addDays: 2 });
    markRenewalReminderSent(db, 42, NOW_ISO); // уже напоминали про старое истечение

    // продлили на ещё 30 дней от текущего (ещё не истёкшего) периода
    extendUserPro(db, 42, { fromISO: NOW_ISO, addDays: 30 });

    // и вот наступает окно НОВОГО истечения
    const laterNow = new Date(NOW.getTime() + 29 * 24 * 3_600_000);
    const due = getUsersWithProExpiringSoon(db, { nowISO: laterNow.toISOString(), windowMs: RENEWAL_REMINDER_WINDOW_MS });
    expect(due.map((u) => u.telegram_user_id)).toEqual([42]);
  });

  it("ручной is_pro=1 (тумблер админа) не попадает в список — у него нет даты истечения", async () => {
    // is_pro напрямую, без pro_until — как выставляет server/scripts/set-pro.js
    db.prepare("INSERT INTO users (telegram_user_id, is_pro) VALUES (42, 1)").run();
    const due = getUsersWithProExpiringSoon(db, { nowISO: NOW_ISO, windowMs: RENEWAL_REMINDER_WINDOW_MS });
    expect(due).toHaveLength(0);
  });

  it("ошибка отправки одному пользователю не мешает остальным", async () => {
    extendUserPro(db, 1, { fromISO: NOW_ISO, addDays: 1 });
    extendUserPro(db, 2, { fromISO: NOW_ISO, addDays: 1 });
    sendTelegramMessage.mockImplementation(async (token, chatId) => {
      if (chatId === 1) throw new Error("Forbidden: bot was blocked by the user");
      return { message_id: 1 };
    });

    const results = await runProRenewalTick(db, "BOT:TOKEN", NOW);
    expect(results.find((r) => r.telegramUserId === 1)).toMatchObject({ ok: false });
    expect(results.find((r) => r.telegramUserId === 2)).toMatchObject({ ok: true });
  });
});
