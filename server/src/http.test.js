import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout, guardTick } from "./http.js";

afterEach(() => vi.unstubAllGlobals());

describe("fetchWithTimeout", () => {
  it("передаёт опции и добавляет signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await fetchWithTimeout("https://x/api", { method: "POST", body: "b" }, 1000, "тест");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://x/api");
    expect(opts.method).toBe("POST");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("зависший ответ -> понятная ошибка с названием сервиса, а не вечное ожидание", async () => {
    vi.stubGlobal("fetch", vi.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    })));
    await expect(fetchWithTimeout("https://x/api", {}, 30, "ЮKassa")).rejects.toThrow(/ЮKassa: нет ответа/);
  });

  it("обычная сетевая ошибка пробрасывается как есть", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(fetchWithTimeout("https://x/api", {}, 1000)).rejects.toThrow("ECONNRESET");
  });
});

describe("guardTick", () => {
  it("пока предыдущий тик идёт, следующий пропускается (напоминания не уходят дважды)", async () => {
    let started = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const guarded = guardTick("тест", async () => { started++; await gate; });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = guarded();
    await guarded(); // пропущен
    await guarded(); // пропущен
    expect(started).toBe(1);
    release();
    await first;
    await guarded(); // предыдущий закончился — снова работает
    expect(started).toBe(2);
    warn.mockRestore();
  });

  it("ошибка тика освобождает защиту (следующий тик не блокируется навсегда)", async () => {
    let started = 0;
    const guarded = guardTick("тест", async () => { started++; throw new Error("boom"); });
    await expect(guarded()).rejects.toThrow("boom");
    await expect(guarded()).rejects.toThrow("boom");
    expect(started).toBe(2);
  });
});
