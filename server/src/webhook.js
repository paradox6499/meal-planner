// Входящие сообщения от Telegram (раньше бот умел только ОТПРАВЛЯТЬ —
// напоминания/дайджест/бэкап, но никогда не получал и не отвечал на то, что
// пишут ему). Сценарии: приветствие новым пользователям на /start
// ("нажмите Открыть, чтобы запустить приложение"), /report для админа —
// посмотреть отчёт по событиям прямо сейчас, /feedback — посмотреть
// накопленные обращения, /backup — получить свежий снимок БД прямо сейчас,
// не дожидаясь следующего интервала (см. BACKUP_INTERVAL_HOURS), и — то, что
// просили в чате — любое другое сообщение сохраняется как обращение в
// поддержку (кнопка "Написать в поддержку" в приложении ведёт в чат с самим
// ботом, не на личный аккаунт разработчика).
//
// planReplyForUpdate — чистая функция без побочных эффектов (не шлёт
// сообщения сама, не трогает БД): разбирает Update от Telegram и решает,
// что на него ответить/сохранить. app.js уже выполняет решение — так
// тестируется без сети и без мока БД.

/** Ответ на /diag: результат пробного запроса ВкусВилл с сервера. */
export function buildDiagText(probe, warmQueueSize = 0) {
  const verdict = probe.ok
    ? `✅ ВкусВилл с сервера отвечает (${probe.ms} мс): ${probe.detail}.`
    : `❌ ВкусВилл с сервера НЕ отвечает (${probe.ms} мс): ${probe.detail}${probe.httpStatus ? ` [HTTP ${probe.httpStatus}]` : ""}.`;
  const hint = probe.ok
    ? "Прокси каталога должен работать."
    : "Если это HTTP 401/403 — скорее всего, адрес сервера блокируется на стороне ВкусВилл (QRATOR); нужен хостинг в РФ.";
  return `${verdict}\n${hint}\nЦен в очереди на подогрев: ${warmQueueSize}.`;
}

// Приветствие на /start. Разметка HTML, текст целиком наш (без чужого ввода). Первый заход — что это и что нажать;
// вернувшемуся, у кого уже есть план, — «с возвращением» и прямой путь к плану.
export function buildWelcomeText({ hasPlan = false, isPro = false } = {}) {
  if (hasPlan) {
    return (
      "С возвращением! 👋\n\n" +
      "Ваш план на неделю сохранён — откройте «Съедим», чтобы посмотреть рецепты и список покупок или собрать новый." +
      (isPro ? "\n\n✨ У вас активен <b>Pro</b>: напоминания о приёмах пищи и несколько планов одновременно." : "")
    );
  }
  return (
    "Привет! 👋 Я <b>«Съедим»</b> — собираю меню на неделю и список покупок с реальными ценами ВкусВилл.\n\n" +
    "<b>Что умею:</b>\n" +
    "🍽 подобрать 7 дней рецептов под ваш бюджет и рацион\n" +
    "💰 посчитать стоимость недели по ценам магазина\n" +
    "🛒 собрать корзину ВкусВилл одним нажатием\n\n" +
    "Нажмите кнопку ниже — на первый план уйдёт пара минут."
  );
}

/** Кнопка запуска приложения под сообщениями бота. */
export function buildOpenAppKeyboard(webAppUrl, text = "Открыть «Съедим»") {
  return { inline_keyboard: [[{ text, web_app: { url: webAppUrl } }]] };
}

export function buildHelpText() {
  return (
    "<b>Как это работает</b>\n\n" +
    "1. Откройте «Съедим» и ответьте на несколько вопросов: сколько вас, какие приёмы пищи, бюджет, рацион, аллергии.\n" +
    "2. Получите меню на 7 дней и список покупок с ценами.\n" +
    "3. Нажмите «Заказать» — корзина ВкусВилл соберётся сама.\n\n" +
    "<b>Команды</b>\n" +
    "/start — открыть приложение\n" +
    "/support — написать в поддержку\n" +
    "/help — эта подсказка"
  );
}

