// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { PlanHistorySection } from "./PlanHistorySection.jsx";
import { SwipeToDelete, SWIPE_DELETE_THRESHOLD_PX } from "./SwipeToDelete.jsx";

vi.mock("../../lib/confirmAction.js", () => ({ confirmAction: vi.fn() }));
import { confirmAction } from "../../lib/confirmAction.js";

const plan = (id) => ({
  id, createdAt: "2026-10-05T10:00:00.000Z", storeName: "ВкусВилл", totalCost: 3000, budget: 4000, family: 2,
  plan: { days: [] },
});

describe("PlanHistorySection: удаление плана", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("кнопка «Удалить этот план» спрашивает подтверждение и только потом удаляет", async () => {
    confirmAction.mockResolvedValue(true);
    const onDeletePlan = vi.fn().mockResolvedValue(true);
    render(<PlanHistorySection planHistory={[plan(5)]} onDeletePlan={onDeletePlan} />);
    fireEvent.click(screen.getByText(/ВкусВилл/)); // раскрыть план
    fireEvent.click(screen.getByText("Удалить этот план"));
    await waitFor(() => expect(onDeletePlan).toHaveBeenCalledWith(5));
    expect(confirmAction).toHaveBeenCalledWith("Вы точно хотите удалить этот план?");
  });

  it("отказ в подтверждении — ничего не удаляется", async () => {
    confirmAction.mockResolvedValue(false);
    const onDeletePlan = vi.fn();
    render(<PlanHistorySection planHistory={[plan(5)]} onDeletePlan={onDeletePlan} />);
    fireEvent.click(screen.getByText(/ВкусВилл/));
    fireEvent.click(screen.getByText("Удалить этот план"));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(onDeletePlan).not.toHaveBeenCalled();
  });

  it("сервер не удалил — показываем ошибку, план остаётся", async () => {
    confirmAction.mockResolvedValue(true);
    render(<PlanHistorySection planHistory={[plan(5)]} onDeletePlan={vi.fn().mockResolvedValue(false)} />);
    fireEvent.click(screen.getByText(/ВкусВилл/));
    fireEvent.click(screen.getByText("Удалить этот план"));
    expect(await screen.findByText(/Не удалось удалить план/)).toBeTruthy();
  });
});

describe("SwipeToDelete", () => {
  afterEach(cleanup);
  const swipe = (el, dx, dy = 0) => {
    fireEvent.pointerDown(el, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 10 + dx, clientY: 10 + dy, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 10 + dx, clientY: 10 + dy, pointerId: 1 });
  };

  it("протяжка вправо дальше порога просит удалить", () => {
    const onDelete = vi.fn();
    render(<SwipeToDelete onDelete={onDelete}><div>строка</div></SwipeToDelete>);
    swipe(screen.getByText("строка"), SWIPE_DELETE_THRESHOLD_PX + 10);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("короткая протяжка и вертикальная прокрутка — не удаляют", () => {
    const onDelete = vi.fn();
    render(<SwipeToDelete onDelete={onDelete}><div>строка</div></SwipeToDelete>);
    swipe(screen.getByText("строка"), 30);
    swipe(screen.getByText("строка"), 100, 200);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
