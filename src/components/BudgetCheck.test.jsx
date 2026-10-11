// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BudgetCheck } from "./BudgetCheck.jsx";

afterEach(cleanup);
const props = { meals: ["lunch", "dinner"], family: 2, familyByMeal: {}, store: "vv" };

describe("BudgetCheck", () => {
  it("мало денег: «Маловато» и кнопка с суммой; нажатие ставит предложенную сумму", () => {
    const setBudget = vi.fn();
    render(<BudgetCheck {...props} budget={1500} setBudget={setBudget} />);
    expect(screen.getByText("Маловато")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Поставить/ }));
    expect(setBudget).toHaveBeenCalledTimes(1);
    expect(setBudget.mock.calls[0][0]).toBeGreaterThan(1500);
    expect(setBudget.mock.calls[0][0] % 250).toBe(0);
  });

  it("обычный бюджет: «Хватит» и без кнопки", () => {
    render(<BudgetCheck {...props} budget={4000} setBudget={vi.fn()} />);
    expect(screen.getByText("Хватит")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Поставить/ })).toBeNull();
  });

  it("много денег: «С запасом»", () => {
    render(<BudgetCheck {...props} budget={15000} setBudget={vi.fn()} />);
    expect(screen.getByText("С запасом")).toBeTruthy();
  });

  it("нет приёмов пищи — подсказки нет вовсе", () => {
    const { container } = render(<BudgetCheck {...props} meals={[]} budget={4000} setBudget={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});
