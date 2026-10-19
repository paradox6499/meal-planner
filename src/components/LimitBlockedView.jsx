// Экран «Бесплатный лимит на этой неделе исчерпан»: дата следующего бесплатного
// плана, разовая покупка и Pro.
import { Sparkles } from "lucide-react";
import { styles, ACCENT } from "../styles.js";
import { formatResetDate } from "../lib/format.js";
import { hapticImpact } from "../lib/haptics.js";
import { trackEvent } from "../lib/analytics.js";
import { StepShell } from "./common.jsx";
import { PRO_PRICE_RUB, EXTRA_PLAN_PRICE_RUB } from "./ProModals.jsx";

export function LimitBlockedView({ nextResetHint, done, onOpenExtraPlan, onOpenPro, onBack }) {
  return (
    <div style={styles.stepBody} className="mp-step-body">
      <StepShell icon={<Sparkles size={20} color={ACCENT} />} title="Бесплатный лимит на этой неделе исчерпан" sub="На бесплатном тарифе доступен 1 план в неделю">
        {/* UX-аудит 29.09.2026: nextResetHint приходил с сервера, но
            нигде не показывался — везде было расплывчатое "позже". */}
        <p style={{ ...styles.acctSectionHint, marginTop: 0 }}>
          {formatResetDate(nextResetHint)
            ? <>Следующий бесплатный план — <b>{formatResetDate(nextResetHint)}</b>. Или соберите новый прямо сейчас:</>
            : "Новый бесплатный план будет доступен позже. Или соберите новый прямо сейчас:"}
        </p>
        {/* Одно главное действие вместо двух конкурирующих кнопок
            (UX-аудит): разовая покупка — залитая основная кнопка, Pro —
            строка-ссылка под ней с ценой и главным аргументом. */}
        <button
          onClick={() => { hapticImpact("light"); trackEvent("extra_plan_modal_opened", { source: "limit_blocked" }); onOpenExtraPlan(); }}
          style={{ ...styles.navBtnPrimary, width: "100%", justifyContent: "center" }}
        >
          Собрать сейчас — {EXTRA_PLAN_PRICE_RUB} ₽
        </button>
        <button
          onClick={() => { hapticImpact("light"); trackEvent("pro_modal_opened", { source: "limit_blocked" }); onOpenPro(); }}
          style={styles.proLinkBtn}
        >
          Или Pro: {PRO_PRICE_RUB} ₽ за 30 дней, без автосписания — безлимит, напоминания, семья
        </button>
        <button onClick={onBack} style={styles.limitBackBtn}>{done ? "Назад к моему плану" : "Назад"}</button>
      </StepShell>
    </div>
  );
}
