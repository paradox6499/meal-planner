import { describe, it, expect } from "vitest";
import { buildWelcomeText, buildFeedbackAckText, buildFeedbackListText, buildFeedbackAdminNotifyText, buildSupportPromptText, planReplyForUpdate } from "./webhook.js";

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

// Живая жалоба: "не доходят сообщения в поддержку" — раньше обращение
// оседало в БД молча, узнать о нём было можно только вручную запросив
// /feedback. Теперь app.js пушит этот текст админу сразу же (см. app.js —
// ветку kind:"feedback").
describe("buildFeedbackAdminNotifyText", () => {
  it("содержит текст обращения и id отправителя, чтобы понять, кому отвечать", () => {
    const text = buildFeedbackAdminNotifyText(42, "Не находит цены на творог");
    expect(text).toContain("Не находит цены на творог");
    expect(text).toContain("42");
  });
});

describe("buildSupportPromptText", () => {
  it("просит написать сообщение сейчас, объясняет, что оно дойдёт до поддержки", () => {
    const text = buildSupportPromptText();
    expect(text).toMatch(/напишите/i);
    expect(text.length).toBeGreaterThan(0);
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


// Скриншоты в поддержку: раньше любое сообщение без текста молча игнорировалось.
describe("planReplyForUpdate: скриншот в поддержку", () => {
  const photoUpdate = (over = {}) => ({ message: { message_id: 55, chat: { id: 42 }, from: { id: 42 }, photo: [{ file_id: "a", width: 90 }, { file_id: "b", width: 800 }], ...over } });

  it("фото с подписью -> обращение с текстом подписи и ссылкой на сообщение для копирования админу", () => {
    const reply = planReplyForUpdate(photoUpdate({ caption: "  не открывается рецепт  " }), { adminTelegramId: 777 });
    expect(reply).toEqual({
      chatId: 42, kind: "feedback", telegramUserId: 42,
      text: "📎 скриншот: не открывается рецепт",
      attachment: { chatId: 42, messageId: 55 },
    });
  });

  it("фото без подписи -> обращение 'скриншот без подписи'", () => {
    expect(planReplyForUpdate(photoUpdate(), { adminTelegramId: 777 }).text).toBe("📎 скриншот без подписи");
  });

  it("картинка файлом (document image/*) тоже принимается", () => {
    const reply = planReplyForUpdate({ message: { message_id: 9, chat: { id: 42 }, from: { id: 42 }, document: { mime_type: "image/png", file_id: "d" } } }, { adminTelegramId: 777 });
    expect(reply.kind).toBe("feedback");
    expect(reply.attachment.messageId).toBe(9);
  });

  it("не картинка (pdf, голосовое) и сообщение без текста и вложений — по-прежнему игнорируется", () => {
    expect(planReplyForUpdate({ message: { message_id: 9, chat: { id: 42 }, from: { id: 42 }, document: { mime_type: "application/pdf" } } })).toBeNull();
    expect(planReplyForUpdate({ message: { message_id: 9, chat: { id: 42 }, from: { id: 42 }, voice: {} } })).toBeNull();
  });

  it("фото от самого админа не засоряет ленту обращений", () => {
    expect(planReplyForUpdate(photoUpdate({ chat: { id: 777 }, from: { id: 777 } }), { adminTelegramId: 777 })).toBeNull();
  });

  it("текстовое обращение без вложения — как раньше, без attachment", () => {
    const reply = planReplyForUpdate({ message: { message_id: 1, chat: { id: 42 }, from: { id: 42 }, text: "привет" } }, { adminTelegramId: 777 });
    expect(reply).toEqual({ chatId: 42, kind: "feedback", telegramUserId: 42, text: "привет" });
  });
});

describe("buildSupportPromptText", () => {
  it("подсказывает, что можно приложить скриншот", () => {
    expect(buildSupportPromptText()).toMatch(/скриншот/);
  });
});
