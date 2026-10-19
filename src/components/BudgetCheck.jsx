// Подсказка под слайдером бюджета: «маловато / впритык / хватит / с запасом» и кнопка с разумной суммой.
// Оценка — ориентир (см. lib/budgetCheck.js), не обещание: итог плана зависит от рациона, аллергий и каталога.
import { Info, TriangleAlert, Check } from "lucide-react";
import { styles } from "../styles.js";
import { hapticSelect } from "../lib/haptics.js";
import { trackEvent } from "../lib/analytics.js";
import { estimateWeek, assessBudget, budgetMessage } from "../lib/budgetCheck.js";

const TONE = {
  low: { bg: "var(--danger-soft)", fg: "var(--danger-text)", Icon: TriangleAlert },
  tight: { bg: "var(--warning-soft)", fg: "var(--warning-text)", Icon: Info },
  ok: { bg: "rgba(10,132,255,0.12)", fg: "var(--text-primary)", Icon: Check },
  rich: { bg: "rgba(10,132,255,0.12)", fg: "var(--text-primary)", Icon: Check },
};

export function BudgetCheck({ budget, setBudget, meals, family, familyByMeal, store, min = 1500, max = 15000, step = 250 }) {
  const assessment = assessBudget(budget, estimateWeek({ meals, family, familyByMeal, store }), { min, max, step });
  if (!assessment) return null;
  const { title, text } = budgetMessage(assessment);
  const { bg, fg, Icon } = TONE[assessment.level];

  return (
    <div role="status" aria-live="polite" style={{ marginTop: 14, padding: "12px 14px", borderRadius: 16, background: bg }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 14, color: fg }}>
        <Icon size={16} style={{ flexShrink: 0 }} /> {title}
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 12.5, lineHeight: 1.45, color: "var(--text-secondary)" }}>{text}</p>
      {assessment.suggest && (
        <button
          type="button"
          onClick={() => { hapticSelect(); trackEvent("budget_hint_applied", { level: assessment.level }); setBudget(assessment.suggest); }}
          style={{ ...styles.pillChip(false), marginTop: 10 }}
        >
          Поставить {assessment.suggest.toLocaleString("ru-RU")} ₽
        </button>
      )}
    </div>
  );
}
