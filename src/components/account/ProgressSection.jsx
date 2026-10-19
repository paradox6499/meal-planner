// Раздел «Прогресс» (серия в бюджете, экономия) в Аккаунте.

import { Flame, Wallet } from "lucide-react";
import { computeBudgetStreak, computeRecentSavings } from "../../lib/planLogic.js";
import { styles, ACCENT } from "../../styles.js";
import { pluralWeeks } from "../../lib/format.js";

// Геймификация — намеренно не очки/уровни/соревнование с другими (аудитория
// здесь экономит, а не соревнуется, см. обсуждение в чате), а честное
// отражение того, что человек и так делает: серия недель в рамках своего же
// бюджета + сколько сэкономил. Считается на лету из уже загруженной истории
// планов (computeBudgetStreak/computeRecentSavings в lib/planLogic.js) —
// никакого нового сбора данных не понадобилось. Не рендерится вообще, если
// показывать нечего (streak=0 и savings<=0) — молчаливое "у вас пока
// нулевые достижения" не мотивирует, лучше просто не показывать блок, пока
// не появится что-то реально положительное.
export function ProgressSection({ planHistory }) {
  if (!planHistory || planHistory.length === 0) return null;
  const streak = computeBudgetStreak(planHistory);
  const savings = computeRecentSavings(planHistory);
  if (streak === 0 && savings <= 0) return null;

  return (
    <div style={styles.acctSection}>
      <div style={styles.progressCardsRow}>
        {streak > 0 && (
          <div style={styles.progressCard}>
            <Flame size={18} color="#E8935A" />
            <div style={styles.progressCardValue}>{streak}</div>
            <div style={styles.progressCardLabel}>{pluralWeeks(streak)} подряд в бюджете</div>
          </div>
        )}
        {savings > 0 && (
          <div style={styles.progressCard}>
            <Wallet size={18} color={ACCENT} />
            <div style={styles.progressCardValue}>{savings.toLocaleString("ru-RU")} ₽</div>
            <div style={styles.progressCardLabel}>сэкономлено за последние планы</div>
          </div>
        )}
      </div>
    </div>
  );
}
