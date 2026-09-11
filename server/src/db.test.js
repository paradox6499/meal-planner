import { describe, it, expect, beforeEach } from "vitest";
import {
  openDb, saveUserPlan, findCandidateSlots, markReminderSent,
  insertEvent, summarizeEventsSince, getLastDigestAt, setLastDigestAt,
  getLastBackupAt, setLastBackupAt,
  setUserPro, getUserPro, countPlanGenerationsSince, savePlanHistory, listPlanHistory,
  saveFeedback, listRecentFeedback,
} from "./db.js";

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

describe("events / дайджест", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("insertEvent + summarizeEventsSince группирует по имени события и считает total", () => {
    insertEvent(db, { telegramUserId: 1, eventName: "plan_generated", props: null, createdAtISO: "2026-09-10T09:00:00Z" });
    insertEvent(db, { telegramUserId: 2, eventName: "plan_generated", props: null, createdAtISO: "2026-09-10T09:05:00Z" });
    insertEvent(db, { telegramUserId: 1, eventName: "app_error", props: { message: "boom" }, createdAtISO: "2026-09-10T09:10:00Z" });

    const summary = summarizeEventsSince(db, "2026-09-10T00:00:00Z");
    expect(summary.totalEvents).toBe(3);
    expect(summary.byName.find((r) => r.event_name === "plan_generated").count).toBe(2);
    expect(summary.recentErrors).toHaveLength(1);
    expect(summary.recentErrors[0].props.message).toBe("boom");
  });

  it("summarizeEventsSince не учитывает события ДО sinceISO", () => {
    insertEvent(db, { telegramUserId: 1, eventName: "plan_generated", props: null, createdAtISO: "2026-09-09T09:00:00Z" });
    const summary = summarizeEventsSince(db, "2026-09-10T00:00:00Z");
    expect(summary.totalEvents).toBe(0);
  });

  it("telegramUserId необязателен (анонимное событие сохраняется)", () => {
    expect(() => insertEvent(db, { telegramUserId: null, eventName: "app_error", props: null, createdAtISO: "2026-09-10T09:00:00Z" })).not.toThrow();
  });

  it("getLastDigestAt изначально null, setLastDigestAt перезаписывает (upsert)", () => {
    expect(getLastDigestAt(db)).toBeNull();
    setLastDigestAt(db, "2026-09-10T09:00:00Z");
    expect(getLastDigestAt(db)).toBe("2026-09-10T09:00:00Z");
    setLastDigestAt(db, "2026-09-11T09:00:00Z");
    expect(getLastDigestAt(db)).toBe("2026-09-11T09:00:00Z");
  });

  it("getLastBackupAt изначально null, setLastBackupAt перезаписывает (upsert), независимо от digest_state", () => {
    expect(getLastBackupAt(db)).toBeNull();
    setLastDigestAt(db, "2026-09-10T09:00:00Z");
    expect(getLastBackupAt(db)).toBeNull(); // разные таблицы, не путаются друг с другом
    setLastBackupAt(db, "2026-09-10T10:00:00Z");
    expect(getLastBackupAt(db)).toBe("2026-09-10T10:00:00Z");
    setLastBackupAt(db, "2026-09-11T10:00:00Z");
    expect(getLastBackupAt(db)).toBe("2026-09-11T10:00:00Z");
  });
});

