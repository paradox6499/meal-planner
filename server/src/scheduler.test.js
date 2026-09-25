import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, saveUserPlan, findCandidateSlots, setUserPro } from "./db.js";
import { runReminderTick } from "./scheduler.js";

vi.mock("./telegram.js", () => ({
  sendTelegramMessage: vi.fn(),
  buildReminderText: (label, recipe) => `напоминание: ${label} — ${recipe}`,
}));
import { sendTelegramMessage } from "./telegram.js";

describe("runReminderTick", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
    vi.clearAllMocks();
  });

  it("отправляет напоминание, когда наступило окно, и помечает слот отправленным", async () => {
    saveUserPlan(db, {
      telegramUserId: 42, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30,
      mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Паста" }],
    });
    // Живой вывод из ревью: "Напоминания от бота" — Pro-бонус, а
    // findCandidateSlots (db.js) теперь и правда отсекает не-Pro пользователей.
    setUserPro(db, 42, true);
    sendTelegramMessage.mockResolvedValue({ message_id: 1 });

    const now = new Date("2026-09-10T15:35:00.000Z"); // 18:35 МСК, до ужина 25 минут
    const results = await runReminderTick(db, "BOT:TOKEN", now);

    expect(results).toEqual([{ slotId: expect.any(Number), telegramUserId: 42, ok: true }]);
    expect(sendTelegramMessage).toHaveBeenCalledWith("BOT:TOKEN", 42, "напоминание: Ужин — Паста");

    // повторный тик той же минутой позже не должен слать снова — слот уже помечен
    const secondTick = await runReminderTick(db, "BOT:TOKEN", new Date(now.getTime() + 60000));
    expect(secondTick).toEqual([]);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("не отправляет ничего, если окно ещё не наступило", async () => {
    saveUserPlan(db, {
      telegramUserId: 42, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30,
      mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Паста" }],
    });
    setUserPro(db, 42, true); // тест проверяет именно окно времени, а не Pro-фильтр — не смешиваем причины
    const farBefore = new Date("2026-09-10T10:00:00.000Z");
    const results = await runReminderTick(db, "BOT:TOKEN", farBefore);
    expect(results).toEqual([]);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("ошибка отправки одному пользователю не мешает остальным и не помечает слот отправленным", async () => {
    saveUserPlan(db, { telegramUserId: 1, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30, mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "План 1" }] });
    saveUserPlan(db, { telegramUserId: 2, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30, mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "План 2" }] });
    setUserPro(db, 1, true);
    setUserPro(db, 2, true);
    sendTelegramMessage.mockImplementation(async (token, chatId) => {
      if (chatId === 1) throw new Error("Forbidden: bot was blocked by the user");
      return { message_id: 1 };
    });

    const now = new Date("2026-09-10T15:35:00.000Z");
    const results = await runReminderTick(db, "BOT:TOKEN", now);

    expect(results.find((r) => r.telegramUserId === 1)).toMatchObject({ ok: false });
    expect(results.find((r) => r.telegramUserId === 2)).toMatchObject({ ok: true });

    // слот пользователя 1 остался неотправленным (сможет повториться), слот пользователя 2 — помечен
    const stillPending = findCandidateSlots(db, "2026-09-10", "2026-09-11", now.toISOString());
    expect(stillPending.map((s) => s.telegram_user_id)).toEqual([1]);
  });

  // Живой вывод из ревью Pro-плюшек (чат): "Напоминания от бота" рекламируются
  // как Pro-бонус, а фактически отправлялись вообще всем, независимо от
  // тарифа. Сквозной тест через сам runReminderTick (не только findCandidateSlots
  // напрямую) — именно это должен увидеть free-пользователь: тишину, даже
  // когда окно напоминания реально наступило.
  it("free-пользователь (не Pro) не получает напоминание, даже когда окно наступило", async () => {
    saveUserPlan(db, {
      telegramUserId: 42, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30,
      mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Паста" }],
    });
    // Сознательно НЕ вызываем setUserPro — пользователь на бесплатном тарифе.
    const now = new Date("2026-09-10T15:35:00.000Z"); // то же окно, что и в "успешном" тесте выше
    const results = await runReminderTick(db, "BOT:TOKEN", now);
    expect(results).toEqual([]);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});
