// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DayStrip, dayBlockId } from "./DayStrip.jsx";

const days = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day }));
// день 1 = пятница 2 октября 2026; «сегодня» — вторник 6 октября (день 5)
const created = new Date(2026, 9, 2, 12, 0).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 6, 10, 0));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function mountBlocks() {
  days.forEach(({ day }) => {
    const el = document.createElement("div");
    el.id = dayBlockId(day);
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
  });
}
const blocks = () => days.map(({ day }) => document.getElementById(dayBlockId(day)));
afterEach(() => blocks().forEach((b) => b?.remove()));

describe("DayStrip", () => {
  it("семь кнопок с днём недели и числом; «сегодня» подсвечен как текущий", () => {
    render(<DayStrip days={days} planStartISO={created} />);
    expect(screen.getAllByRole("button")).toHaveLength(7);
    const today = screen.getByRole("button", { name: /Сегодня/ });
    expect(today.getAttribute("aria-current")).toBe("true");
    expect(today.textContent).toMatch(/вт/i);
    expect(today.textContent).toMatch(/6/);
  });

  it("нажатие на день прокручивает к его блоку и делает день активным", () => {
    mountBlocks();
    render(<DayStrip days={days} planStartISO={created} />);
    fireEvent.click(screen.getByRole("button", { name: /Перейти к дню: .*7 окт/ }));
    expect(document.getElementById(dayBlockId(6)).scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(screen.getByRole("button", { name: /7 окт/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /Сегодня/ }).getAttribute("aria-current")).toBeNull();
  });

  it("если дата плана неизвестна — просто номера дней, без падения", () => {
    render(<DayStrip days={days} planStartISO={null} />);
    expect(screen.getByRole("button", { name: "Перейти ко дню 3" })).toBeTruthy();
  });

  it("один день — полосы нет", () => {
    const { container } = render(<DayStrip days={[{ day: 1 }]} planStartISO={created} />);
    expect(container.textContent).toBe("");
  });
});
