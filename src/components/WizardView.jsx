// Шаги визарда сборки плана (магазин, семья, приёмы пищи, бюджет, рацион,
// аллергии) и кнопки навигации. Только разметка: состояние визарда и сама
// сборка (handleFinish) живут в MealPlanner (App.jsx).
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Store, Users, Wallet, Salad, Ban, UtensilsCrossed } from "lucide-react";
import { ALLERGENS } from "../data/recipes.js";
import { styles, ACCENT } from "../styles.js";
import { DEFAULT_STORE, STORES, MEALS, DIETS } from "../constants.js";
import { mealsPerDayLabel } from "../lib/format.js";
import { hapticSelect, hapticImpact } from "../lib/haptics.js";
import { trackEvent } from "../lib/analytics.js";
import { StepShell } from "./common.jsx";
import { DislikesPicker } from "./DislikesPicker.jsx";
import { BudgetCheck } from "./BudgetCheck.jsx";
import { estimateWeek, budgetRange } from "../lib/budgetCheck.js";

export function WizardView({
  currentStepKey,
  hasProfile,
  showOtherStores,
  store,
  setStore,
  setShowOtherStores,
  setFamily,
  family,
  familyByMeal,
  toggleSimple,
  meals,
  setMeals,
  budget,
  setBudget,
  setDiet,
  diet,
  setAllergies,
  setAllergiesAnswered,
  allergiesAnswered,
  allergies,
  dislikes,
  setDislikes,
  step,
  planToReturnTo,
  handleBackToPlan,
  setStep,
  activeSteps,
  handleFinish,
  canNextByKey,
  setShowAccount,
}) {
  // Нелюбимые продукты — необязательный блок под аллергиями: свёрнут, пока человек не откроет (или уже есть выбор в профиле).
  const [dislikesOpen, setDislikesOpen] = useState(false);
  // Границы слайдера бюджета зависят от состава (человек, приёмы пищи): см. budgetRange.
  const range = useMemo(() => budgetRange(estimateWeek({ meals, family, familyByMeal, store })), [meals, family, familyByMeal, store]);
  // Сумма, оставшаяся от прежнего состава или профиля, может выйти за новые границы — подтягиваем к ближайшей.
  useEffect(() => {
    if (currentStepKey !== "budget") return;
    const clamped = Math.min(range.max, Math.max(range.min, Math.round(budget / range.step) * range.step));
    if (clamped !== budget) setBudget(clamped);
  }, [currentStepKey, range, budget, setBudget]);
  return (
    <div style={styles.stepBody} className="mp-step-body">
      {currentStepKey === "store" && (
        <StepShell
          icon={<Store size={20} />}
          title="Где вам удобно заказывать?"
          sub={hasProfile ? "Выберите магазин с доставкой в вашем районе" : "Составим меню на 7 дней и список покупок с реальными ценами — это займёт около минуты"}
        >
          {/* Реальный заказ пока только у ВкусВилл — он выбран заранее, а
              остальные сети свёрнуты (UX-аудит 29.09.2026: 4 из 5
              вариантов были "скоро", но выглядели равноценными). */}
          {(() => {
            const otherStoresOpen = showOtherStores || store !== DEFAULT_STORE;
            return (
              <>
                <div style={styles.grid2}>
                  {STORES.filter((s) => s.id === DEFAULT_STORE || otherStoresOpen).map((s) => (
                    <button
                      key={s.id}
                      className="chip"
                      onClick={() => { hapticSelect(); setStore(s.id); }}
                      style={{ ...styles.storeChip(store === s.id), ...(s.id === DEFAULT_STORE && !otherStoresOpen ? { gridColumn: "1 / -1" } : null) }}
                    >
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      <div style={styles.chipHint}>
                        {s.note}
                        {s.id !== "vv" && " · скоро"}
                      </div>
                    </button>
                  ))}
                </div>
                {!otherStoresOpen && (
                  <button onClick={() => setShowOtherStores(true)} style={{ ...styles.inlineLinkBtn, display: "block", margin: "14px auto 0 auto", textDecoration: "none", color: "var(--text-tertiary)" }}>
                    Другие сети — скоро
                  </button>
                )}
              </>
            );
          })()}
        </StepShell>
      )}

      {currentStepKey === "family" && (
        <StepShell icon={<Users size={20} />} title="Сколько человек в семье?" sub="Это определит объём продуктов и порции">
          <div style={styles.counterRow}>
            <button style={styles.counterBtn} onClick={() => setFamily((f) => Math.max(1, f - 1))}>−</button>
            <div style={styles.counterVal}>{family}</div>
            <button style={styles.counterBtn} onClick={() => setFamily((f) => Math.min(8, f + 1))}>+</button>
          </div>
          <div style={styles.counterCaption}>{family === 1 ? "человек" : family < 5 ? "человека" : "человек"}</div>
        </StepShell>
      )}

      {currentStepKey === "meals" && (
        <StepShell icon={<UtensilsCrossed size={20} />} title="Какие приёмы пищи планируем?" sub="Например, если вы обедаете на работе — уберите обед, и список будет только с завтраками и ужинами">
          <div style={styles.stack}>
            {MEALS.map((m) => (
              <button key={m.id} className="chip" onClick={() => toggleSimple(meals, setMeals, m.id)} style={styles.rowChip(meals.includes(m.id))}>
                <div style={{ fontWeight: 600 }}>{m.label}</div>
                {meals.includes(m.id) && <Check size={16} color={ACCENT} />}
              </button>
            ))}
          </div>
        </StepShell>
      )}

      {currentStepKey === "budget" && (
        <StepShell icon={<Wallet size={20} />} title="Бюджет на неделю" sub={`Сколько готовы потратить на продукты на ${meals.length || 0} ${mealsPerDayLabel(meals.length || 0)}`}>
          <div style={styles.budgetVal}>{budget.toLocaleString("ru-RU")} ₽</div>
          <input type="range" min={range.min} max={range.max} step={range.step} value={budget} onChange={(e) => setBudget(Number(e.target.value))} style={styles.slider} />
          <div style={styles.sliderLabels}><span>{range.min.toLocaleString("ru-RU")} ₽</span><span>{range.max.toLocaleString("ru-RU")} ₽</span></div>
          <BudgetCheck budget={budget} setBudget={setBudget} meals={meals} family={family} familyByMeal={familyByMeal} store={store} min={range.min} max={range.max} step={range.step} />
          {/* Вопрос в чате: "выдаёт 17 000 при бюджете 15 000, почему?"
              — честный ответ: алгоритм целится в сумму, но не может
              дать железную гарантию "не больше" — если рацион/аллергии/
              кухня отфильтровали слишком много дешёвых рецептов,
              уложиться физически не во что (пример из чата: неделя
              только на рыбе за 7 000 ₽). Подпись ставит ожидания
              заранее, а не оставляет пользователя гадать при виде
              красной цифры в конце визарда (см. ResultView — там она
              уже подсвечивается, но без объяснения "почему"). */}
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", textAlign: "center", margin: "14px 0 0 0", lineHeight: 1.45 }}>
            Мы стараемся уложиться в эту сумму, но не всегда получается тютелька-в-тютельку — при строгих ограничениях по рациону, аллергиям или кухне подходящих дешёвых рецептов может просто не найтись, и итог выйдет чуть выше.
          </p>
        </StepShell>
      )}

      {currentStepKey === "diet" && (
        <StepShell icon={<Salad size={20} />} title="Какой рацион вам нужен?" sub="Мы подберём рецепты под ваши предпочтения">
          <div style={styles.stack}>
            {DIETS.filter((d) => !d.vvOnly || store === "vv").map((d) => (
              <button key={d.id} className="chip" onClick={() => { hapticSelect(); setDiet(d.id); }} style={styles.rowChip(diet === d.id)}>
                <div>
                  <div style={{ fontWeight: 600 }}>{d.label}</div>
                  <div style={styles.chipHint}>{d.hint}</div>
                </div>
                {diet === d.id && <Check size={16} color={ACCENT} />}
              </button>
            ))}
          </div>
        </StepShell>
      )}

      {currentStepKey === "allergies" && (
        <StepShell icon={<Ban size={20} />} title="Есть аллергии или непереносимости?" sub="Это не предпочтение, а жёсткое ограничение — такие рецепты исключаются полностью, без компромиссов.">
          <div style={styles.grid2}>
            <button
              className="chip"
              onClick={() => { hapticSelect(); setAllergies([]); setAllergiesAnswered(true); }}
              style={styles.storeChip(allergiesAnswered && allergies.length === 0)}
            >
              <div style={{ fontWeight: 600 }}>Аллергий нет</div>
            </button>
            {ALLERGENS.map((a) => (
              <button
                key={a.id}
                className="chip"
                onClick={() => {
                  hapticSelect();
                  const next = allergies.includes(a.id) ? allergies.filter((x) => x !== a.id) : [...allergies, a.id];
                  setAllergies(next);
                  // снял все галочки — снова не ответил (не молчаливое "нет")
                  setAllergiesAnswered(next.length > 0);
                }}
                style={styles.storeChip(allergies.includes(a.id))}
              >
                <div style={{ fontWeight: 600 }}>{a.label}</div>
              </button>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            {dislikesOpen || dislikes.length > 0 ? (
              <>
                <div style={styles.acctLabel}>Не люблю (необязательно)</div>
                <p style={styles.acctSectionHint}>Это пожелание, а не запрет: постараемся не брать такие блюда.</p>
                <DislikesPicker dislikes={dislikes} setDislikes={setDislikes} />
              </>
            ) : (
              <button type="button" onClick={() => { hapticSelect(); setDislikesOpen(true); }} style={styles.legalLinkBtn}>
                + Есть продукты, которые не любите? (необязательно)
              </button>
            )}
          </div>
        </StepShell>
      )}

      <div style={styles.navRow} className="mp-nav-row">
        {step === 0 && planToReturnTo ? (
          <button onClick={handleBackToPlan} style={styles.navBtn}>
            <ChevronLeft size={16} /><span>К моему плану</span>
          </button>
        ) : (
          <button onClick={() => { hapticImpact("light"); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0} style={{ ...styles.navBtn, visibility: step === 0 ? "hidden" : "visible" }}>
            <ChevronLeft size={16} /><span>Назад</span>
          </button>
        )}
        <button
          onClick={() => {
            hapticImpact("medium");
            trackEvent("wizard_step_completed", { step: currentStepKey });
            step === activeSteps.length - 1 ? handleFinish() : setStep((s) => s + 1);
          }}
          disabled={!canNextByKey[currentStepKey]}
          style={{ ...styles.navBtnPrimary, opacity: canNextByKey[currentStepKey] ? 1 : 0.4 }}
        >
          <span>{step === activeSteps.length - 1 ? "Собрать список" : "Далее"}</span><ChevronRight size={16} />
        </button>
      </div>
      {!hasProfile && currentStepKey === "allergies" && (
        <p style={styles.quickHint}>
          Кухню, технику и время готовки можно настроить позже в{" "}
          <button onClick={() => setShowAccount(true)} style={styles.inlineLinkBtn}>Аккаунте</button> — пока подберём без ограничений.
        </p>
      )}
      {hasProfile && (
        <p style={styles.quickHint}>
          Семья, приёмы пищи, рацион и остальное — из вашего профиля. Изменить — в{" "}
          <button onClick={() => setShowAccount(true)} style={styles.inlineLinkBtn}>Аккаунте</button>.
        </p>
      )}
    </div>
  );
}
