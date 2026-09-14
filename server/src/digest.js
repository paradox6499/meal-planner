// Ежедневный отчёт по событиям (см. events в db.js) прямо в личку разработчику
// от того же бота, который шлёт напоминания — переиспользуем sendTelegramMessage,
// отдельный канал/сервис (Sentry и т.п.) не заводим ради этого. Специально
// разделено на чистые функции (когда пора слать, что писать) и одну
// оркестрирующую runDigest — первые тестируются без сети и без времени "как есть".
import { summarizeEventsSince, getLastDigestAt, setLastDigestAt, summarizePaymentsSince } from "./db.js";
import { sendTelegramMessage } from "./telegram.js";

/** Пора ли слать дайджест: раз в сутки, в первый тик после наступления
 * digestHour по UTC (сервер не знает часовой пояс разработчика — час задаётся
 * явно через env, см. index.js). lastDigestAt=null — ещё ни разу не
 * отправляли, шлём при первой же возможности, не ждём следующего дня. */
export function shouldRunDigest(now, lastDigestAt, digestHour) {
  if (now.getUTCHours() < digestHour) return false;
  if (!lastDigestAt) return true;
  const last = new Date(lastDigestAt);
  const lastIsSameDay = last.getUTCFullYear() === now.getUTCFullYear() && last.getUTCMonth() === now.getUTCMonth() && last.getUTCDate() === now.getUTCDate();
  return !lastIsSameDay;
}

// Найдено при разборе вопроса "какие вообще события отслеживаются" —
// app_opened и wizard_step_completed реально шлются (см. trackEvent в
// App.jsx), но тут не были подписаны — без этого отчёт показывал их сырым
// именем события вместо человеческого текста. wizard_started, наоборот,
// нигде в App.jsx не зовётся — оставлен на случай, если появится позже,
// подписанное-но-не-используемое имя безвредно.
const EVENT_LABELS = {
  app_error: "❗ ошибок в приложении",
  app_opened: "открыли приложение",
  wizard_started: "визард начали",
  wizard_step_completed: "шагов визарда пройдено",
  plan_generated: "планов собрано",
  pro_modal_opened: "открыли экран подписки",
  pro_subscribe_clicked: "нажали «Оформить подписку»",
  order_clicked: "нажали «Заказать»",
  substitute_used: "заменили товар",
  share_clicked: "поделились списком",
  support_clicked: "открыли поддержку",
  home_screen_prompted: "предложили «на экран»",
  home_screen_added: "добавили на экран",
};

// paymentsSummary — { count, totalRub } (см. db.js:summarizePaymentsSince).
// Раньше отчёт целиком обрывался на "Событий не было", если totalEvents===0
// — платежи (payments — отдельная таблица, не events) в этом случае вообще
// не показывались бы, даже если за тот же день кто-то реально оплатил Pro.
// Теперь блок с оплатами не зависит от того, были ли события.
export function buildDigestText(summary, { sinceISO, now, paymentsSummary = { count: 0, totalRub: 0 } }) {
  const periodHours = Math.max(1, Math.round((now.getTime() - new Date(sinceISO).getTime()) / 3_600_000));
  const lines = [`📊 Съедим — отчёт за последние ${periodHours} ч`, ""];

  if (paymentsSummary.count > 0) {
    lines.push(`💳 Оплат Pro: ${paymentsSummary.count} на ${paymentsSummary.totalRub.toLocaleString("ru-RU")} ₽`, "");
  }

  if (summary.totalEvents === 0) {
    lines.push("Событий не было.");
    return lines.join("\n");
  }

  for (const row of summary.byName) {
    const label = EVENT_LABELS[row.event_name] || row.event_name;
    lines.push(`• ${label}: ${row.count}`);
  }

  if (summary.recentErrors.length > 0) {
    lines.push("", "Последние ошибки:");
    for (const e of summary.recentErrors) {
      const msg = e.props?.message || e.props?.error || "без описания";
      lines.push(`— ${String(msg).slice(0, 200)}`);
    }
  }

  return lines.join("\n");
}

/** Собирает и шлёт отчёт ПРЯМО СЕЙЧАС, без проверки "пора ли" — используется
 * и автоматическим тиком (через runDigest ниже), и командой /report из
 * webhook.js (см. planReplyForUpdate), когда захотелось посмотреть отчёт
 * без ожидания следующего DIGEST_HOUR. Обновляет last_digest_at в обоих
 * случаях — если админ запросил отчёт вручную посреди дня, автоматический
 * тик за тот же день его не задвоит. Не бросает исключение при неудаче
 * отправки (например, разработчик ещё не написал боту /start, и Telegram
 * не даёт слать в чат, который бот не открывал первым) — вызывающий код
 * логирует и пробует в следующий раз, процесс падать не должен. */
export async function sendDigestNow(db, { botToken, adminTelegramId }, now = new Date()) {
  if (!adminTelegramId) return { sent: false, reason: "ADMIN_TELEGRAM_ID не задан" };

  const lastDigestAt = getLastDigestAt(db);
  const sinceISO = lastDigestAt || new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const summary = summarizeEventsSince(db, sinceISO);
  const paymentsSummary = summarizePaymentsSince(db, sinceISO);
  const text = buildDigestText(summary, { sinceISO, now, paymentsSummary });

  try {
    await sendTelegramMessage(botToken, adminTelegramId, text, { parseMode: undefined });
    setLastDigestAt(db, now.toISOString());
    return { sent: true, summary };
  } catch (err) {
    console.error("[digest] не удалось отправить отчёт:", err.message);
    return { sent: false, reason: err.message };
  }
}

/** Обёртка sendDigestNow с проверкой "пора ли" — то, что реально зовёт
 * планировщик раз в сутки (см. index.js). */
export async function runDigest(db, { botToken, adminTelegramId, digestHour = 9 }, now = new Date()) {
  if (!adminTelegramId) return { sent: false, reason: "ADMIN_TELEGRAM_ID не задан" };

  const lastDigestAt = getLastDigestAt(db);
  if (!shouldRunDigest(now, lastDigestAt, digestHour)) return { sent: false, reason: "не время" };

  return sendDigestNow(db, { botToken, adminTelegramId }, now);
}
