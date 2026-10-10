// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DislikesPicker } from "./DislikesPicker.jsx";

afterEach(cleanup);

// Обёртка с настоящим состоянием — чтобы видеть, что именно сохраняется.
function Harness({ initial = [], onChange }) {
  const [dislikes, setDislikes] = useState(initial);
  onChange?.(dislikes);
  return <DislikesPicker dislikes={dislikes} setDislikes={setDislikes} />;
}

describe("DislikesPicker", () => {
  it("нажатие на готовый вариант добавляет его id, повторное — убирает", () => {
    const seen = vi.fn();
    render(<Harness onChange={seen} />);
    fireEvent.click(screen.getByText("Грибы"));
    expect(seen).toHaveBeenLastCalledWith(["mushrooms"]);
    fireEvent.click(screen.getByText("Грибы"));
    expect(seen).toHaveBeenLastCalledWith([]);
  });

  it("своё слово: добавляется нормализованным (без регистра и знаков), по Enter и кнопкой, без дублей", () => {
    const seen = vi.fn();
    render(<Harness onChange={seen} />);
    const input = screen.getByLabelText("Добавить нелюбимый продукт");
    fireEvent.change(input, { target: { value: "  Тыква! " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(seen).toHaveBeenLastCalledWith(["тыква"]);
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "тыква" } });
    fireEvent.click(screen.getByLabelText("Добавить"));
    expect(seen).toHaveBeenLastCalledWith(["тыква"]); // не задвоилось
  });

  it("слишком короткое слово не добавляется, кнопка неактивна", () => {
    const seen = vi.fn();
    render(<Harness onChange={seen} />);
    const input = screen.getByLabelText("Добавить нелюбимый продукт");
    fireEvent.change(input, { target: { value: "а" } });
    expect(screen.getByLabelText("Добавить").disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(seen).toHaveBeenLastCalledWith([]);
  });

  it("своё слово видно кнопкой и убирается нажатием", () => {
    const seen = vi.fn();
    render(<Harness initial={["тыква"]} onChange={seen} />);
    fireEvent.click(screen.getByLabelText("Убрать: тыква"));
    expect(seen).toHaveBeenLastCalledWith([]);
  });
});
