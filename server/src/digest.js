// Ежедневный отчёт по событиям (см. events в db.js) прямо в личку разработчику
// от того же бота, который шлёт напоминания — переиспользуем sendTelegramMessage,
// отдельный канал/сервис (Sentry и т.п.) не заводим ради этого. Специально
// разделено на чистые функции (когда пора слать, что писать) и одну
// оркестрирующую runDigest — первые тестируются без сети и без времени "как есть".
import { summarizeEventsSince, getLastDigestAt, setLastDigestAt } from "./db.js";
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

const EVENT_LABELS = {
  app_error: "❗ ошибок в приложении",
  wizard_started: "визард начали",
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

export function buildDigestText(summary, { sinceISO, now }) {
  const periodHours = Math.max(1, Math.round((now.getTime() - new Date(sinceISO).getTime()) / 3_600_000));
  const lines = [`📊 Съедим — отчёт за последние ${periodHours} ч`, ""];

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

/** Возвращает { sent: boolean, ... } — не бросает исключение при неудаче
 * отправки (например, разработчик ещё не написал боту /start, и Telegram
 * не даёт слать в чат, который бот не открывал первым) — index.js логирует
 * и просто пробует на следующем тике, весь процесс падать не должен. */
export async function runDigest(db, { botToken, adminTelegramId, digestHour = 9 }, now = new Date()) {
  if (!adminTelegramId) return { sent: false, reason: "ADMIN_TELEGRAM_ID не задан" };

  const lastDigestAt = getLastDigestAt(db);
  if (!shouldRunDigest(now, lastDigestAt, digestHour)) return { sent: false, reason: "не время" };

  const sinceISO = lastDigestAt || new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const summary = summarizeEventsSince(db, sinceISO);
  const text = buildDigestText(summary, { sinceISO, now });

  try {
    await sendTelegramMessage(botToken, adminTelegramId, text, { parseMode: undefined });
    setLastDigestAt(db, now.toISOString());
    return { sent: true, summary };
  } catch (err) {
    console.error("[digest] не удалось отправить отчёт:", err.message);
    return { sent: false, reason: err.message };
  }
}
