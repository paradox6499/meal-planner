// Реферальная программа — "и тебе, и другу": оба получают бесплатные дни
// Pro, награда начисляется не за сам переход по ссылке (легко накрутить), а
// когда приглашённый РЕАЛЬНО соберёт свой первый план (событие уже
// существует — plan_generated/POST api/plan, ничего нового отслеживать не
// пришлось). Дни Pro — а не деньги/скидка: ничего не стоит начислить лишний
// раз, в отличие от реальной скидки на оплату.
import { userExists, claimReferral as dbClaimReferral, getPendingReferral, markReferralRewarded, countRewardedReferrals, extendUserPro } from "./db.js";
import { sendTelegramMessage } from "./telegram.js";

export const REFERRAL_REWARD_DAYS = 7;
// Потолок НАГРАЖДЁННЫХ рефералов на одного пригласившего — 12 × 7 = 84 дня
// (около трёх месяцев) бесплатного Pro суммарно за рефералов, разумный
// верхний предел без реального риска, что кто-то заведёт себе бесконечный
// бесплатный тариф на пачке новых аккаунтов. Приглашённый получает свою
// награду в любом случае — потолок ограничивает только пригласившего.
export const MAX_REWARDED_REFERRALS = 12;

export function buildReferralRewardText(days) {
  return `🎉 Ваш друг собрал первый план — вам начислено ${days} ${pluralDays(days)} Pro. Спасибо, что рассказали о «Съедим»!`;
}

function pluralDays(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "дня";
  return "дней";
}

/** Регистрирует "referredTelegramId пришёл по ссылке referrerTelegramId" —
 * best-effort и намеренно тихий на все некритичные отказы (самоприглашение,
 * уже существующий пользователь, уже была заявка на этого приглашённого) —
 * ни один из них не должен выглядеть как ошибка сервера перед пользователем,
 * это просто "реферал не засчитан", решается на уровне бизнес-логики, не HTTP. */
export function claimReferral(db, { referrerTelegramId, referredTelegramId, nowISO }) {
  if (referrerTelegramId === referredTelegramId) {
    return { ok: false, reason: "нельзя пригласить самого себя" };
  }
  if (userExists(db, referredTelegramId)) {
    return { ok: false, reason: "пользователь уже существует — реферал засчитывается только новым" };
  }
  try {
    dbClaimReferral(db, { referrerTelegramId, referredTelegramId, createdAtISO: nowISO });
    return { ok: true };
  } catch (err) {
    if (String(err.message).includes("UNIQUE constraint failed")) {
      return { ok: false, reason: "у этого пользователя уже есть пригласивший" };
    }
    throw err;
  }
}

/** Вызывается после того, как пользователь реально собрал план (см. app.js:
 * POST /api/plan) — если у него есть ОЖИДАЮЩИЙ реферал (см. claimReferral
 * выше), начисляет награду обеим сторонам и помечает реферал как
 * вознаграждённый, чтобы не начислить дважды. Ошибка отправки сообщения
 * пригласившему НЕ должна откатывать уже начисленные дни — они реальны
 * независимо от того, удалось ли уведомить. */
export async function maybeRewardReferral(db, referredTelegramId, { botToken }, nowISO = new Date().toISOString()) {
  const pending = getPendingReferral(db, referredTelegramId);
  if (!pending) return { rewarded: false };

  extendUserPro(db, referredTelegramId, { fromISO: nowISO, addDays: REFERRAL_REWARD_DAYS });

  const referrerCapped = countRewardedReferrals(db, pending.referrer_telegram_id) >= MAX_REWARDED_REFERRALS;
  if (!referrerCapped) {
    extendUserPro(db, pending.referrer_telegram_id, { fromISO: nowISO, addDays: REFERRAL_REWARD_DAYS });
  }
  markReferralRewarded(db, referredTelegramId, nowISO);

  if (!referrerCapped) {
    try {
      await sendTelegramMessage(botToken, pending.referrer_telegram_id, buildReferralRewardText(REFERRAL_REWARD_DAYS));
    } catch (err) {
      console.error(`[referrals] не удалось уведомить пригласившего user=${pending.referrer_telegram_id}:`, err.message);
    }
  }

  return { rewarded: true, referrerTelegramId: pending.referrer_telegram_id, referrerRewarded: !referrerCapped };
}
