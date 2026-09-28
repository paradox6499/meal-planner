import { describe, it, expect } from "vitest";
import { describePlanDay, findTodayDayIndex } from "./planDays.js";

// Локальные даты (не UTC-строки), чтобы тест не зависел от часового пояса
// машины, на которой запущен.
const created = new Date(2026, 8, 29, 12, 0).toISOString(); // 29 сентября, полдень
const at = (day, hour = 10) => new Date(2026, 8, day, hour, 0);

describe("describePlanDay", () => {
  it("день 1 в день сборки — 'Сегодня'", () => {
    const d = describePlanDay(created, 1, at(29));
    expect(d.isToday).toBe(true);
    expect(d.isPast).toBe(false);
    expect(d.label.startsWith("Сегодня · ")).toBe(true);
  });

  it("день 3 спустя два дня после сборки — 'Сегодня'", () => {
    expect(describePlanDay(created, 3, at(1 + 30)).isToday).toBe(true); // 29+2 = 1 октября (месяц переходит)
  });

  it("прошедшие дни помечены isPast, будущие — нет и без 'Сегодня'", () => {
    const now = at(30);
    expect(describePlanDay(created, 1, now).isPast).toBe(true);
    const future = describePlanDay(created, 5, now);
    expect(future.isPast).toBe(false);
    expect(future.isToday).toBe(false);
    expect(future.label.startsWith("Сегодня")).toBe(false);
  });

  it("план, собранный поздно вечером, не съезжает на следующий день", () => {
    const late = new Date(2026, 8, 29, 23, 50).toISOString();
    expect(describePlanDay(late, 1, at(29, 23)).isToday).toBe(true);
    expect(describePlanDay(late, 1, at(30, 1)).isPast).toBe(true);
  });

  it("нет даты сборки (старый план) или битая дата — null, вызывающий код падает на 'День N'", () => {
    expect(describePlanDay(null, 1)).toBeNull();
    expect(describePlanDay("не дата", 1)).toBeNull();
  });
});

describe("findTodayDayIndex", () => {
  const days = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day }));

  it("находит индекс сегодняшнего дня", () => {
    expect(findTodayDayIndex(created, days, at(31))).toBe(2);
  });

  it("сегодня вне диапазона плана (план старше недели) — -1", () => {
    expect(findTodayDayIndex(created, days, new Date(2026, 9, 20))).toBe(-1);
  });

  it("нет даты сборки — -1", () => {
    expect(findTodayDayIndex(null, days)).toBe(-1);
  });
});
