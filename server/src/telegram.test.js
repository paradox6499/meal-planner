import { describe, it, expect, vi, afterEach } from "vitest";
import { sendTelegramMessage, buildReminderText, buildFreeNudgeText, sendTelegramDocument, buildPaymentConfirmationText } from "./telegram.js";

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

describe("sendTelegramDocument", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("шлёт multipart POST на sendDocument с chat_id, файлом и подписью", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: {} }) });
    vi.stubGlobal("fetch", fetchMock);

    await sendTelegramDocument("BOT:TOKEN", 777, Buffer.from("hello"), "backup.db", "Бэкап");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botBOT:TOKEN/sendDocument");
    expect(opts.body).toBeInstanceOf(FormData);
    expect(opts.body.get("chat_id")).toBe("777");
    expect(opts.body.get("caption")).toBe("Бэкап");
    expect(opts.body.get("document").name).toBe("backup.db");
  });

  it("бросает понятную ошибку при ok:false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, description: "File too large" }) }));
    await expect(sendTelegramDocument("BOT:TOKEN", 777, Buffer.from("x"), "b.db")).rejects.toThrow(/too large/);
  });
});

describe("buildReminderText", () => {
  it("собирает читаемый текст напоминания с названием блюда", () => {
    const text = buildReminderText("Ужин", "Паста с томатным соусом");
    expect(text).toContain("ужин");
    expect(text).toContain("Паста с томатным соусом");
  });
});

// Живой вывод из ревью: "лёгкое бесплатное напоминание вернуться" — намеренно
// без конкретного блюда/времени (это остаётся Pro-бонусом, buildReminderText
// выше), просто нейтральный крючок вернуться в приложение.
describe("buildFreeNudgeText", () => {
  it("непустой текст, упоминает бесплатный план", () => {
    const text = buildFreeNudgeText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/план/i);
  });
});

// Регрессия на баг из тех. аудита #3: sendMessage по умолчанию слал
// parse_mode "Markdown", и любое "_"/"*" в тексте (обращение пользователя,
// имя события, название рецепта) отклонялось Telegram целиком.
describe("sendTelegramMessage: разметка и кнопки", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    return () => JSON.parse(fetchMock.mock.calls[0][1].body);
  };

  it("по умолчанию parse_mode не отправляется вообще (текст с _ и * доходит как есть)", async () => {
    const body = stub();
    await sendTelegramMessage("T", 1, "family_created и *звёздочки* и s_edim_bot");
    expect("parse_mode" in body()).toBe(false);
    expect(body().text).toBe("family_created и *звёздочки* и s_edim_bot");
  });

  it("parseMode передаётся только когда явно запрошен", async () => {
    const body = stub();
    await sendTelegramMessage("T", 1, "x", { parseMode: "HTML" });
    expect(body().parse_mode).toBe("HTML");
  });

  it("replyMarkup уходит как reply_markup (кнопка открытия Mini App)", async () => {
    const body = stub();
    const markup = { inline_keyboard: [[{ text: "Открыть", web_app: { url: "https://example.com" } }]] };
    await sendTelegramMessage("T", 1, "x", { replyMarkup: markup });
    expect(body().reply_markup).toEqual(markup);
  });

  it("buildReminderText не оборачивает название блюда в markdown", () => {
    expect(buildReminderText("Ужин", "Паста_с*чем-то")).toBe("🍽 Скоро ужин: Паста_с*чем-то. Самое время начинать готовить.");
  });
});

describe("buildPaymentConfirmationText", () => {
  it("Pro — с датой окончания, extra_plan — без неё", () => {
    expect(buildPaymentConfirmationText("pro", "2026-10-10T09:00:00.000Z")).toMatch(/Pro активен до 10 октября/);
    expect(buildPaymentConfirmationText("pro")).toContain("Pro активен");
    expect(buildPaymentConfirmationText("extra_plan")).toContain("ещё один план");
  });
});
