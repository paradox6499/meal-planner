import { describe, it, expect } from "vitest";
import { buildWelcomeText, buildFeedbackAckText, buildFeedbackListText, planReplyForUpdate } from "./webhook.js";

describe("buildWelcomeText", () => {
  it("объясняет, что за бот и что нажать, чтобы запустить приложение", () => {
    const text = buildWelcomeText();
    expect(text).toContain("Съедим");
    expect(text).toMatch(/открыть/i);
  });
});

describe("buildFeedbackListText", () => {
  it("честно сообщает, что обращений пока нет", () => {
    expect(buildFeedbackListText([])).toMatch(/пока нет/i);
  });

  it("перечисляет обращения с датой и id отправителя", () => {
    const text = buildFeedbackListText([{ telegramUserId: 42, text: "Не находит цены", createdAt: "2026-09-10T09:00:00Z" }]);
    expect(text).toContain("Не находит цены");
    expect(text).toContain("42");
  });
});

function mkUpdate(text, { chatId = 42, fromId } = {}) {
  return { message: { text, chat: { id: chatId }, from: { id: fromId ?? chatId } } };
}

describe("planReplyForUpdate", () => {
  it("/start -> kind:start для того же чата", () => {
    const reply = planReplyForUpdate(mkUpdate("/start"), { adminTelegramId: null });
    expect(reply).toEqual({ chatId: 42, kind: "start" });
  });

  it("/start с startapp-payload (например, /start plan_123) -> тоже kind:start", () => {
    const reply = planReplyForUpdate(mkUpdate("/start plan_123"), { adminTelegramId: null });
    expect(reply.kind).toBe("start");
  });

  it("/report от админа -> kind:report", () => {
    const reply = planReplyForUpdate(mkUpdate("/report", { chatId: 777 }), { adminTelegramId: 777 });
    expect(reply).toEqual({ chatId: 777, kind: "report" });
  });

  it("/report от НЕ админа -> null (не выдаём статистику кому попало)", () => {
    const reply = planReplyForUpdate(mkUpdate("/report", { chatId: 999 }), { adminTelegramId: 777 });
    expect(reply).toBeNull();
  });

  it("/report без заданного adminTelegramId -> null", () => {
    const reply = planReplyForUpdate(mkUpdate("/report", { chatId: 777 }), { adminTelegramId: null });
    expect(reply).toBeNull();
  });

  it("/feedback от админа -> kind:list_feedback", () => {
    const reply = planReplyForUpdate(mkUpdate("/feedback", { chatId: 777 }), { adminTelegramId: 777 });
    expect(reply).toEqual({ chatId: 777, kind: "list_feedback" });
  });

  it("/feedback от НЕ админа -> null", () => {
    expect(planReplyForUpdate(mkUpdate("/feedback", { chatId: 999 }), { adminTelegramId: 777 })).toBeNull();
  });

  it("/backup от админа -> kind:backup", () => {
    const reply = planReplyForUpdate(mkUpdate("/backup", { chatId: 777 }), { adminTelegramId: 777 });
    expect(reply).toEqual({ chatId: 777, kind: "backup" });
  });

  it("/backup от НЕ админа -> null", () => {
    expect(planReplyForUpdate(mkUpdate("/backup", { chatId: 999 }), { adminTelegramId: 777 })).toBeNull();
  });

  it("произвольный текст от обычного пользователя -> kind:feedback с текстом и telegramUserId (кнопка «Написать в поддержку» ведёт в чат с ботом)", () => {
    const reply = planReplyForUpdate(mkUpdate("Не находит цены на творог", { chatId: 42 }), { adminTelegramId: 777 });
    expect(reply).toEqual({ chatId: 42, kind: "feedback", telegramUserId: 42, text: "Не находит цены на творог" });
  });

  it("произвольный текст от админа -> null (не засоряет свою же ленту обращений)", () => {
    expect(planReplyForUpdate(mkUpdate("тестовое сообщение"), { adminTelegramId: 42 })).toBeNull();
  });

  it("обрезает пробелы у текста обращения и игнорирует сообщение из одних пробелов", () => {
    const reply = planReplyForUpdate(mkUpdate("  привет боту  "), {});
    expect(reply.text).toBe("привет боту");
    expect(planReplyForUpdate(mkUpdate("   "), {})).toBeNull();
  });

  it("update без message (например, edited_message) -> null, не падает", () => {
    expect(planReplyForUpdate({ edited_message: { text: "/start" } }, {})).toBeNull();
    expect(planReplyForUpdate({}, {})).toBeNull();
    expect(planReplyForUpdate(null, {})).toBeNull();
  });

  it("сообщение без текста (например, стикер/фото) -> null, не падает", () => {
    expect(planReplyForUpdate({ message: { chat: { id: 42 }, sticker: {} } }, {})).toBeNull();
  });
});
