// Тонкая обёртка над Telegram Bot API — только то, что нужно для
// напоминаний: отправить сообщение пользователю. Токен бота передаётся
// параметром, а не читается из env здесь — модуль не должен знать, откуда
// берётся секрет, это дело вызывающего кода (index.js).

/**
 * @param {string} botToken
 * @param {number} chatId — telegram_user_id (личка с ботом = чат с тем же id)
 * @param {string} text
 * @param {{ parseMode?: string }} [opts]
 */
export async function sendTelegramMessage(botToken, chatId, text, opts = {}) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode ?? "Markdown",
      disable_web_page_preview: true,
    }),
  });
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

/** Текст напоминания — отдельная функция, чтобы формат сообщения можно было
 * менять/тестировать независимо от факта его отправки. */
export function buildReminderText(mealLabel, recipeName) {
  return `🍽 Скоро ${mealLabel.toLowerCase()}: *${recipeName}*. Самое время начинать готовить.`;
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

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`Telegram sendDocument: ${body?.description || res.status}`);
  }
  return body.result;
}
