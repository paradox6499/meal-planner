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
