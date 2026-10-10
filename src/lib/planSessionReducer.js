// Состояние ПОКАЗАННОГО плана (какой слот на экране, его план, пулы, цены,
// отметка «ждёт засчитывания», идёт ли сборка или повтор цен) и все переходы
// между ними — одним чистым редьюсером. Раньше это были полтора десятка useState
// в hooks/usePlanSession.js, и каждый переход («показать слот», «Новый план»,
// «план собран») вручную перечислял сеттеры — забыть один было легко (так
// отметка generationPending однажды и «переезжала» к чужому плану).
//
// Побочных эффектов здесь нет: засчитывание сборки, история, аналитика и
// localStorage остаются в usePlanSession.
import { DEFAULT_STORE } from "../constants.js";

export const DEFAULT_BUDGET = 4000;

// Поля, которые описывают сам план на экране и берутся из его слота (null —
// пустой визард, плана ещё нет).
function shownPlanFrom(slot) {
  return {
    planSlotId: slot?.id ?? null,
    store: slot?.store ?? DEFAULT_STORE,
    budget: slot?.budget ?? DEFAULT_BUDGET,
    // Когда план собран — нужно для подписей дней ("Сегодня · пт, 2 окт."), см.
    // lib/planDays.js. null у плана, сохранённого до появления этого поля.
    planCreatedAt: slot?.createdAt ?? null,
    planState: slot?.planState ?? null,
    pools: slot?.pools ?? null,
    priceByName: slot?.priceByName ?? null,
    done: !!slot,
    // Отметка «ждёт засчитывания» принадлежит плану и хранится в его слоте —
    // см. generationPending в lib/activePlan.js.
    generationPending: !!slot?.generationPending,
    catalogReason: slot?.catalogReason ?? null,
  };
}

/** Начальное состояние — слот, активный при запуске (или null). */
export function initPlanSession(slot) {
  return {
    ...shownPlanFrom(slot),
    assembling: false,
    retryingPrices: false,
    priceRetryFailed: false,
    // Номер показанного плана: растёт при каждой смене плана на экране. Повтор
    // цен запоминает его до запроса и, если за это время на экране уже другой
    // план, его результат выбрасывается (см. priceRetrySucceeded/Failed).
    epoch: 0,
  };
}

export function planSessionReducer(state, action) {
  switch (action.type) {
    // Показать сохранённый слот (переключение, удаление текущего, «К моему плану»);
    // slot: null — планов не осталось, пустой визард.
    case "slotShown":
      return { ...state, ...shownPlanFrom(action.slot), assembling: false, epoch: state.epoch + 1 };

    // «Новый план» (тот же слот, slotId не передаётся) и «Ещё план» (новый
    // slotId заранее): пустой визард, сохранённый слот пока не трогаем.
    case "blankPlanStarted":
      return {
        ...state,
        ...shownPlanFrom(null),
        planSlotId: action.slotId ?? state.planSlotId,
        assembling: false,
        epoch: state.epoch + 1,
      };

    case "assemblyStarted":
      return { ...state, assembling: true };
    case "assemblyStopped":
      return { ...state, assembling: false };

    // Сборка закончилась — новый план на экране. Самый первый план вообще
    // получает id слота здесь же (newSlotId), иначе автосохранение его не увидит.
    case "planBuilt":
      return {
        ...state,
        planSlotId: state.planSlotId ?? action.newSlotId,
        planState: action.planState,
        pools: action.pools,
        priceByName: action.priceByName,
        planCreatedAt: action.createdAt,
        done: true,
        assembling: false,
        generationPending: action.generationPending,
        catalogReason: action.catalogReason,
        epoch: state.epoch + 1,
      };

    // Вырожденная сборка стала полноценной и засчитана.
    case "generationCompleted":
      return { ...state, generationPending: false, catalogReason: null };

    case "storeChanged":
      return { ...state, store: action.store };
    case "budgetChanged":
      return { ...state, budget: action.budget };

    // «Заменить блюдо»: следующий рецепт той же категории из пула, остальная
    // неделя не трогается. planState хранит только id рецептов по дням.
    case "mealSwapped": {
      const prev = state.planState;
      if (!prev) return state;
      const days = prev.days.map((d, i) => {
        if (i !== action.dayIndex) return d;
        const dayMeals = d.dayMeals.map((slot, j) => {
          if (j !== action.slotIndex) return slot;
          const pool = state.pools?.[slot.category] || [];
          if (pool.length <= 1) return slot;
          const curIdx = pool.findIndex((r) => r.id === slot.recipeId);
          const nextRecipe = pool[(curIdx + 1) % pool.length];
          return { ...slot, recipeId: nextRecipe.id };
        });
        return { ...d, dayMeals };
      });
      return { ...state, planState: { ...prev, days } };
    }

    case "priceRetryStarted":
      return { ...state, retryingPrices: true, priceRetryFailed: false };
    // Цены пришли. Если на экране уже другой план (epoch сменился) — его цены не
    // трогаем, только снимаем «идёт повтор».
    case "priceRetrySucceeded":
      if (action.epoch !== state.epoch) return { ...state, retryingPrices: false };
      return { ...state, priceByName: action.prices, priceRetryFailed: action.prices.size === 0, retryingPrices: false };
    case "priceRetryFailed":
      return { ...state, retryingPrices: false, priceRetryFailed: action.epoch === state.epoch ? true : state.priceRetryFailed };

    default:
      throw new Error(`planSessionReducer: неизвестное действие ${action.type}`);
  }
}
