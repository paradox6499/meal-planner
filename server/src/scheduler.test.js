import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, saveUserPlan, findCandidateSlots, setUserPro, insertEvent, extendUserPro, getUsersDueForFreeNudge } from "./db.js";
import { runReminderTick, runFreeNudgeTick } from "./scheduler.js";

vi.mock("./telegram.js", () => ({
  sendTelegramMessage: vi.fn(),
  buildReminderText: (label, recipe) => `напоминание: ${label} — ${recipe}`,
  buildFreeNudgeText: () => "бесплатный план снова доступен",
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

// Живой вывод из ревью: "лёгкое бесплатное напоминание вернуться" — раньше
// сброс бесплатного лимита проходил тихо, никто не подсказывал пользователю
// прийти собрать план снова.
describe("runFreeNudgeTick", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
    vi.clearAllMocks();
  });

  it("отправляет напоминание тому, у кого лимит только что сбросился, и помечает отправленным", async () => {
    insertEvent(db, { telegramUserId: 1, eventName: "plan_generated", props: null, createdAtISO: "2026-09-03T09:00:00.000Z" }); // ровно 7 дней назад
    sendTelegramMessage.mockResolvedValue({ message_id: 1 });

    const now = new Date("2026-09-10T09:00:00.000Z");
    const results = await runFreeNudgeTick(db, "BOT:TOKEN", now);

    expect(results).toEqual([{ telegramUserId: 1, ok: true }]);
    expect(sendTelegramMessage).toHaveBeenCalledWith("BOT:TOKEN", 1, "бесплатный план снова доступен");

    // повторный тик той же минутой позже не должен слать снова — уже отмечено
    const secondTick = await runFreeNudgeTick(db, "BOT:TOKEN", new Date(now.getTime() + 60000));
    expect(secondTick).toEqual([]);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("не отправляет, если лимит ещё не сбросился (план был недавно)", async () => {
    insertEvent(db, { telegramUserId: 1, eventName: "plan_generated", props: null, createdAtISO: "2026-09-09T09:00:00.000Z" }); // 1 день назад
    const results = await runFreeNudgeTick(db, "BOT:TOKEN", new Date("2026-09-10T09:00:00.000Z"));
    expect(results).toEqual([]);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("не отправляет Pro-пользователю, даже если формально попадает в окно", async () => {
    insertEvent(db, { telegramUserId: 1, eventName: "plan_generated", props: null, createdAtISO: "2026-09-03T09:00:00.000Z" });
    setUserPro(db, 1, true);
    const results = await runFreeNudgeTick(db, "BOT:TOKEN", new Date("2026-09-10T09:00:00.000Z"));
    expect(results).toEqual([]);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("ошибка отправки одному пользователю не мешает остальным и не помечает отправленным", async () => {
    insertEvent(db, { telegramUserId: 1, eventName: "plan_generated", props: null, createdAtISO: "2026-09-03T09:00:00.000Z" });
    insertEvent(db, { telegramUserId: 2, eventName: "plan_generated", props: null, createdAtISO: "2026-09-03T09:00:00.000Z" });
    sendTelegramMessage.mockImplementation(async (token, chatId) => {
      if (chatId === 1) throw new Error("Forbidden: bot was blocked by the user");
      return { message_id: 1 };
    });

    const now = new Date("2026-09-10T09:00:00.000Z");
    const results = await runFreeNudgeTick(db, "BOT:TOKEN", now);
    expect(results.find((r) => r.telegramUserId === 1)).toMatchObject({ ok: false });
    expect(results.find((r) => r.telegramUserId === 2)).toMatchObject({ ok: true });

    const stillDue = getUsersDueForFreeNudge(db, { nowISO: now.toISOString(), freeWindowMs: 7 * 24 * 3_600_000, graceMs: 3 * 24 * 3_600_000 });
    expect(stillDue.map((r) => r.telegram_user_id)).toEqual([1]); // не помечен — сможет повториться
  });
});
