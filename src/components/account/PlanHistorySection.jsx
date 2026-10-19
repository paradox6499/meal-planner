// Раздел «История планов» в Аккаунте.

import { useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { confirmAction } from "../../lib/confirmAction.js";
import { SwipeToDelete } from "./SwipeToDelete.jsx";
import { describePlanDay } from "../../lib/planDays.js";
import { hapticSelect } from "../../lib/haptics.js";
import { styles, T } from "../../styles.js";
import { HISTORY_DAY_EMOJI_FALLBACK } from "../../constants.js";
import { RecipeModal } from "../RecipeModal.jsx";

// Список прошлых планов — только если бэкенд вообще способен на него
// ответить (planHistory !== null, см. lib/backend.js:fetchPlanHistory).
// Пустой массив — реальное "пока нет истории", не то же самое, что "нечем
// спросить" (тогда весь раздел скрыт целиком, чтобы не обещать того, что
// зависит от недоступного бэкенда).
// Сколько последних планов видно сразу: чем дольше человек пользуется приложением, тем длиннее
// история (до 12 записей), и настройки Аккаунта уезжали далеко вниз. Остальное — по кнопке.
export const HISTORY_VISIBLE_DEFAULT = 3;

export function PlanHistorySection({ planHistory, onDeletePlan }) {
  const [openId, setOpenId] = useState(null);
  const [showAll, setShowAll] = useState(false);
  // Запрос в чате (после созвона с другом): "история планов, когда хочет
  // пользователь открыть, то не даёт рецепты, а только список блюд". Планы,
  // сохранённые ДО этого изменения, не несут dm.ingr/steps (в истории уже
  // лежит старый плоский формат) — тогда блюдо остаётся простым текстом, не
  // кнопкой, без ошибки. Новые планы кладут полный рецепт, см. handleFinish.
  const [historyRecipe, setHistoryRecipe] = useState(null);
  const [deleteError, setDeleteError] = useState(false);
  if (planHistory === null) return null;

  const requestDelete = async (p) => {
    const ok = await confirmAction("Вы точно хотите удалить этот план?");
    if (!ok) return;
    setDeleteError(false);
    const done = await onDeletePlan?.(p.id);
    if (done === false) setDeleteError(true);
    else if (openId === p.id) setOpenId(null);
  };
  const hiddenCount = Math.max(0, planHistory.length - HISTORY_VISIBLE_DEFAULT);
  const visible = showAll ? planHistory : planHistory.slice(0, HISTORY_VISIBLE_DEFAULT);

  return (
    <div style={styles.acctSection}>
      <div style={styles.acctSectionTitle}>История планов</div>
      {planHistory.length === 0 ? (
        <p style={styles.acctSectionHint}>Пока пусто — здесь появятся планы, которые вы соберёте.</p>
      ) : (
        <div style={styles.stack}>
          <p style={{ ...styles.acctSectionHint, margin: 0 }}>Нажмите на план, чтобы посмотреть. Чтобы удалить, потяните его в сторону.</p>
          {visible.map((p) => {
            const open = openId === p.id;
            const dateLabel = new Date(p.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
            return (
              <div key={p.id}>
                <SwipeToDelete onDelete={() => requestDelete(p)}>
                <button className="chip" onClick={() => { hapticSelect(); setOpenId(open ? null : p.id); }} style={styles.rowChip(false)}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{dateLabel} · {p.storeName}</div>
                    <div style={styles.chipHint}>
                      {p.totalCost != null ? `${p.totalCost.toLocaleString("ru-RU")} ₽` : "без цены"} из {p.budget.toLocaleString("ru-RU")} ₽ · на {p.family} {p.family === 1 ? "человека" : "человек"}
                    </div>
                  </div>
                  <ChevronRight size={16} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
                </button>
                </SwipeToDelete>
                {open && (
                  <div style={styles.historyDetail}>
                    {p.plan?.days?.map((d) => (
                      <div key={d.day} style={styles.historyDay}>
                        <span style={styles.historyDayLabel}>{describePlanDay(p.createdAt, d.day)?.label ?? `День ${d.day}`}</span>
                        <span>
                          {d.dayMeals.map((dm, i) => (
                            <span key={i}>
                              {i > 0 && " · "}
                              {dm.ingr ? (
                                <button
                                  className="recipe-row-btn"
                                  onClick={() =>
                                    setHistoryRecipe({
                                      recipe: {
                                        name: dm.name, emoji: dm.emoji, photoUrl: dm.photoUrl, time: dm.time,
                                        ingr: dm.ingr, steps: dm.steps, nutritionPer100g: dm.nutritionPer100g,
                                      },
                                      cost: dm.cost, isRealPrice: dm.isRealPrice, family: dm.family || p.family || 1,
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
                    <button
                      type="button"
                      onClick={() => requestDelete(p)}
                      style={{ ...styles.acctClearBtn, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 44 }}
                    >
                      <Trash2 size={14} /> Удалить этот план
                    </button>
                    {p.plan?.days?.some((d) => d.dayMeals.some((dm) => !dm.ingr)) && (
                      <p style={{ ...styles.chipHint, color: "var(--warning-text)", margin: "4px 0 0" }}>
                        Блюда без подчёркивания — рецепт для них не сохранён (план собран до обновления)
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {deleteError && <p style={styles.orderError}>Не удалось удалить план. Проверьте соединение и попробуйте ещё раз.</p>}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => { hapticSelect(); setShowAll((v) => !v); if (showAll) setOpenId(null); }}
              style={{ ...styles.inlineLinkBtn, padding: "10px 0", minHeight: 44, alignSelf: "flex-start", fontSize: T.caption }}
            >
              {showAll ? "Свернуть" : `Показать ещё ${hiddenCount}`}
            </button>
          )}
        </div>
      )}
      {historyRecipe && <RecipeModal dm={historyRecipe} family={historyRecipe.family} onClose={() => setHistoryRecipe(null)} />}
    </div>
  );
}
