import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConsent, saveConsent, legalUrl, openLegalPage } from "./consent.js";

function stubStorage(initial = {}) {
  const store = { ...initial };
  vi.stubGlobal("localStorage", {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  });
  return store;
}

describe("согласие перед оплатой", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("по умолчанию не дано; после saveConsent запоминается", () => {
    stubStorage();
    expect(loadConsent()).toBe(false);
    saveConsent();
    expect(loadConsent()).toBe(true);
  });

  it("недоступный localStorage не ломает: loadConsent -> false, saveConsent не бросает", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(loadConsent()).toBe(false);
    expect(() => saveConsent()).not.toThrow();
  });
});

describe("legalUrl / openLegalPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("строит адрес рядом с приложением и отбрасывает хэш с initData", () => {
    vi.stubGlobal("window", { location: { href: "https://paradox6499.github.io/meal-planner/#tgWebAppData=secret" } });
    expect(legalUrl("privacy.html")).toBe("https://paradox6499.github.io/meal-planner/privacy.html");
    expect(legalUrl("terms.html")).toBe("https://paradox6499.github.io/meal-planner/terms.html");
  });

  it("в Telegram открывает через openLink", () => {
    const openLink = vi.fn();
    vi.stubGlobal("window", { location: { href: "https://x.test/app/" }, Telegram: { WebApp: { openLink } } });
    openLegalPage("terms.html");
    expect(openLink).toHaveBeenCalledWith("https://x.test/app/terms.html");
  });

  it("вне Telegram — window.open в новой вкладке", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { location: { href: "https://x.test/app/" }, open });
    openLegalPage("privacy.html");
    expect(open).toHaveBeenCalledWith("https://x.test/app/privacy.html", "_blank", "noopener,noreferrer");
  });
});
