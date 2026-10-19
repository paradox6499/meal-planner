// Экран «ваш последний план», когда бесплатный лимит исчерпан.

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { describePlanDay } from "../lib/planDays.js";
import { styles, ACCENT } from "../styles.js";
import { HISTORY_DAY_EMOJI_FALLBACK } from "../constants.js";
import { formatResetDate } from "../lib/format.js";
import { StepShell } from "./common.jsx";
import { RecipeModal } from "./RecipeModal.jsx";
import { EXTRA_PLAN_PRICE_RUB, PRO_PRICE_RUB } from "./ProModals.jsx";

export function LastPlanGateView({ latest, nextResetHint, onOpenPro, onOpenExtraPlan }) {
  const [openRecipe, setOpenRecipe] = useState(null);
  const dateLabel = new Date(latest.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  // Живая жалоба в чате: "не могу провалиться в план, увидеть КБЖУ,
  // ингредиенты" — планы, собранные ДО того, как история стала хранить
  // полный рецепт (см. handleFinish), физически не несут dm.ingr — блюдо
  // остаётся простым текстом ниже, без объяснения почему. Раньше это просто
  // выглядело как "ничего не происходит по клику", теперь — явная подсказка.
  const anyMissingRecipe = latest.plan?.days?.some((d) => d.dayMeals.some((dm) => !dm.ingr));
  return (
    <div style={styles.stepBody} className="fade-in-up mp-step-body">
      <StepShell icon={<Sparkles size={20} color={ACCENT} />} title="Ваш план на эту неделю" sub={`Собран ${dateLabel} · ${latest.storeName}`}>
        <div style={styles.stack}>
          {latest.plan?.days?.map((d) => (
            <div key={d.day} style={styles.historyDay}>
              <span style={styles.historyDayLabel}>{describePlanDay(latest.createdAt, d.day)?.label ?? `День ${d.day}`}</span>
              <span>
                {d.dayMeals.map((dm, i) => (
                  <span key={i}>
                    {i > 0 && " · "}
                    {dm.ingr ? (
                      <button
                        className="recipe-row-btn"
                        onClick={() =>
                          setOpenRecipe({
                            recipe: { name: dm.name, emoji: dm.emoji, photoUrl: dm.photoUrl, time: dm.time, ingr: dm.ingr, steps: dm.steps, nutritionPer100g: dm.nutritionPer100g },
                            cost: dm.cost, isRealPrice: dm.isRealPrice, family: dm.family || latest.family || 1,
                          })
                        }
                        style={styles.historyDishBtn}
                      >
                        {dm.emoji || HISTORY_DAY_EMOJI_FALLBACK} {dm.name}
                      </button>
                    ) : (
                      <>{dm.emoji || HISTORY_DAY_EMOJI_FALLBACK} {dm.name}</>
                    )}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
        <p style={{ ...styles.acctSectionHint, marginTop: 14 }}>
          {latest.totalCost != null ? `${latest.totalCost.toLocaleString("ru-RU")} ₽` : "без цены"} из {latest.budget.toLocaleString("ru-RU")} ₽ · на {latest.family} {latest.family === 1 ? "человека" : "человек"}
        </p>
        {anyMissingRecipe && (
          <p style={{ ...styles.acctSectionHint, marginTop: 0, color: "var(--warning-text)" }}>
            Блюда без подчёркивания — рецепт для них не сохранён (план собран до обновления). У новых планов рецепт открывается по клику на каждое блюдо.
          </p>
        )}
        <p style={{ ...styles.acctSectionHint, marginTop: 0 }}>
          {formatResetDate(nextResetHint)
            ? <>Следующий бесплатный план — <b>{formatResetDate(nextResetHint)}</b>. Или соберите новый прямо сейчас:</>
            : "Новый бесплатный план будет доступен позже. Или соберите новый прямо сейчас:"}
        </p>
        <button onClick={onOpenExtraPlan} style={{ ...styles.navBtnPrimary, width: "100%", justifyContent: "center" }}>
          Собрать сейчас — {EXTRA_PLAN_PRICE_RUB} ₽
        </button>
        <button onClick={onOpenPro} style={styles.proLinkBtn}>
          Или Pro: {PRO_PRICE_RUB} ₽ за 30 дней, без автосписания — безлимит, напоминания, семья
        </button>
      </StepShell>
      {openRecipe && <RecipeModal dm={openRecipe} family={openRecipe.family} onClose={() => setOpenRecipe(null)} />}
    </div>
  );
}
