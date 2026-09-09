import { describe, it, expect } from "vitest";
import { mealDateTimeToUtcMs, isDueForReminder, findDueReminders } from "./reminderTiming.js";

describe("mealDateTimeToUtcMs", () => {
  it("переводит локальное время (Москва, UTC+3) в UTC", () => {
    // 19:00 в Москве (UTC+3) = 16:00 UTC
    const ms = mealDateTimeToUtcMs("2026-09-10", "19:00", 180);
    expect(new Date(ms).toISOString()).toBe("2026-09-10T16:00:00.000Z");
  });

  it("работает и для отрицательного смещения (западнее UTC)", () => {
    // 19:00 по Нью-Йорку (UTC-4 летом, -240 минут) = 23:00 UTC того же дня
    const ms = mealDateTimeToUtcMs("2026-09-10", "19:00", -240);
    expect(new Date(ms).toISOString()).toBe("2026-09-10T23:00:00.000Z");
  });

  it("некорректный формат даты/времени -> null, а не исключение", () => {
    expect(mealDateTimeToUtcMs("10-09-2026", "19:00", 180)).toBeNull();
    expect(mealDateTimeToUtcMs("2026-09-10", "7pm", 180)).toBeNull();
  });
});

describe("isDueForReminder", () => {
  const base = { scheduledDate: "2026-09-10", mealTime: "19:00", timezoneOffsetMinutes: 180, leadMinutes: 30 };

  it("true, когда до приёма пищи ровно leadMinutes или чуть меньше", () => {
    const mealUtc = new Date("2026-09-10T16:00:00.000Z");
    const now25MinBefore = new Date(mealUtc.getTime() - 25 * 60 * 1000);
    expect(isDueForReminder(base, now25MinBefore)).toBe(true);
  });

  it("false, когда до приёма пищи ещё больше leadMinutes", () => {
    const mealUtc = new Date("2026-09-10T16:00:00.000Z");
    const now2hBefore = new Date(mealUtc.getTime() - 2 * 60 * 60 * 1000);
    expect(isDueForReminder(base, now2hBefore)).toBe(false);
  });

  it("false постфактум — приём пищи уже наступил (не слать напоминание задним числом)", () => {
    const mealUtc = new Date("2026-09-10T16:00:00.000Z");
    const now5MinAfter = new Date(mealUtc.getTime() + 5 * 60 * 1000);
    expect(isDueForReminder(base, now5MinAfter)).toBe(false);
  });

  it("true ровно в момент наступления окна (граница включительно)", () => {
    const mealUtc = new Date("2026-09-10T16:00:00.000Z");
    const nowExactlyLead = new Date(mealUtc.getTime() - 30 * 60 * 1000);
    expect(isDueForReminder(base, nowExactlyLead)).toBe(true);
  });
});

describe("findDueReminders", () => {
  it("отбирает только те слоты, для которых наступило окно напоминания", () => {
    const now = new Date("2026-09-10T15:35:00.000Z"); // 18:35 МСК
    const candidates = [
      // ужин в 19:00 МСК = 16:00 UTC, лид 30 мин -> окно с 15:30 UTC — попадает
      { id: 1, scheduled_date: "2026-09-10", meal_time: "19:00", timezone_offset_minutes: 180, reminder_lead_minutes: 30 },
      // обед в 13:00 МСК уже давно прошёл — не должен попасть
      { id: 2, scheduled_date: "2026-09-10", meal_time: "13:00", timezone_offset_minutes: 180, reminder_lead_minutes: 30 },
      // завтрак завтра — ещё далеко
      { id: 3, scheduled_date: "2026-09-11", meal_time: "08:00", timezone_offset_minutes: 180, reminder_lead_minutes: 30 },
    ];
    const due = findDueReminders(candidates, now);
    expect(due.map((s) => s.id)).toEqual([1]);
  });

  it("пустой список кандидатов -> пустой результат, не падает", () => {
    expect(findDueReminders([], new Date())).toEqual([]);
  });
});
