// Тонкая обёртка над Telegram Bot API — только то, что нужно для
// напоминаний: отправить сообщение пользователю. Токен бота передаётся
// параметром, а не читается из env здесь — модуль не должен знать, откуда
// берётся секрет, это дело вызывающего кода (index.js).
import { fetchWithTimeout } from "./http.js";

/**
 * @param {string} botToken
 * @param {number} chatId — telegram_user_id (личка с ботом = чат с тем же id)
 * @param {string} text
 * @param {{ parseMode?: string, replyMarkup?: object }} [opts]
 */
export async function sendTelegramMessage(botToken, chatId, text, opts = {}) {
  // По умолчанию БЕЗ parse_mode (раньше был "Markdown" по умолчанию) — живой
  // баг из аудита: тексты с непарным "_"/"*" (имя события с подчёркиванием,
  // обращение пользователя в поддержку, название рецепта) валят весь запрос
  // ошибкой "can't parse entities", и сообщение НЕ доходит вообще, тихо. Раз
  // в тексте может быть что угодно от пользователя — безопасный дефолт это
  // "без разметки", а не "разметка, пока не сломается". parseMode передаётся
  // явно только для текстов, которые заведомо не содержат чужого ввода.
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      disable_web_page_preview: true,
    }),
  }, undefined, "Telegram sendMessage");
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    // 403 здесь означает "пользователь заблокировал бота" — ожидаемый,
    // частый случай, не System-ошибка; вызывающий код (scheduler.js) должен
    // решить, что с этим делать (например, не ретраить бесконечно), но само
    // сообщение об ошибке должно быть информативным для лога.
    throw new Error(`Telegram sendMessage: ${body?.description || res.status}`);
  }
  return body.result;
}

/** Сообщение "оплата прошла" (UX-аудит 29.09.2026: после оплаты в
 * браузере пользователь возвращался в чат с ботом и не видел ничего — ни
 * подтверждения, ни следующего шага). proUntilISO — для product 'pro'. */
export function buildPaymentConfirmationText(product, proUntilISO) {
  if (product === "extra_plan") {
    return "✅ Оплата прошла — вам доступен ещё один план. Откройте «Съедим» и соберите его.";
  }
  const date = proUntilISO ? new Date(proUntilISO).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : null;
  return `✅ Оплата прошла — Pro активен${date ? ` до ${date}` : ""}. Безлимитные планы, напоминания и общий список на семью уже доступны — откройте «Съедим».`;
}

/** Текст напоминания — отдельная функция, чтобы формат сообщения можно было
 * менять/тестировать независимо от факта его отправки. */
export function buildReminderText(mealLabel, recipeName) {
  // Без markdown-разметки вокруг recipeName — sendTelegramMessage больше не
  // включает parse_mode по умолчанию, а название рецепта не экранировано.
  return `🍽 Скоро ${mealLabel.toLowerCase()}: ${recipeName}. Самое время начинать готовить.`;
}

// "Лёгкое бесплатное напоминание вернуться" (живой вывод из ревью в чате —
// см. scheduler.js: runFreeNudgeTick) — намеренно НЕ про конкретное время
// еды (это остаётся Pro-бонусом, buildReminderText выше), просто нейтральный
// "крючок" не забыть про приложение теперь, когда лимит снова доступен.
export function buildFreeNudgeText() {
  return "🛒 Бесплатный план на эту неделю уже доступен — откройте «Съедим» и соберите новый.";
}

/**
 * Отправка файла (бэкап БД, см. backup.js) документом в чат — тот же бот,
 * никакого стороннего файлового хранилища заводить не пришлось.
 * @param {string} botToken
 * @param {number} chatId
 * @param {Buffer} buffer — содержимое файла
 * @param {string} filename
 * @param {string} [caption]
 */
export async function sendTelegramDocument(botToken, chatId, buffer, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([buffer]), filename);

  // Файл бэкапа — десятки мегабайт, 8 секунд ему мало.
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: form,
  }, 60_000, "Telegram sendDocument");
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`Telegram sendDocument: ${body?.description || res.status}`);
  }
  return body.result;
}

/** Копирует сообщение (фото/скриншот с подписью) из чата пользователя в чат
 * админа — без пометки "переслано" и без доступа к профилю отправителя. Нужно
 * для скриншотов ошибок в поддержке: текст обращения сохраняется в БД, а сам
 * снимок остаётся только в Telegram и просто копируется админу. */
export async function copyTelegramMessage(botToken, toChatId, fromChatId, messageId) {
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/copyMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId }),
  }, undefined, "Telegram copyMessage");
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`Telegram copyMessage: ${body?.description || res.status}`);
  }
  return body.result;
}
