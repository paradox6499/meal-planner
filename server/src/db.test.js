import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDb, saveUserPlan, findCandidateSlots, markReminderSent,
  insertEvent, summarizeEventsSince, getLastDigestAt, setLastDigestAt,
  getLastBackupAt, setLastBackupAt,
  setUserPro, getUserPro, countPlanGenerationsSince, savePlanHistory, listPlanHistory,
  saveFeedback, listRecentFeedback, updateMealTimesForUser,
  extendUserPro, createPendingPayment, updatePaymentStatus, summarizePaymentsSince,
  getUsersWithProExpiringSoon,
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

  it("pro_until в будущем — Pro, в прошлом — не Pro (оплаченная, не ручная подписка)", () => {
    extendUserPro(db, 42, { fromISO: "2026-09-10T09:00:00Z", addDays: 30 });
    expect(getUserPro(db, 42, "2026-09-20T09:00:00Z")).toBe(true); // внутри оплаченного периода
    expect(getUserPro(db, 42, "2026-10-20T09:00:00Z")).toBe(false); // уже истекло
  });

  it("is_pro=1 (ручной тумблер) и pro_until — независимы, любого из двух достаточно", () => {
    setUserPro(db, 1, true); // только ручной тумблер, без pro_until
    expect(getUserPro(db, 1, "2099-01-01T00:00:00Z")).toBe(true); // бессрочно, дата не важна

    extendUserPro(db, 2, { fromISO: "2026-09-10T09:00:00Z", addDays: 30 }); // только оплата, is_pro=0
    expect(getUserPro(db, 2, "2026-09-11T00:00:00Z")).toBe(true);
  });

  it("extendUserPro продлевает ОТ ДАТЫ ОКОНЧАНИЯ текущего периода, а не от now — повторная оплата до истечения не теряет уже оплаченные дни", () => {
    extendUserPro(db, 42, { fromISO: "2026-09-10T09:00:00Z", addDays: 30 }); // до 2026-10-10
    const until = extendUserPro(db, 42, { fromISO: "2026-09-15T09:00:00Z", addDays: 30 }); // оплатили ещё раз спустя 5 дней
    expect(until).toBe("2026-11-09T09:00:00.000Z"); // 2026-10-10 + 30 дней, а не 2026-09-15 + 30
  });
});

