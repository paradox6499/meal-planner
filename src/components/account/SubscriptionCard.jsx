// Карточка тарифа в Аккаунте.

import { Sparkles } from "lucide-react";
import { hapticImpact } from "../../lib/haptics.js";
import { styles, ACCENT } from "../../styles.js";
import { formatResetDate } from "../../lib/format.js";

// Раньше в Аккаунте был мини-аккордеон с тем же списком, что и здесь — теперь
// он переехал в отдельный полноэкранный ProModal (пользователь в чате прямо
// это попросил: компактная карточка в Аккаунте + большое окно с полным
// питчем и ценой по кнопке "Открыть Pro", а не два дублирующих друг друга
// списка). Карточка в Аккаунте теперь просто честно называет, что доступно
// сейчас, и одной кнопкой ведёт к продающему экрану.
export function AccountSubscriptionCard({ onOpenPro, planStatus }) {
  // planStatus === null — либо бэкенд не задеплоен, либо ещё грузится:
  // в обоих случаях честнее не утверждать конкретную цифру лимита, раз мы
  // её на самом деле не знаем прямо сейчас.
  const isPro = planStatus?.isPro ?? false;
  const proUntilLabel = formatResetDate(planStatus?.proUntil);
  // Pro уже был и закончился — для него это «продлить», а не «открыть» (в
  // семейном блоке той же страницы уже написано «Продлить Pro»).
  const proEndedLabel = !isPro ? formatResetDate(planStatus?.proEndedAt) : null;
  const nextFreeLabel = !isPro && planStatus && planStatus.canGenerate === false ? formatResetDate(planStatus.nextResetHint) : null;
  return (
    <div style={styles.acctSection}>
      <div style={styles.subCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Sparkles size={16} color={ACCENT} />
          <span style={{ fontWeight: 700, fontSize: 15 }}>Подписка</span>
          <span style={isPro ? styles.proBadge : styles.freeBadge}>{isPro ? "Pro" : "Free"}</span>
        </div>
        {isPro ? (
          <p style={styles.acctSectionHint}>
            {proUntilLabel ? `Pro активен до ${proUntilLabel}` : "Pro активен"} — пересборка плана без ограничений. Автосписания нет: продлить можно вручную, когда захотите.
          </p>
        ) : (
          <p style={styles.acctSectionHint}>
            {proEndedLabel ? `Pro закончился ${proEndedLabel}. ` : ""}На бесплатном тарифе — 1 план в неделю
            {nextFreeLabel ? `; следующий бесплатный — ${nextFreeLabel}` : planStatus ? "; сейчас он доступен" : ""}.
            Pro снимает это ограничение и добавляет напоминания, несколько планов и общий список на семью.
          </p>
        )}
        {/* Действующему Pro с оплаченным сроком — "Продлить" (раньше кнопки
            не было вообще, а напоминание бота отправляло именно сюда). Pro без
            срока (ручной тумблер админа) продлевать нечем. */}
        {(!isPro || planStatus?.proUntil) && (
          <button onClick={() => { hapticImpact("light"); onOpenPro(); }} style={{ ...styles.orderBtn, marginTop: 4 }}>
            {isPro || proEndedLabel ? "Продлить Pro" : "Открыть Pro"}
          </button>
        )}
      </div>
    </div>
  );
}
