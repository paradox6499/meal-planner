// Всё, что происходит с платежом ПОСЛЕ того, как у ЮKassa перепроверен его
// реальный статус (см. yookassa.js: fetchPaymentStatus): выдать оплаченное,
// обработать возврат, заметить подозрительное. Раньше эта логика жила прямо в
// обработчике вебхука в app.js — но вебхук единственный способ узнать об
// оплате, а он может не дойти (неверный URL в настройках ЮKassa, простой
// сервера дольше окна повторов ЮKassa): платёж навсегда оставался pending, а
// человек, заплативший деньги, не получал ничего. Теперь тот же код
// вызывается и из вебхука, и из сверки (reconcilePendingPayments) — сверка
// сама спрашивает ЮKassa про платежи, которые так и не подтвердились.
import { createHash } from "node:crypto";
import { fetchPaymentStatus } from "./yookassa.js";
import {
  getPaymentByYookassaId, updatePaymentStatus, addExtraPlanCredit, extendUserPro, shortenUserPro,
  consumeExtraPlanCredit, listPendingPayments,
} from "./db.js";
import { sendTelegramMessage, buildPaymentConfirmationText } from "./telegram.js";

export const PRO_PRODUCT = "pro";
export const EXTRA_PLAN_PRODUCT = "extra_plan";
export const PRO_PERIOD_DAYS = 30;
export const DEFAULT_WEBAPP_URL = "https://paradox6499.github.io/meal-planner/";

const AMOUNT_EPSILON = 0.005;
const RECONCILE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Ключ идемпотентности для создания платежа: один и тот же пользователь, тот
 * же товар и та же минута — один и тот же ключ, значит ЮKassa вернёт тот же
 * платёж, а не заведёт второй (двойной тап по "Оплатить", повтор запроса при
 * потерянном ответе). Через минуту ключ другой — осознанная новая попытка
 * после отказа/отмены не упирается в старый платёж. 64 hex-символа — ровно
 * максимум, который принимает ЮKassa. */
export function paymentIdempotenceKey(telegramUserId, product, nowMs = Date.now()) {
  return createHash("sha256").update(`${telegramUserId}|${product}|${Math.floor(nowMs / 60_000)}`).digest("hex");
}

/**
 * Применяет ПЕРЕПРОВЕРЕННЫЙ статус платежа к БД. Идемпотентна: повторный вызов
 * для того же платежа ничего не выдаёт второй раз.
 * @returns {{kind: string, chatId?: number, confirmationText?: string, existing?: object, detail?: string}}
 *   kind: unknown | owner_mismatch | amount_mismatch | fulfilled | refunded |
 *         partial_refund | status_updated | noop
 */
export function applyPaymentStatus(db, status, { nowISO = new Date().toISOString() } = {}) {
  const existing = getPaymentByYookassaId(db, status.id);
  if (!existing) return { kind: "unknown", detail: `metadata.telegram_user_id=${status.telegramUserId}` };

  // Уже разобранный вручную/возвращённый платёж повторными уведомлениями не
  // трогаем (и не алертим админа второй раз).
  if (existing.status === "refunded" || existing.status === "review") return { kind: "noop", existing };

  // Платёж не того пользователя или не на ту сумму — выдавать оплаченное по
  // нему нельзя, но и молча терять тоже: помечаем "review" (выходит из
  // pending, сверка не будет алертить каждые 10 минут) и сообщаем админу.
  if (status.telegramUserId != null && status.telegramUserId !== existing.telegram_user_id) {
    updatePaymentStatus(db, { yookassaPaymentId: status.id, status: "review", confirmedAtISO: null });
    return { kind: "owner_mismatch", existing, detail: `в ЮKassa получатель ${status.telegramUserId}, в базе ${existing.telegram_user_id}` };
  }
  if (status.amountRub != null && Math.abs(status.amountRub - existing.amount_rub) > AMOUNT_EPSILON) {
    updatePaymentStatus(db, { yookassaPaymentId: status.id, status: "review", confirmedAtISO: null });
    return { kind: "amount_mismatch", existing, detail: `в ЮKassa ${status.amountRub} ₽, в базе ${existing.amount_rub} ₽` };
  }

  // Возврат. Полный: статус refunded и, если оплаченное уже выдавалось, —
  // забираем его обратно. Частичный: только сообщаем админу, решать ему.
  if ((status.refundedAmountRub ?? 0) > 0) {
    const full = status.refundedAmountRub >= existing.amount_rub - AMOUNT_EPSILON;
    if (!full) return { kind: "partial_refund", existing, detail: `возвращено ${status.refundedAmountRub} из ${existing.amount_rub} ₽` };
    if (existing.status === "succeeded") {
      if (existing.product === EXTRA_PLAN_PRODUCT) consumeExtraPlanCredit(db, existing.telegram_user_id);
      else shortenUserPro(db, existing.telegram_user_id, { nowISO, days: PRO_PERIOD_DAYS });
    }
    updatePaymentStatus(db, { yookassaPaymentId: status.id, status: "refunded", confirmedAtISO: null });
    return { kind: "refunded", existing, detail: `${existing.product}, ${existing.amount_rub} ₽` };
  }

  if (status.status === "succeeded" && existing.status !== "succeeded") {
    updatePaymentStatus(db, { yookassaPaymentId: status.id, status: "succeeded", confirmedAtISO: nowISO });
    if (existing.product === EXTRA_PLAN_PRODUCT) {
      addExtraPlanCredit(db, existing.telegram_user_id);
      return { kind: "fulfilled", existing, chatId: existing.telegram_user_id, confirmationText: buildPaymentConfirmationText(EXTRA_PLAN_PRODUCT) };
    }
    const proUntil = extendUserPro(db, existing.telegram_user_id, { fromISO: nowISO, addDays: PRO_PERIOD_DAYS });
    return { kind: "fulfilled", existing, chatId: existing.telegram_user_id, confirmationText: buildPaymentConfirmationText(PRO_PRODUCT, proUntil) };
  }

  if (status.status !== existing.status && existing.status !== "succeeded") {
    updatePaymentStatus(db, { yookassaPaymentId: status.id, status: status.status, confirmedAtISO: null });
    return { kind: "status_updated", existing };
  }
  return { kind: "noop", existing };
}