/** Владельцу семьи: к нему кто-то вступил (раньше узнать об этом можно было, только открыв Аккаунт). */
export function buildFamilyJoinedText(displayName) {
  // Имя задаёт сам вступающий, а Telegram делает ссылки и @упоминания кликабельными даже в простом тексте:
  // вычищаем всё, из чего можно сделать ссылку (аудит 19.10.2026), и ограничиваем длину.
  const clean = String(displayName ?? "")
    .replace(/https?:\/\/\S+|t\.me\S*|www\.\S+|[@#]\S*|\S+\.(ru|com|org|net|me|io|рф)\b\S*/gi, " ")
    .replace(/[\u0000-\u001f<>"«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  const who = clean ? `«${clean}»` : "Новый участник";
  return `👨‍👩‍👧 ${who} вступил(а) в вашу семью в «Съедим». Теперь отметки «уже есть дома» в списке покупок у вас общие.`;
}

export function buildFeedbackAckText() {
  return "Спасибо! Передал ваше сообщение команде «Съедим» — если понадобится, ответим прямо здесь.";
}

// Живая жалоба в чате: "не доходят сообщения в поддержку, другой пользователь
// написал, мне не пришла жалоба в бота" — раньше обращение только сохранялось
// в БД (saveFeedback), узнать о нём можно было исключительно вручную
// запросив /feedback у бота. Админ не обязан помнить проверять команду —
// теперь app.js ещё и пушит этот текст прямо админу сразу же, /feedback
// остаётся полезен как история всех обращений разом.
export function buildFeedbackAdminNotifyText(telegramUserId, text) {
  return `💬 Новое обращение в поддержку (id ${telegramUserId}):\n\n${text}`;
}

// Просьба в чате: "нужно, чтобы когда пользователь переходил в бота по
// кнопке 'Написать в поддержку', ему высвечивалось, что напишите сейчас это
// обращение и мы отправим его в поддержку" — кнопка закрывает Mini App и
// возвращает пользователя в чат с ботом (см. AccountView в App.jsx —
// openTelegramLink на самого себя не работает, поэтому это именно
// WebApp.close()), но пустой чат сам по себе не объясняет, что теперь нужно
// просто написать сообщение и оно дойдёт. POST /api/support/prompt (app.js)
// шлёт этот текст ДО закрытия — пользователь видит его уже открытым чатом
// вместо пустого экрана.
export function buildSupportPromptText() {
  return "Напишите сейчас одним сообщением, что случилось или что хотели бы улучшить — оно сразу дойдёт до команды «Съедим». Если это ошибка, приложите скриншот: просто отправьте картинку (можно с подписью). Вы помогаете делать сервис лучше 🙌";
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
 * @returns {{ chatId: number, kind: "start" | "help" | "support" | "report" | "list_feedback" | "backup" | "diag" } |
 *           { chatId: number, kind: "feedback", telegramUserId: number, text: string, attachment?: { chatId: number, messageId: number } } | null}
 */
export function planReplyForUpdate(update, { adminTelegramId = null } = {}) {
  const message = update?.message;
  const text = message?.text;
  const chatId = message?.chat?.id;
  const fromId = message?.from?.id ?? chatId;
  if (!chatId) return null;

  // Скриншот ошибки в поддержку (фото или картинка файлом, подпись — в caption).
  // Раньше любое сообщение без текста молча игнорировалось — человек присылал
  // скрин, а до разработчика не доходило ничего. Сам снимок остаётся в
  // Telegram, в БД — только текст-пометка; app.js копирует сообщение админу.
  const isPhoto = Array.isArray(message?.photo) && message.photo.length > 0;
  const isImageFile = typeof message?.document?.mime_type === "string" && message.document.mime_type.startsWith("image/");
  if ((typeof text !== "string" || !text.trim()) && (isPhoto || isImageFile)) {
    if (adminTelegramId && chatId === adminTelegramId) return null;
    const caption = typeof message.caption === "string" ? message.caption.trim() : "";
    return {
      chatId, kind: "feedback", telegramUserId: fromId,
      text: caption ? `📎 скриншот: ${caption}` : "📎 скриншот без подписи",
      attachment: { chatId, messageId: message.message_id },
    };
  }

  if (typeof text !== "string" || !text.trim()) return null;

  // startapp-параметры Mini App приходят как "/start <payload>" — приветствие
  // уместно в любом случае, не только на голый "/start".
  if (text === "/start" || text.startsWith("/start ")) {
    return { chatId, kind: "start", telegramUserId: fromId };
  }
  if (text === "/help") return { chatId, kind: "help" };
  if (text === "/support") return { chatId, kind: "support" };

  // Все три — только сам админ, иначе любой пользователь мог бы выдёргивать
  // внутреннюю статистику, чужие обращения или сам файл базы командой.
  if (text === "/report") {
    return adminTelegramId && chatId === adminTelegramId ? { chatId, kind: "report" } : null;
  }
  if (text === "/feedback") {
    return adminTelegramId && chatId === adminTelegramId ? { chatId, kind: "list_feedback" } : null;
  }
  if (text === "/backup") {
    return adminTelegramId && chatId === adminTelegramId ? { chatId, kind: "backup" } : null;
  }
  if (text === "/diag") {
    return adminTelegramId && chatId === adminTelegramId ? { chatId, kind: "diag" } : null;
  }

  // Сам админ, тестируя бота командами не по назначению (например, опечатка
  // в команде), не должен засорять ленту обращений своими сообщениями.
  if (adminTelegramId && chatId === adminTelegramId) return null;

  // Всё остальное — свободный текст от пользователя — обращение в поддержку.
  return { chatId, kind: "feedback", telegramUserId: fromId, text: text.trim() };
}
