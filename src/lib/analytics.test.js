import { describe, it, expect, vi, afterEach } from "vitest";
import { trackEvent } from "./analytics.js";

// Тот же приём, что и в homeScreen.test.js: window не определён в
// node-окружении тестов, подставляем целиком под каждый сценарий.
function stubTelegram(initData) {
  vi.stubGlobal("window", { Telegram: initData !== undefined ? { WebApp: { initData } } : undefined });
}

describe("trackEvent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("ничего не делает без VITE_BACKEND_URL", () => {
    vi.stubEnv("VITE_BACKEND_URL", "");
    stubTelegram("query_id=x&user=y&hash=z");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    trackEvent("plan_generated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ничего не делает вне Telegram (нет initData)", () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    trackEvent("plan_generated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("шлёт POST /events с initData, именем события и props", () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("query_id=x&user=y&hash=z");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    trackEvent("plan_generated", { budget: 4000 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/events",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ initData: "query_id=x&user=y&hash=z", eventName: "plan_generated", props: { budget: 4000 } });
  });

  it("не бросает исключение, если fetch отклонился (fire-and-forget)", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "https://api.example.com");
    stubTelegram("query_id=x&user=y&hash=z");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(() => trackEvent("plan_generated")).not.toThrow();
    // даём микротаску .catch() отработать, чтобы не остался unhandledrejection
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
