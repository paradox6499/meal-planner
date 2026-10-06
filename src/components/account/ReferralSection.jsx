// Раздел «Пригласить друга» в Аккаунте.

import { Users, Share2 } from "lucide-react";
import { trackEvent } from "../../lib/analytics.js";
import { hapticImpact } from "../../lib/haptics.js";
import { styles, ACCENT } from "../../styles.js";
import { pluralDaysRu } from "../../lib/format.js";
import { BOT_SHARE_URL, shareViaTelegram } from "../../lib/share.js";

// Реферальная программа (см. server/src/referrals.js) — "и тебе, и другу":
// награда начисляется не за переход по ссылке (легко накрутить), а когда
// приглашённый реально соберёт свой первый план. 7 — дублирует
// REFERRAL_REWARD_DAYS на сервере (тот же принцип, что и у 299 ₽/30 дней в
// ProModal ниже: цифра, которую видит пользователь ДО того, как что-то
// произошло, неизбежно живёт на фронтенде отдельной строкой от источника
// истины на сервере — держите их в синхроне вручную, если поменяются).
export const REFERRAL_REWARD_DAYS_LABEL = 7;

export function ReferralSection({ referralStatus }) {
  // Вне Telegram (обычный браузер) initDataUnsafe.user не существует —
  // ссылка вида "?startapp=ref_undefined" никуда не привела бы осмысленно,
  // честнее не показывать блок вообще, чем показать нерабочую кнопку.
  const myTelegramId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
  if (!myTelegramId) return null;

  const referralLink = `${BOT_SHARE_URL}?startapp=ref_${myTelegramId}`;
  const shareText = "Я планирую меню и список покупок с реальными ценами в «Съедим» — присоединяйся, соберёшь первый план, и мы оба получим неделю Pro бесплатно! 🎁";

  return (
    <div style={styles.acctSection}>
      <div style={styles.subCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Users size={16} color={ACCENT} />
          <span style={{ fontWeight: 700, fontSize: 15 }}>Пригласить друга</span>
        </div>
        <p style={styles.acctSectionHint}>
          Друг соберёт свой первый план — и вы оба получите {REFERRAL_REWARD_DAYS_LABEL} дней Pro бесплатно.
          Работает для тех, кто открывает «Съедим» впервые: если друг уже пользовался приложением, бонус не начислится.
        </p>
        {referralStatus?.rewardedCount > 0 && (
          <p style={{ ...styles.acctSectionHint, fontWeight: 600 }}>
            Уже пригласили: {referralStatus.rewardedCount} · начислено {referralStatus.daysEarned} {pluralDaysRu(referralStatus.daysEarned)} Pro
          </p>
        )}
        <button
          onClick={() => { hapticImpact("light"); trackEvent("referral_share_clicked"); shareViaTelegram(shareText, referralLink); }}
          style={{ ...styles.orderBtn, marginTop: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
        >
          <Share2 size={15} /> Поделиться ссылкой
        </button>
      </div>
    </div>
  );
}
