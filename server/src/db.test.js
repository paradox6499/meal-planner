import { describe, it, expect, beforeEach } from "vitest";
import { openDb, saveUserPlan, findCandidateSlots, markReminderSent } from "./db.js";

describe("db", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:"); // без файла на диске — чистая БД на каждый тест
  });

  it("сохраняет план и настройки пользователя", () => {
    saveUserPlan(db, {
      telegramUserId: 42,
      timezoneOffsetMinutes: 180,
      reminderLeadMinutes: 30,
      mealSlots: [
        { scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Паста" },
      ],
    });
    const rows = findCandidateSlots(db, "2026-09-10", "2026-09-11");
    expect(rows).toHaveLength(1);
    expect(rows[0].recipe_name).toBe("Паста");
    expect(rows[0].timezone_offset_minutes).toBe(180);
    expect(rows[0].reminder_lead_minutes).toBe(30);
  });

  it("повторное сохранение плана заменяет предыдущий целиком (один активный план на пользователя)", () => {
    saveUserPlan(db, {
      telegramUserId: 42, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30,
      mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Старый план" }],
    });
    saveUserPlan(db, {
      telegramUserId: 42, timezoneOffsetMinutes: 180, reminderLeadMinutes: 45,
      mealSlots: [{ scheduledDate: "2026-09-17", mealType: "dinner", mealLabel: "Ужин", mealTime: "20:00", recipeName: "Новый план" }],
    });
    const oldWeek = findCandidateSlots(db, "2026-09-10", "2026-09-11");
    const newWeek = findCandidateSlots(db, "2026-09-17", "2026-09-18");
    expect(oldWeek).toHaveLength(0);
    expect(newWeek).toHaveLength(1);
    expect(newWeek[0].recipe_name).toBe("Новый план");
    expect(newWeek[0].reminder_lead_minutes).toBe(45); // настройки тоже обновились
  });

  it("не путает планы разных пользователей", () => {
    saveUserPlan(db, { telegramUserId: 1, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30, mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "План юзера 1" }] });
    saveUserPlan(db, { telegramUserId: 2, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30, mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "План юзера 2" }] });
    const rows = findCandidateSlots(db, "2026-09-10", "2026-09-11");
    expect(rows.map((r) => r.recipe_name).sort()).toEqual(["План юзера 1", "План юзера 2"]);
  });

  it("markReminderSent исключает слот из следующей выборки кандидатов", () => {
    saveUserPlan(db, { telegramUserId: 42, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30, mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Паста" }] });
    const [slot] = findCandidateSlots(db, "2026-09-10", "2026-09-11");
    markReminderSent(db, slot.id, new Date().toISOString());
    expect(findCandidateSlots(db, "2026-09-10", "2026-09-11")).toHaveLength(0);
  });

  it("не откатывает всё сохранение при ошибке (транзакция) — старый план остаётся нетронутым", () => {
    saveUserPlan(db, { telegramUserId: 42, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30, mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Рабочий план" }] });
    expect(() =>
      saveUserPlan(db, {
        telegramUserId: 42, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30,
        mealSlots: [{ scheduledDate: "2026-09-17", mealType: null, mealLabel: "Ужин", mealTime: "20:00", recipeName: "Сломанный план" }], // meal_type NOT NULL — упадёт
      })
    ).toThrow();
    const rows = findCandidateSlots(db, "2026-09-10", "2026-09-11");
    expect(rows).toHaveLength(1);
    expect(rows[0].recipe_name).toBe("Рабочий план");
  });
});
