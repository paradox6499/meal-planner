// Решения про собранный план, от которых зависят деньги: засчитывать ли сборку в
// бесплатный лимит (reportPlanGenerated) и что класть в историю. Чистые функции —
// раньше эта логика жила внутри runFinish и handleRetryPrices в App.jsx и была
// продублирована (проверка «рецепты из каталога» — в трёх местах).

// Рецепты каталога ВкусВилл несут id вида "vv-12345"; запасной статический
// набор (см. buildPools в planLogic.js) — нет.
export function isCatalogPlan(pools) {
  return !!pools && Object.values(pools).every((list) => list.every((r) => String(r.id).startsWith("vv-")));
}

/** Вырожденная сборка: каталог ВкусВилл не ответил (базовые рецепты) или цены
 * не получены почти ни на что. Такую сборку НЕ засчитывают в бесплатный лимит и
 * НЕ кладут в историю — иначе человек получал план без цен и терял бесплатный
 * план (баг, подтверждённый на реальном телефоне 04.10.2026). Только для
 * ВкусВилл: у остальных сетей цен нет по определению. */
export function assessPlanBuild({ store, catalogError, view }) {
  const degraded = store === "vv" && (!!catalogError || !!view.mostlyUnpriced);
  return { degraded, reason: degraded ? catalogError || "цены на продукты не получены" : null };
}

/** Вырожденная сборка стала полноценной после повтора цен: рецепты уже из
 * каталога и цены получены — теперь её можно засчитать. */
export function canCompletePendingBuild({ pools, view }) {
  return isCatalogPlan(pools) && !view.mostlyUnpriced;
}

/** Снимок плана для истории на сервере (Аккаунт → «История планов»): компактная
 * «смотровая» версия рецептов — без служебных полей вроде cuisine/diets/devices,
 * нужных только при подборе. Укладывается в MAX_PLAN_JSON_LENGTH на сервере. */
export function toHistoryPlan(view) {
  return {
    total: view.total,
    itemized: view.itemized,
    shoppingItemsCount: view.grouped.reduce((sum, g) => sum + g.items.length, 0),
    days: view.days.map((d) => ({
      day: d.day,
      // Раньше в истории сохранялось только название блюда — открыть
      // рецепт из прошлого плана было нечем (запрос после созвона с
      // другом: "история планов не даёт рецепты, только список блюд").
      // Кладём сюда компактную "смотровую" версию рецепта (без служебных
      // полей вроде cuisine/diets/devices, нужных только при подборе) —
      // укладывается в MAX_PLAN_JSON_LENGTH на сервере с большим запасом
      // (тот лимит и заводился "с запасом на неделю рецептов", см. app.js).
      dayMeals: d.dayMeals.map((dm) => ({
        mealLabel: dm.mealLabel, name: dm.recipe.name, emoji: dm.recipe.emoji, time: dm.recipe.time, cost: dm.cost,
        photoUrl: dm.recipe.photoUrl || null,
        ingr: dm.recipe.ingr,
        steps: dm.recipe.steps,
        nutritionPer100g: dm.recipe.nutritionPer100g || null,
        family: dm.family,
        isRealPrice: dm.isRealPrice,
      })),
    })),
  };
}