// Регрессия на реальный продовый сбой (лог Render: "no such column: is_pro"
// в getUsersWithProExpiringSoon) — is_pro попал в текст CREATE TABLE IF NOT
// EXISTS users позже, чем таблица впервые создалась на диске Render, а
// IF NOT EXISTS ничего не делает для уже существующей таблицы. Ни один тест
// это не ловил, потому что все они открывают ":memory:" — там таблица
// СОЗДАЁТСЯ с нуля при каждом запуске, is_pro в ней есть сразу. Здесь —
// настоящий файл на диске, вручную создан по СТАРОЙ схеме (как 56ae78d,
// самый первый коммит бэкенда) — то есть именно то, что физически лежит на
// Render прямо сейчас: openDb должен домигрировать такую базу, а не упасть.
describe("миграция существующей БД без is_pro (регрессия продового сбоя)", () => {
  let dir, dbPath;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sedim-migration-test-"));
    dbPath = join(dir, "data.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        telegram_user_id INTEGER PRIMARY KEY,
        timezone_offset_minutes INTEGER NOT NULL DEFAULT 180,
        reminder_lead_minutes INTEGER NOT NULL DEFAULT 30
      );
    `);
    // Нестандартные значения сразу при вставке (не отдельным UPDATE'ом
    // вторым подключением к тому же файлу после) — второе открытие того же
    // файла в том же тесте подвешивало SQLite-блокировку на файле в этом
    // окружении, тест зависал на реальном таймауте вместо честного результата.
    legacy.prepare("INSERT INTO users (telegram_user_id, timezone_offset_minutes, reminder_lead_minutes) VALUES (?, ?, ?)").run(777, 240, 45);
    legacy.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("openDb добавляет is_pro в уже существующую (старую) таблицу users, не падает", () => {
    const db = openDb(dbPath);
    expect(getUserPro(db, 777, new Date().toISOString())).toBe(false); // дефолт 0, не падает
    setUserPro(db, 777, true);
    expect(getUserPro(db, 777, new Date().toISOString())).toBe(true);
  });

  it("getUsersWithProExpiringSoon (тот самый запрос из живого лога) отрабатывает на домигрированной базе", () => {
    const db = openDb(dbPath);
    extendUserPro(db, 777, { fromISO: new Date().toISOString(), addDays: 2 });
    expect(() => getUsersWithProExpiringSoon(db, { nowISO: new Date().toISOString(), windowMs: 3 * 24 * 3_600_000 })).not.toThrow();
  });

  it("существующие данные (timezone/reminder_lead), записанные ДО миграции, не теряются", () => {
    const db = openDb(dbPath);
    const rows = db.prepare("SELECT * FROM users WHERE telegram_user_id = 777").all();
    expect(rows[0]).toMatchObject({ timezone_offset_minutes: 240, reminder_lead_minutes: 45, is_pro: 0 });
  });
});

describe("платежи ЮKassa", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("summarizePaymentsSince считает только succeeded-платежи за период", () => {
    createPendingPayment(db, { yookassaPaymentId: "p1", telegramUserId: 1, amountRub: 299, createdAtISO: "2026-09-10T09:00:00Z" });
    createPendingPayment(db, { yookassaPaymentId: "p2", telegramUserId: 2, amountRub: 299, createdAtISO: "2026-09-10T09:00:00Z" });
    createPendingPayment(db, { yookassaPaymentId: "p3", telegramUserId: 3, amountRub: 299, createdAtISO: "2026-09-08T09:00:00Z" }); // за пределами периода ниже

    updatePaymentStatus(db, { yookassaPaymentId: "p1", status: "succeeded", confirmedAtISO: "2026-09-10T09:05:00Z" });
    updatePaymentStatus(db, { yookassaPaymentId: "p2", status: "canceled", confirmedAtISO: null }); // не succeeded — не считается
    updatePaymentStatus(db, { yookassaPaymentId: "p3", status: "succeeded", confirmedAtISO: "2026-09-08T09:05:00Z" }); // раньше sinceISO — не считается

    const summary = summarizePaymentsSince(db, "2026-09-09T00:00:00Z");
    expect(summary).toEqual({ count: 1, totalRub: 299 });
  });

  it("пустой период — {count:0, totalRub:0}, не null/undefined", () => {
    expect(summarizePaymentsSince(db, "2020-01-01T00:00:00Z")).toEqual({ count: 0, totalRub: 0 });
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

// Регрессия на жалобу в чате: изменение времени приёма пищи в Аккаунте не
// доходило до сервера, если в текущей открытой сессии не было
// свежесобранного плана (единственный путь раньше — saveUserPlan целиком,
// вместе со всем планом). updateMealTimesForUser обновляет meal_time для
// уже сохранённых слотов напрямую, без плана вообще.
describe("updateMealTimesForUser", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
    saveUserPlan(db, {
      telegramUserId: 42, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30,
      mealSlots: [
        { scheduledDate: "2026-09-10", mealType: "lunch", mealLabel: "Обед", mealTime: "13:00", recipeName: "Паста" },
        { scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Суп" },
        { scheduledDate: "2026-09-11", mealType: "lunch", mealLabel: "Обед", mealTime: "13:00", recipeName: "Салат" },
      ],
    });
  });

  it("обновляет meal_time для всех слотов указанного типа приёма пищи, не трогая остальные", () => {
    updateMealTimesForUser(db, 42, { lunch: "14:30" });
    const rows = findCandidateSlots(db, "2026-09-10", "2026-09-11");
    const byType = Object.fromEntries(rows.map((r) => [`${r.scheduled_date}-${r.meal_type}`, r.meal_time]));
    expect(byType["2026-09-10-lunch"]).toBe("14:30");
    expect(byType["2026-09-11-lunch"]).toBe("14:30");
    expect(byType["2026-09-10-dinner"]).toBe("19:00"); // не тронут
  });

  it("можно обновить несколько типов приёма пищи за один вызов", () => {
    updateMealTimesForUser(db, 42, { lunch: "14:00", dinner: "20:00" });
    const rows = findCandidateSlots(db, "2026-09-10", "2026-09-11");
    const byType = Object.fromEntries(rows.map((r) => [`${r.scheduled_date}-${r.meal_type}`, r.meal_time]));
    expect(byType["2026-09-10-lunch"]).toBe("14:00");
    expect(byType["2026-09-10-dinner"]).toBe("20:00");
  });

  it("не падает и возвращает 0, если у пользователя ещё нет сохранённого плана", () => {
    const updated = updateMealTimesForUser(db, 999, { lunch: "14:00" });
    expect(updated).toBe(0);
  });

  it("не путает время разных пользователей", () => {
    saveUserPlan(db, {
      telegramUserId: 7, timezoneOffsetMinutes: 180, reminderLeadMinutes: 30,
      mealSlots: [{ scheduledDate: "2026-09-10", mealType: "lunch", mealLabel: "Обед", mealTime: "13:00", recipeName: "План юзера 7" }],
    });
    updateMealTimesForUser(db, 42, { lunch: "15:00" });
    const rows = findCandidateSlots(db, "2026-09-10", "2026-09-11");
    const user7Row = rows.find((r) => r.telegram_user_id === 7);
    expect(user7Row.meal_time).toBe("13:00"); // не тронут
  });
});
