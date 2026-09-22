// Тонкий клиент API ЮKassa (https://yookassa.ru/developers/api) — только то,
// что нужно для оплаты подписки "Pro": создать платёж (checkout-ссылка,
// открывается из мини-приложения) и ПРОВЕРИТЬ его реальный статус напрямую у
// ЮKassa (см. комментарий у fetchPaymentStatus — это не формальность, а
// единственный безопасный способ доверять "оплачено").
//
// Auth — HTTP Basic (shopId:secretKey), как у большинства платёжных API.
// Оба значения передаются параметром при каждом вызове (не читаются из env
// тут же) — тот же принцип, что и у sendTelegramMessage в telegram.js: этот
// модуль не должен знать, откуда взялся секрет, это дело index.js.

const API_BASE = "https://api.yookassa.ru/v3";

function authHeader(shopId, secretKey) {
  return "Basic " + Buffer.from(`${shopId}:${secretKey}`).toString("base64");
}

/**
 * @param {{shopId: string, secretKey: string}} creds
 * @param {{amountRub: number, description: string, returnUrl: string, telegramUserId: number, idempotenceKey: string, receiptEmail: string}} params
 * idempotenceKey — свой (не сгенерированный тут), чтобы вызывающий код мог
 * гарантированно не создать дубль платежа при повторе запроса (например,
 * если ответ ЮKassa потерялся в сети, а фронтенд ретраит) — тот же payment
 * id вернётся повторно вместо второго списания.
 *
 * receipt — обязателен для этого магазина (живая жалоба в чате: без него
 * ЮKassa отвечала "Receipt is missing or illegal") — магазин подключён с
 * онлайн-кассой (обычная схема для ИП), она требует фискальный чек на
 * КАЖДЫЙ платёж по 54-ФЗ. customer.email — обязательный контакт покупателя
 * для чека (см. lib/payerContact.js на фронтенде, Telegram email не даёт).
 * vat_code: 1 = "без НДС" — верно для ИП на УСН (самый частый случай для
 * такого масштаба); если ИП на другом налоговом режиме, это число нужно
 * поменять на соответствующий код ЮKassa.
 */
export async function createPayment({ shopId, secretKey }, { amountRub, description, returnUrl, telegramUserId, idempotenceKey, receiptEmail }) {
  const amount = { value: amountRub.toFixed(2), currency: "RUB" };
  const res = await fetch(`${API_BASE}/payments`, {
    method: "POST",
    headers: {
      Authorization: authHeader(shopId, secretKey),
      "Content-Type": "application/json",
      "Idempotence-Key": idempotenceKey,
    },
    body: JSON.stringify({
      amount,
      confirmation: { type: "redirect", return_url: returnUrl },
      capture: true,
      description,
      metadata: { telegram_user_id: String(telegramUserId) },
      receipt: {
        customer: { email: receiptEmail },
        items: [
          {
            description,
            quantity: "1.00",
            amount,
            vat_code: 1,
            payment_mode: "full_payment",
            payment_subject: "service",
          },
        ],
      },
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`ЮKassa createPayment: ${body?.description || body?.code || res.status}`);
  }
  return { id: body.id, status: body.status, confirmationUrl: body.confirmation?.confirmation_url ?? null };
}

/** ЮKassa НЕ подписывает вебхуки — доверять телу POST-уведомления напрямую
 * значило бы, что любой в интернете, узнавший наш URL вебхука и формат
 * payload'а, может "оплатить" себе Pro одним поддельным запросом. Вместо
 * этого: получив ЛЮБОЕ уведомление (или просто на всякий случай), спрашиваем
 * статус НАПРЯМУЮ у ЮKassa, используя свои же учётные данные — подделать
 * такой ответ невозможен, это и есть единственная точка доверия. См.
 * app.js: POST /yookassa/webhook. */
export async function fetchPaymentStatus({ shopId, secretKey }, paymentId) {
  const res = await fetch(`${API_BASE}/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
    headers: { Authorization: authHeader(shopId, secretKey) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`ЮKassa fetchPaymentStatus: ${body?.description || body?.code || res.status}`);
  }
  return {
    id: body.id,
    status: body.status, // "pending" | "waiting_for_capture" | "succeeded" | "canceled"
    paid: !!body.paid,
    amountRub: body.amount ? Number(body.amount.value) : null,
    telegramUserId: body.metadata?.telegram_user_id ? Number(body.metadata.telegram_user_id) : null,
  };
}
