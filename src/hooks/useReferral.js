// Реферальная программа: заявка «меня пригласили» по ссылке и прогресс в Аккаунте.
import { useState, useEffect } from "react";
import { claimReferral, fetchReferralStatus, checkPlanStatus } from "../lib/backend.js";

/**
 * @param {{ showAccount: boolean }} opts — прогресс приглашений спрашивается при открытии Аккаунта
 * @returns {{ referralStatus: null | { rewardedCount: number, daysEarned: number }, referralNote: boolean, setReferralNote: (v: boolean) => void }}
 */
export function useReferral({ showAccount }) {
  const [referralStatus, setReferralStatus] = useState(null);
  useEffect(() => {
    if (!showAccount) return;
    fetchReferralStatus().then(setReferralStatus);
  }, [showAccount]);

  // Реферальная ссылка — t.me/s_edim_bot?startapp=ref_<id> (см. AccountView,
  // "Пригласить друга"). start_param — официальный механизм Telegram
  // Mini Apps для передачи параметра при открытии ИМЕННО приложения (не
  // чата с ботом, это другой сценарий — см. server/src/webhook.js). Шлём
  // регистрацию один раз при монтировании, best-effort — сервер сам решит,
  // засчитывать ли (самоприглашение/уже существующий пользователь/уже был
  // приглашён кем-то другим, см. server/src/referrals.js), фронтенду
  // результат не нужен.
  //
  // Порядок важен: MealPlanner вызывает этот хук ДО эффекта синхронизации
  // плана (submitPlanToBackend) — синхронизация создаёт строку пользователя на
  // сервере, после чего заявка была бы отклонена как «уже существует».
  useEffect(() => {
    const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
    const match = /^ref_(\d+)$/.exec(startParam || "");
    if (match) {
      claimReferral(Number(match[1])).then((result) => {
        // Отказ "вы уже пользовались приложением" раньше не видел никто: проверка
        // ссылки на втором аккаунте, который уже собирал план, выглядела как
        // "реферальная программа не работает" (жалоба 04.10.2026). Это правило
        // (бонус только новым пользователям — иначе его можно накручивать самому
        // себе), его надо просто объяснить.
        if (result && result.claimed === false && /уже существует/.test(result.reason || "")) setReferralNote(true);
        // Приглашение принято: на первом шаге скажем, что за первый план полагается подарок.
        if (result && result.claimed === true) setInvitedByFriend(true);
      });
    }
  }, []);
  const [referralNote, setReferralNote] = useState(false);
  const [invitedByFriend, setInvitedByFriend] = useState(false);

  return { referralStatus, referralNote, setReferralNote, invitedByFriend };
}

/** Подарок приглашённому: награда начисляется на сервере, когда он собрал первый план, а приложение об этом не
 * знало («Продлить Pro» без объяснений). Когда план готов, спрашиваем статус и, если Pro появился, говорим об этом.
 * @param {{ invitedByFriend: boolean, planReady: boolean, onStatus?: (status: object) => void }} opts
 * @returns {string | null} дата окончания подаренного Pro (ISO) или null */
export function useReferralGift({ invitedByFriend, planReady, onStatus }) {
  const [giftUntil, setGiftUntil] = useState(null);
  useEffect(() => {
    if (!invitedByFriend || !planReady || giftUntil) return undefined;
    let cancelled = false;
    // Награду сервер начисляет уже после ответа на учёт сборки — спрашиваем с небольшими паузами.
    const timers = [2500, 8000].map((ms) => setTimeout(async () => {
      const status = await checkPlanStatus();
      if (cancelled || !status?.isPro || !status.proUntil) return;
      setGiftUntil((prev) => prev || status.proUntil);
      onStatus?.(status);
    }, ms));
    return () => { cancelled = true; timers.forEach(clearTimeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onStatus — стабильный сеттер
  }, [invitedByFriend, planReady, giftUntil]);
  return giftUntil;
}
