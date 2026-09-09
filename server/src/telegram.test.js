import { describe, it, expect, vi, afterEach } from "vitest";
import { sendTelegramMessage, buildReminderText } from "./telegram.js";

describe("sendTelegramMessage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("шлёт POST на sendMessage с правильным chat_id и текстом", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendTelegramMessage("BOT:TOKEN", 42, "Привет");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botBOT:TOKEN/sendMessage");
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe(42);
    expect(body.text).toBe("Привет");
  });

  it("бросает понятную ошибку, если Telegram ответил ok:false (например, бот заблокирован)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, description: "Forbidden: bot was blocked by the user" }) })
    );
    await expect(sendTelegramMessage("BOT:TOKEN", 42, "Привет")).rejects.toThrow(/blocked/);
  });

  it("бросает ошибку при HTTP-сбое без валидного JSON-тела", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error("not json"); } }));
    await expect(sendTelegramMessage("BOT:TOKEN", 42, "Привет")).rejects.toThrow("500");
  });
});

describe("buildReminderText", () => {
  it("собирает читаемый текст напоминания с названием блюда", () => {
    const text = buildReminderText("Ужин", "Паста с томатным соусом");
    expect(text).toContain("ужин");
    expect(text).toContain("Паста с томатным соусом");
  });
});
