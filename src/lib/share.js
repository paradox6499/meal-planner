// Текст и ссылка «Поделиться» через Telegram.

// Пока бот не заведён через @BotFather — здесь null, и в пересланное
// сообщение не добавляется ссылка (иначе была бы нерабочей — хуже, чем без
// неё). Появится юзернейм бота — вписать сюда, шеринг сразу начнёт вести
// новых людей в приложение, ничего больше менять не нужно. Дальше, когда
// план будет сохраняться на сервере (см. docs/telegram-bot-architecture.md),
// это должно стать функцией вида `t.me/<bot>/<app>?startapp=plan_${plan.id}` —
// тогда получатель попадает не просто в бота, а сразу в ЭТОТ план.
export const BOT_SHARE_URL = "https://t.me/s_edim_bot";

// Формирует читаемый текст плана для пересылки в Telegram-чат — например,
// семейный: "вот что мы едим на этой неделе, как тебе?"
export function buildShareText(plan, storeName, family) {
  const lines = [
    `🛒 Наш план на неделю — ${storeName}, на ${family} ${family === 1 ? "человека" : "человек"}`,
    `Итого: ${plan.total.toLocaleString("ru-RU")} ₽`,
    "",
  ];
  plan.days.forEach(({ day, dayMeals }) => {
    lines.push(`День ${day}:`);
    dayMeals.forEach((dm) => lines.push(`  ${dm.mealLabel}: ${dm.recipe.emoji} ${dm.recipe.name}`));
  });
  lines.push("", "Как вам? 🙂");
  return lines.join("\n");
}

// Универсальная ссылка t.me/share/url — работает и внутри Mini App, и как
// обычная веб-ссылка: открывает штатный диалог Telegram "переслать в чат".
// `url` (если задан через BOT_SHARE_URL) даёт кликабельную карточку-превью
// поверх текста — это и есть тот самый "рост узнаваемости через шеринг".
// Раньше собирали ссылку через URLSearchParams — он кодирует пробел как "+"
// (стандарт application/x-www-form-urlencoded), а страница t.me/share/url
// его обратно в пробел не разворачивает: в переданном тексте (там много
// пробелов — переносы строк, отступы у каждого блюда) плюсики вместо
// пробелов буквально появлялись в сообщении (баг из чата). encodeURIComponent
// кодирует пробел как %20 — это понимает любой корректный URL-декодер.
export function buildShareUrl(text, url) {
  let href = `https://t.me/share/url?text=${encodeURIComponent(text)}`;
  if (url) href += `&url=${encodeURIComponent(url)}`;
  return href;
}

export function shareViaTelegram(text, url) {
  window.open(buildShareUrl(text, url), "_blank", "noopener,noreferrer");
}
