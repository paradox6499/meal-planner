import { describe, it, expect, vi, afterEach } from "vitest";
import { isHomeScreenSupported, checkHomeScreenStatus, promptAddToHomeScreen, onHomeScreenAdded } from "./homeScreen.js";

// window не определён в node-окружении тестов (см. vite.config.js) — сами
// функции модуля обращаются к window.Telegram напрямую (не через какой-то
// внедряемый параметр), поэтому подставляем global window целиком под каждый
// сценарий, а не только Telegram внутри него.
function stubTelegram(webAppOverrides) {
  vi.stubGlobal("window", { Telegram: webAppOverrides ? { WebApp: webAppOverrides } : undefined });
}

describe("isHomeScreenSupported", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("false вне Telegram (window.Telegram отсутствует)", () => {
    stubTelegram(undefined);
    expect(isHomeScreenSupported()).toBe(false);
  });

  it("false на версии клиента младше 8.0", () => {
    stubTelegram({ isVersionAtLeast: (v) => v !== "8.0", addToHomeScreen: () => {} });
    expect(isHomeScreenSupported()).toBe(false);
  });

  it("false, если addToHomeScreen не функция (клиент заявляет версию, но метода нет)", () => {
    stubTelegram({ isVersionAtLeast: () => true });
    expect(isHomeScreenSupported()).toBe(false);
  });

  it("true, когда версия подходит и метод есть", () => {
    stubTelegram({ isVersionAtLeast: () => true, addToHomeScreen: () => {} });
    expect(isHomeScreenSupported()).toBe(true);
  });
});

describe("checkHomeScreenStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("'unsupported', если API недоступен — не пытается звать checkHomeScreenStatus вообще", async () => {
    stubTelegram(undefined);
    await expect(checkHomeScreenStatus()).resolves.toBe("unsupported");
  });

  it("возвращает статус из callback как есть", async () => {
    stubTelegram({
      isVersionAtLeast: () => true,
      addToHomeScreen: () => {},
      checkHomeScreenStatus: (cb) => cb("added"),
    });
    await expect(checkHomeScreenStatus()).resolves.toBe("added");
  });

  it("'unknown', если callback никогда не вызывается (таймаут-подстраховка)", async () => {
    vi.useFakeTimers();
    stubTelegram({ isVersionAtLeast: () => true, addToHomeScreen: () => {}, checkHomeScreenStatus: () => {} });
    const promise = checkHomeScreenStatus();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(promise).resolves.toBe("unknown");
  });

  it("'unknown', если сам вызов checkHomeScreenStatus бросает исключение", async () => {
    stubTelegram({
      isVersionAtLeast: () => true,
      addToHomeScreen: () => {},
      checkHomeScreenStatus: () => { throw new Error("boom"); },
    });
    await expect(checkHomeScreenStatus()).resolves.toBe("unknown");
  });
});

describe("promptAddToHomeScreen / onHomeScreenAdded", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("promptAddToHomeScreen вызывает addToHomeScreen()", () => {
    const addToHomeScreen = vi.fn();
    stubTelegram({ addToHomeScreen });
    promptAddToHomeScreen();
    expect(addToHomeScreen).toHaveBeenCalledTimes(1);
  });

  it("promptAddToHomeScreen вне Telegram не падает", () => {
    stubTelegram(undefined);
    expect(() => promptAddToHomeScreen()).not.toThrow();
  });

  it("onHomeScreenAdded подписывается через onEvent('homeScreenAdded', ...)", () => {
    const onEvent = vi.fn();
    stubTelegram({ onEvent });
    const cb = () => {};
    onHomeScreenAdded(cb);
    expect(onEvent).toHaveBeenCalledWith("homeScreenAdded", cb);
  });

  it("onHomeScreenAdded вне Telegram возвращает no-op отписку, не падает", () => {
    stubTelegram(undefined);
    const unsubscribe = onHomeScreenAdded(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });
});
