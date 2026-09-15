import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadPantryStaples, savePantryStaples } from "./pantry.js";

// Окружение тестов — node, не jsdom (см. vitest.config.js), поэтому
// глобального localStorage тут нет по умолчанию — минимальный рабочий стаб,
// тот же приём, что и в activePlan.test.js.
function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

describe("pantry", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
  });

  it("loadPantryStaples без сохранённого набора -> пустой Set", () => {
    const result = loadPantryStaples();
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it("сохраняет и восстанавливает набор названий", () => {
    savePantryStaples(new Set(["Мука", "Сахар", "Соль"]));
    const restored = loadPantryStaples();
    expect(restored).toEqual(new Set(["Мука", "Сахар", "Соль"]));
  });

  it("повреждённая/чужая запись в localStorage не роняет приложение — просто пустой Set", () => {
    localStorage.setItem("sedim.pantryStaples.v1", "не json вообще");
    expect(loadPantryStaples()).toEqual(new Set());

    localStorage.setItem("sedim.pantryStaples.v1", JSON.stringify({ not: "an array" }));
    expect(loadPantryStaples()).toEqual(new Set());

    localStorage.setItem("sedim.pantryStaples.v1", JSON.stringify(["Мука", 5, null, "Сахар"]));
    expect(loadPantryStaples()).toEqual(new Set(["Мука", "Сахар"])); // не-строки отфильтрованы, не падает
  });

  it("пустой набор корректно сохраняется и восстанавливается (снятие всех отметок)", () => {
    savePantryStaples(new Set(["Мука"]));
    savePantryStaples(new Set());
    expect(loadPantryStaples()).toEqual(new Set());
  });
});