describe("Pro-статус", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("по умолчанию пользователь не Pro, в том числе не существующий вовсе", () => {
    expect(getUserPro(db, 999)).toBe(false);
  });

  it("setUserPro создаёт строку пользователя, если её ещё не было (до первого плана)", () => {
    setUserPro(db, 42, true);
    expect(getUserPro(db, 42)).toBe(true);
  });

  it("setUserPro не затирает существующие настройки пользователя (timezone/reminderLead)", () => {
    saveUserPlan(db, { telegramUserId: 42, timezoneOffsetMinutes: 180, reminderLeadMinutes: 45, mealSlots: [{ scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Паста" }] });
    setUserPro(db, 42, true);
    const rows = findCandidateSlots(db, "2026-09-10", "2026-09-11");
    expect(rows[0].reminder_lead_minutes).toBe(45); // не сброшено на дефолт
    expect(getUserPro(db, 42)).toBe(true);
  });

  it("setUserPro(false) снимает статус", () => {
    setUserPro(db, 42, true);
    setUserPro(db, 42, false);
    expect(getUserPro(db, 42)).toBe(false);
  });
});

describe("countPlanGenerationsSince", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("считает только 'plan_generated' конкретного пользователя после sinceISO", () => {
    insertEvent(db, { telegramUserId: 1, eventName: "plan_generated", props: null, createdAtISO: "2026-09-10T09:00:00Z" });
    insertEvent(db, { telegramUserId: 1, eventName: "plan_generated", props: null, createdAtISO: "2026-09-09T09:00:00Z" }); // до sinceISO
    insertEvent(db, { telegramUserId: 1, eventName: "share_clicked", props: null, createdAtISO: "2026-09-10T09:05:00Z" }); // не тот event
    insertEvent(db, { telegramUserId: 2, eventName: "plan_generated", props: null, createdAtISO: "2026-09-10T09:00:00Z" }); // другой юзер
    expect(countPlanGenerationsSince(db, 1, "2026-09-10T00:00:00Z")).toBe(1);
  });
});

describe("история планов (plan_history)", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  const basePlan = { telegramUserId: 42, createdAtISO: "2026-09-10T09:00:00Z", storeId: "vv", storeName: "ВкусВилл", budget: 4000, family: 2, totalCost: 3800, plan: { days: [] } };

  it("сохраняет и читает историю, новые сверху", () => {
    savePlanHistory(db, basePlan);
    savePlanHistory(db, { ...basePlan, createdAtISO: "2026-09-11T09:00:00Z", totalCost: 3900 });
    const list = listPlanHistory(db, 42);
    expect(list).toHaveLength(2);
    expect(list[0].createdAt).toBe("2026-09-11T09:00:00Z"); // самый свежий первым
    expect(list[0].totalCost).toBe(3900);
    expect(list[0].plan).toEqual({ days: [] }); // JSON туда-обратно
  });

  it("не путает историю разных пользователей", () => {
    savePlanHistory(db, basePlan);
    savePlanHistory(db, { ...basePlan, telegramUserId: 7 });
    expect(listPlanHistory(db, 42)).toHaveLength(1);
    expect(listPlanHistory(db, 7)).toHaveLength(1);
  });

  it("хранит не больше 12 записей на пользователя, старые вытесняются", () => {
    for (let i = 0; i < 15; i++) {
      savePlanHistory(db, { ...basePlan, createdAtISO: `2026-09-${String(i + 1).padStart(2, "0")}T09:00:00Z` });
    }
    const list = listPlanHistory(db, 42, 100);
    expect(list).toHaveLength(12);
    expect(list[0].createdAt).toBe("2026-09-15T09:00:00Z"); // самые новые остались
  });
});

describe("обращения в поддержку (feedback)", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("сохраняет и читает обращения, новые сверху", () => {
    saveFeedback(db, { telegramUserId: 42, text: "Не находит цены на творог", createdAtISO: "2026-09-10T09:00:00Z" });
    saveFeedback(db, { telegramUserId: 7, text: "Спасибо, всё отлично!", createdAtISO: "2026-09-10T10:00:00Z" });
    const list = listRecentFeedback(db);
    expect(list).toHaveLength(2);
    expect(list[0].text).toBe("Спасибо, всё отлично!"); // самое новое первым
    expect(list[0].telegramUserId).toBe(7);
    expect(list[1].text).toBe("Не находит цены на творог");
  });

  it("пустой список, если обращений ещё не было", () => {
    expect(listRecentFeedback(db)).toEqual([]);
  });

  it("limit ограничивает выдачу", () => {
    for (let i = 0; i < 5; i++) {
      saveFeedback(db, { telegramUserId: 1, text: `сообщение ${i}`, createdAtISO: `2026-09-10T09:0${i}:00Z` });
    }
    expect(listRecentFeedback(db, 2)).toHaveLength(2);
  });
});
