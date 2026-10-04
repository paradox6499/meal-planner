// Ежедневный отчёт по событиям (см. events в db.js) прямо в личку разработчику
// от того же бота, который шлёт напоминания — переиспользуем sendTelegramMessage,
// отдельный канал/сервис (Sentry и т.п.) не заводим ради этого. Специально
// разделено на чистые функции (когда пора слать, что писать) и одну
// оркестрирующую runDigest — первые тестируются без сети и без времени "как есть".
import { summarizeEventsSince, getLastDigestAt, setLastDigestAt, summarizePaymentsSince, countStalePendingPayments, getDbSizeBytes } from "./db.js";
import { sendTelegramMessage } from "./telegram.js";
import { getCatalogState } from "./catalogMonitor.js";

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
  plan_generated_credit: "планов собрано (по кредиту)",
  pro_modal_opened: "открыли экран подписки",
  pro_subscribe_clicked: "нажали «Оформить подписку»",
  order_clicked: "нажали «Заказать»",
  substitute_used: "заменили товар",
  share_clicked: "поделились списком",
  support_clicked: "открыли поддержку",
  home_screen_prompted: "предложили «на экран»",
  home_screen_added: "добавили на экран",
  extra_plan_modal_opened: "открыли «ещё один план»",
  extra_plan_buy_clicked: "нажали «Купить план»",
  family_created: "создали семью",
  family_left: "вышли из семьи / распустили",
  family_invite_shared: "поделились приглашением в семью",
  referral_share_clicked: "поделились реферальной ссылкой",
  plan_slot_add_started: "начали «ещё план» (Pro)",
  plan_slot_switched: "переключили план (Pro)",
  plan_slot_removed: "удалили план (Pro)",
  recipe_video_search_clicked: "открыли поиск видео-рецепта",
  profile_auto_saved: "профиль сохранился сам",
};

// paymentsSummary — { count, totalRub } (см. db.js:summarizePaymentsSince).
// Раньше отчёт целиком обрывался на "Событий не было", если totalEvents===0
// — платежи (payments — отдельная таблица, не events) в этом случае вообще
// не показывались бы, даже если за тот же день кто-то реально оплатил Pro.
// Теперь блок с оплатами не зависит от того, были ли события.
export function buildDigestText(summary, { sinceISO, now, paymentsSummary = { count: 0, totalRub: 0 }, stalePending = 0, dbSizeBytes = null, catalogDown = null }) {
  const periodHours = Math.max(1, Math.round((now.getTime() - new Date(sinceISO).getTime()) / 3_600_000));
  const lines = [`📊 Съедим — отчёт за последние ${periodHours} ч`, ""];

  if (paymentsSummary.count > 0) {
    lines.push(`💳 Оплат Pro: ${paymentsSummary.count} на ${paymentsSummary.totalRub.toLocaleString("ru-RU")} ₽`, "");
  }

  // Платёж, висящий в pending дольше часа, — вебхук ЮKassa, скорее всего, не
  // дошёл, и человек заплатил, ничего не получив (сверка по расписанию его
  // подхватит, но видеть это админу нужно).
  if (stalePending > 0) {
    lines.push(`⚠️ Платежей в ожидании дольше часа: ${stalePending} — проверьте вебхук в личном кабинете ЮKassa`, "");
  }
  // Каталог ВкусВилл с сервера не отвечает (см. catalogMonitor.js) — главное, что
  // ломает продукт, должно быть видно сразу в первой же строке отчёта.
  if (catalogDown) {
    lines.splice(2, 0, `🛑 ВкусВилл с сервера не отвечает: ${catalogDown.detail}${catalogDown.httpStatus ? ` [HTTP ${catalogDown.httpStatus}]` : ""} — планы собираются без каталога`, "");
  }
  const tail = dbSizeBytes != null ? ["", `💾 База данных: ${(dbSizeBytes / 1_048_576).toFixed(1)} МБ`] : [];

  if (summary.totalEvents === 0) {
    lines.push("Событий не было.", ...tail);
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

  lines.push(...tail);
  return lines.join("\n");
}

/** Собирает и шлёт отчёт ПРЯМО СЕЙЧАС, без проверки "пора ли" — используется
 * и автоматическим тиком (через runDigest ниже), и командой /report из
 * webhook.js (см. planReplyForUpdate), когда захотелось посмотреть отчёт
 * без ожидания следующего DIGEST_HOUR.
 *
 * updateWatermark — по умолчанию true (нужно ежедневному автотику: он же
 * читает last_digest_at через shouldRunDigest, и без обновления слал бы
 * дубль в тот же день). Ручной /report вызывается с updateWatermark:false
 * (см. app.js) — иначе получалась путаница из чата: "/report пишет
 * 'событий не было', хотя другой пользователь час назад собирал план" —
 * админ незадолго до этого уже проверял /report, тот СБРОСИЛ окно "с
 * последнего раза" на момент проверки, и событие пользователя, случившееся
 * ДО этого сброса, просто выпало из следующего отчёта. /report — это
 * "посмотреть, что происходит", а не "отметить как прочитанное"; сбрасывать
 * окно должен только настоящий ежедневный тик, а не количество раз, сколько
 * админ заглянул из любопытства.
 *
 * Не бросает исключение при неудаче отправки (например, разработчик ещё не
 * написал боту /start, и Telegram не даёт слать в чат, который бот не
 * открывал первым) — вызывающий код логирует и пробует в следующий раз,
 * процесс падать не должен. */
export async function sendDigestNow(db, { botToken, adminTelegramId }, now = new Date(), { updateWatermark = true } = {}) {
  if (!adminTelegramId) return { sent: false, reason: "ADMIN_TELEGRAM_ID не задан" };

  const lastDigestAt = getLastDigestAt(db);
  const sinceISO = lastDigestAt || new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const summary = summarizeEventsSince(db, sinceISO);
  const paymentsSummary = summarizePaymentsSince(db, sinceISO);
  const stalePending = countStalePendingPayments(db, {
    olderThanISO: new Date(now.getTime() - 3_600_000).toISOString(),
    newerThanISO: new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString(),
  });
  const text = buildDigestText(summary, { sinceISO, now, paymentsSummary, stalePending, dbSizeBytes: getDbSizeBytes(db), catalogDown: (() => { const c = getCatalogState(); return c.ok === false ? c.lastProbe : null; })() });

  try {
    await sendTelegramMessage(botToken, adminTelegramId, text);
    if (updateWatermark) setLastDigestAt(db, now.toISOString());
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