/** Побочные эффекты результата applyPaymentStatus: подтверждение
 * пользователю с кнопкой открытия Mini App и алерт админу о том, что
 * требует человека. Всё best-effort — ни один сбой Telegram не откатывает
 * уже проведённую оплату. */
export async function notifyPaymentResult(result, { botToken, adminTelegramId = null, webAppUrl = DEFAULT_WEBAPP_URL }) {
  if (result.kind === "fulfilled") {
    try {
      await sendTelegramMessage(botToken, result.chatId, result.confirmationText, {
        replyMarkup: { inline_keyboard: [[{ text: "Открыть «Съедим»", web_app: { url: webAppUrl } }]] },
      });
    } catch (err) {
      console.error("[payments] не удалось отправить подтверждение оплаты:", err.message);
    }
    return;
  }

  const adminTexts = {
    unknown: `⚠️ ЮKassa прислала платёж, которого нет в базе (${result.detail}). Проверьте в личном кабинете ЮKassa.`,
    owner_mismatch: `⚠️ Платёж ${result.existing?.yookassa_payment_id}: получатель не совпал (${result.detail}). Оплаченное НЕ выдано, статус review.`,
    amount_mismatch: `⚠️ Платёж ${result.existing?.yookassa_payment_id}: сумма не совпала (${result.detail}). Оплаченное НЕ выдано, статус review.`,
    refunded: `↩️ Возврат по платежу ${result.existing?.yookassa_payment_id} (пользователь ${result.existing?.telegram_user_id}, ${result.detail}). Оплаченное снято автоматически.`,
    partial_refund: `↩️ Частичный возврат по платежу ${result.existing?.yookassa_payment_id} (пользователь ${result.existing?.telegram_user_id}, ${result.detail}). Ничего автоматически не менялось — решите вручную.`,
  };
  if (result.kind === "unknown") console.warn(`[payments] платёж не из нашей базы (${result.detail})`);
  const text = adminTexts[result.kind];
  if (!text || !adminTelegramId) return;
  try {
    await sendTelegramMessage(botToken, adminTelegramId, text);
  } catch (err) {
    console.error("[payments] не удалось отправить алерт админу:", err.message);
  }
}

// Когда платёж последний раз сверяли — чтобы вызов /api/plan-status (его
// дёргают часто) не превращался в запрос к ЮKassa на каждый раз для
// брошенных платежей. In-memory: после рестарта просто сверим ещё раз.
const lastChecked = new Map();
export function clearReconcileState() {
  lastChecked.clear();
}

/** Спрашивает у ЮKassa статус платежей, застрявших в pending (не старше 48 ч),
 * и применяет его. telegramUserId — только его платежи (вызов из
 * /api/plan-status, сразу после возвращения человека из оплаты), null — все
 * (периодический тик). Возвращает результаты applyPaymentStatus. */
export async function reconcilePendingPayments(db, yookassa, { telegramUserId = null, nowMs = Date.now(), limit = 20, minIntervalMs = 15_000 } = {}) {
  const pending = listPendingPayments(db, { sinceISO: new Date(nowMs - RECONCILE_MAX_AGE_MS).toISOString(), telegramUserId, limit });
  if (lastChecked.size > 1000) lastChecked.clear();
  const results = [];
  for (const payment of pending) {
    const last = lastChecked.get(payment.yookassa_payment_id);
    if (last && nowMs - last < minIntervalMs) continue;
    lastChecked.set(payment.yookassa_payment_id, nowMs);
    try {
      const status = await fetchPaymentStatus(yookassa, payment.yookassa_payment_id);
      results.push(applyPaymentStatus(db, status, { nowISO: new Date(nowMs).toISOString() }));
    } catch (err) {
      console.error(`[payments] сверка платежа ${payment.yookassa_payment_id} не удалась:`, err.message);
    }
  }
  return results;
}

/** Один проход периодической сверки (см. index.js) + уведомления. */
export async function runPaymentReconcileTick(db, yookassa, notifyOpts, nowMs = Date.now()) {
  const results = await reconcilePendingPayments(db, yookassa, { nowMs, minIntervalMs: 0 });
  for (const r of results) await notifyPaymentResult(r, notifyOpts);
  return results;
}
