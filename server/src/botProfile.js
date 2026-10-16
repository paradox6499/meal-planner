// Витрина бота в Telegram: меню команд, описание до нажатия Start и короткое описание в профиле.
// Выставляется при запуске сервера через Bot API — повторный вызов безопасен (значения просто перезаписываются),
// а текст живёт в коде рядом с остальными сообщениями бота и не расходится с ними.
import { fetchWithTimeout } from "./http.js";

export const BOT_COMMANDS = [
  { command: "start", description: "Открыть «Съедим»" },
  { command: "help", description: "Как это работает" },
  { command: "support", description: "Написать в поддержку" },
];

// До 512 символов, показывается пустому чату перед кнопкой Start.
export const BOT_DESCRIPTION =
  "Меню на неделю и список покупок с реальными ценами ВкусВилл.\n\n" +
  "🍽 7 дней рецептов под ваш бюджет и рацион\n" +
  "💰 стоимость недели по ценам магазина\n" +
  "🛒 корзина ВкусВилл одним нажатием\n\n" +
  "Нажмите «Start» — и пара вопросов до первого плана.";

// До 120 символов, показывается в профиле бота и при пересылке.
export const BOT_SHORT_DESCRIPTION = "Меню на неделю и список покупок с ценами ВкусВилл — за пару минут";

async function call(botToken, method, payload) {
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, undefined, `Telegram ${method}`);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new Error(`${method}: ${body?.description || res.status}`);
}

/** Возвращает названия вызовов, которые не удались; ошибки не бросает — витрина не повод падать серверу. */
export async function applyBotProfile(botToken) {
  const steps = [
    ["setMyCommands", { commands: BOT_COMMANDS }],
    ["setMyDescription", { description: BOT_DESCRIPTION }],
    ["setMyShortDescription", { short_description: BOT_SHORT_DESCRIPTION }],
  ];
  const failed = [];
  for (const [method, payload] of steps) {
    try {
      await call(botToken, method, payload);
    } catch (err) {
      console.error(`[bot-profile] не удалось выставить: ${err.message}`);
      failed.push(method);
    }
  }
  return failed;
}
