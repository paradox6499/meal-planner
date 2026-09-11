// Входящие сообщения от Telegram (раньше бот умел только ОТПРАВЛЯТЬ —
// напоминания/дайджест/бэкап, но никогда не получал и не отвечал на то, что
// пишут ему). Три сценария: приветствие новым пользователям на /start
// ("нажмите Открыть, чтобы запустить приложение"), команда /report для
// админа — посмотреть отчёт по событиям прямо сейчас, и — то, что просили
// в чате — любое другое сообщение сохраняется как обращение в поддержку
// (кнопка "Написать в поддержку" в приложении ведёт в чат с самим ботом, не
// на личный аккаунт разработчика), плюс /feedback для админа — посмотреть
// накопленные обращения.
//
// planReplyForUpdate — чистая функция без побочных эффектов (не шлёт
// сообщения сама, не трогает БД): разбирает Update от Telegram и решает,
// что на него ответить/сохранить. app.js уже выполняет решение — так
// тестируется без сети и без мока БД.

export function buildWelcomeText() {
  return (
    "Привет! 👋 Я «Съедим» — помогу собрать меню на неделю под ваш бюджет и список покупок с реальными ценами ВкусВилл.\n\n" +
    "Чтобы начать, нажмите кнопку «Открыть» рядом с полем ввода (или пункт меню бота внизу слева) — приложение откроется прямо здесь, в Telegram."
  );
}

export function buildFeedbackAckText() {
  return "Спасибо! Передал ваше сообщение команде «Съедим» — если понадобится, ответим прямо здесь.";
}

/** items — [{telegramUserId, text, createdAt}], новые сверху (см.
 * listRecentFeedback в db.js). Пустой список — отдельная явная фраза, а не
 * молчание, чтобы /feedback само по себе подтверждало, что команда сработала. */
export function buildFeedbackListText(items) {
  if (items.length === 0) return "Обращений пока нет.";
  const lines = [`💬 Последние обращения (${items.length}):`, ""];
  for (const it of items) {
    const date = new Date(it.createdAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    lines.push(`— [${date}, id ${it.telegramUserId}] ${it.text}`);
  }
  return lines.join("\n");
}

/**
 * @param {object} update — Update от Telegram (см. core.telegram.org/bots/api#update)
 * @param {{ adminTelegramId?: number|null }} [opts]
 * @returns {{ chatId: number, kind: "start" | "report" | "list_feedback" } |
 *           { chatId: number, kind: "feedback", telegramUserId: number, text: string } | null}
 */
export function planReplyForUpdate(update, { adminTelegramId = null } = {}) {
  const text = update?.message?.text;
  const chatId = update?.message?.chat?.id;
  const fromId = update?.message?.from?.id ?? chatId;
  if (!chatId || typeof text !== "string" || !text.trim()) return null;

  // startapp-параметры Mini App приходят как "/start <payload>" — приветствие
  // уместно в любом случае, не только на голый "/start".
  if (text === "/start" || text.startsWith("/start ")) {
    return { chatId, kind: "start" };
  }

  // Обе команды — только сам админ, иначе любой пользователь мог бы
  // выдёргивать внутреннюю статистику или чужие обращения командой.
  if (text === "/report") {
    return adminTelegramId && chatId === adminTelegramId ? { chatId, kind: "report" } : null;
  }
  if (text === "/feedback") {
    return adminTelegramId && chatId === adminTelegramId ? { chatId, kind: "list_feedback" } : null;
  }

  // Сам админ, тестируя бота командами не по назначению (например, опечатка
  // в команде), не должен засорять ленту обращений своими сообщениями.
  if (adminTelegramId && chatId === adminTelegramId) return null;

  // Всё остальное — свободный текст от пользователя — обращение в поддержку.
  return { chatId, kind: "feedback", telegramUserId: fromId, text: text.trim() };
}
