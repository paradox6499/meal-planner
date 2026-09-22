import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadPayerEmail, savePayerEmail } from "./payerContact.js";

// Окружение тестов — node, не jsdom (см. vitest.config.js), поэтому
// глобального localStorage тут нет по умолчанию — минимальный рабочий стаб,
// тот же приём, что и в pantry.test.js/activePlan.test.js.
function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

describe("payerContact", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
  });

  it("loadPayerEmail без сохранённого значения -> пустая строка", () => {
    expect(loadPayerEmail()).toBe("");
  });

  it("сохраняет и восстанавливает email", () => {
    savePayerEmail("user@example.com");
    expect(loadPayerEmail()).toBe("user@example.com");
  });

  it("localStorage недоступен (приватный режим) -> не падает, просто пустая строка", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    });
    expect(() => savePayerEmail("user@example.com")).not.toThrow();
    expect(loadPayerEmail()).toBe("");
  });
});
