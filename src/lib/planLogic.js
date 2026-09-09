// Чистая логика сборки плана — без React-состояния, без сети. Вынесено из
// App.jsx (где раньше жило прямо рядом с компонентом) в отдельный модуль по
// двум причинам: (1) App.jsx уже разросся до ~1500 строк, и (2) чистые
// функции без React/DOM тестируются напрямую в Vitest, без jsdom и рендера
// компонентов — см. planLogic.test.js рядом.
import { RECIPES, RECIPES_BY_ID, DEPARTMENTS, departmentOf, forbiddenIngredientsFor, recipeHasAllergen, effectiveRecipeCost } from "../data/recipes.js";
import { pricePerBaseUnit, isWeightOrVolumeUnit } from "./vkusvillRecipes.js";

// пул подходящих рецептов на категорию: рацион/кухня/техника — мягкие предпочтения
// (при пустом пуле смягчаются), аллергии — жёсткое исключение (не смягчается никогда)
export function buildPools(diet, cuisines, devices, allergies) {
  const cuisineFilter = cuisines.length === 0 || cuisines.includes("any");
  const forbidden = forbiddenIngredientsFor(allergies);
  // Найдено при разборе жалобы "не нашлось рецептов для Перекрёстка": если
  // diet === null/undefined (профиль сохранён из Аккаунта БЕЗ выбора
  // рациона — там, в отличие от визарда, это раньше не было обязательным),
  // ни один рецепт не проходит diets.includes(diet) НИ В основном фильтре,
  // НИ в смягчённом фолбэке ниже (оба условия идентичны для рациона) — пулы
  // всех трёх категорий стабильно пустые. Проверено на всех 2240 комбинациях
  // диета×аллергии×техника: пусто ТОЛЬКО когда diet ложный. ВкусВилл этой
  // проблемы не имел — там своя проверка (recipeViolatesDiet в
  // vkusvillRecipes.js), которая просто игнорирует незнакомое значение
  // рациона, а не требует точного совпадения. Нормализуем null/undefined в
  // "any" здесь же — так же, как теперь обязательно в Аккаунте (см. AccountView).
  // Регрессионный тест на этот баг — planLogic.test.js.
  const safeDiet = diet || "any";

  const buildPool = (category) => {
    let pool = RECIPES.filter((r) => {
      if (r.category !== category) return false;
      if (recipeHasAllergen(r, forbidden)) return false;
      const dietOk = safeDiet === "any" || r.diets.includes(safeDiet);
      const cuisineOk = category !== "main" || cuisineFilter || r.cuisine === "any" || cuisines.includes(r.cuisine);
      const deviceOk = r.devices.length === 0 || r.devices.some((d) => devices.includes(d));
      return dietOk && cuisineOk && deviceOk;
    });
    if (pool.length === 0) {
      // смягчаем фильтр по кухне/технике, если совсем ничего не подошло, чтобы план
      // не был пустым — но аллергию НИКОГДА не смягчаем, это не предпочтение
      pool = RECIPES.filter(
        (r) =>
          r.category === category &&
          !recipeHasAllergen(r, forbidden) &&
          (safeDiet === "any" || r.diets.includes(safeDiet))
      );
    }
    return [...pool].sort((a, b) => a.cost - b.cost);
  };

  return { breakfast: buildPool("breakfast"), main: buildPool("main"), snack: buildPool("snack") };
}

// начальный план — только id рецептов, без сумм и списка покупок (их считаем отдельно,
// чтобы «Заменить блюдо» не пересобирало всю неделю заново)
//
// Раньше выбор блюда был просто round-robin по пулу (отсортированному по
// цене), без учёта budget вообще — за 7 дней цикл проходил и по самым
// дешёвым, и по самым дорогим рецептам поровну, поэтому итог почти не
// зависел от того, что выбрал пользователь на шаге "Бюджет". Теперь —
// жадный алгоритм: на каждый приём пищи считаем допустимую среднюю цену на
// оставшиеся приёмы (remainingBudget / remainingSlots) и берём САМЫЙ ДОРОГОЙ
// рецепт из пула, который в неё укладывается — так бюджет тратится
// осмысленно (не всегда самое дешёвое), но итог целится в заданную сумму, а
// не в среднюю по больнице. Если бюджет физически ниже, чем даже самые
// дешёвые рецепты в пуле, алгоритм просто берёт минимально возможное и даёт
// уйти в минус — дальше это видно пользователю по индикатору "превышен
// бюджет" в ResultView, а не скрывается.
export function buildInitialPlan(pools, selectedMeals, budget, family) {
  const totalSlots = 7 * selectedMeals.length;
  let remainingBudget = family > 0 ? budget / family : budget; // считаем в цене на человека, family умножается позже в buildPlanView
  let remainingSlots = totalSlots;
  const recentByCategory = {}; // последние выбранные id на категорию — чтобы не повторять одно и то же блюдо подряд без нужды

  const pickRecipe = (category) => {
    const pool = pools[category];
    if (!pool || pool.length === 0) return null;
    const allowedAvg = remainingSlots > 0 ? remainingBudget / remainingSlots : Infinity;
    // pool отсортирован по возрастанию цены (buildPools/fetchVkusvillPools) —
    // ищем самый дорогой вариант, который всё ещё укладывается в допустимое
    // среднее на оставшиеся приёмы пищи
    let candidateIdx = 0;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].cost <= allowedAvg) candidateIdx = i;
      else break;
    }
    const recent = recentByCategory[category] || [];
    let chosen = pool[candidateIdx];
    if (candidateIdx > 0) {
      // из вариантов в рамках бюджета — предпочитаем не повторять последние 2 блюда подряд
      const notRecent = pool.slice(0, candidateIdx + 1).filter((r) => !recent.includes(r.id));
      if (notRecent.length > 0) chosen = notRecent[notRecent.length - 1];
    }
    recentByCategory[category] = [...recent, chosen.id].slice(-2);
    remainingBudget -= chosen.cost;
    remainingSlots -= 1;
    return chosen;
  };

  const days = [];
  const emptyMealLabels = new Set();
  for (let day = 1; day <= 7; day++) {
    const dayMeals = [];
    selectedMeals.forEach((m) => {
      const pool = pools[m.category];
      if (!pool || pool.length === 0) {
        emptyMealLabels.add(m.label);
        return;
      }
      const r = pickRecipe(m.category);
      dayMeals.push({ mealId: m.id, mealLabel: m.label, category: m.category, recipeId: r.id });
    });
    days.push({ day, dayMeals });
  }
  return { days, warnings: Array.from(emptyMealLabels) };
}

// разворачивает planState (id-шники) в полные объекты для отображения + считает
// итоговую сумму и сгруппированный список покупок
// priceByName — карта ингредиент->цена товара из fetchVkusvillPools
// (см. vkusvillRecipes.js), null для не-ВкусВилл или если реальные рецепты
// не подтянулись. Раньше "Итого за продукты" считалось ТОЛЬКО как сумма
// cost по рецептам — при замене товара через "Нет в наличии" (ResultView)
// эта сумма не знала о замене и оставалась замороженной на старой цифре.
// Теперь, когда есть priceByName, каждая строка списка покупок получает
// СВОЮ цену (той же арифметикой, что и cost рецепта — pricePerBaseUnit,
// см. vkusvillRecipes.js), а "Итого" — их сумма; ResultView может честно
// пересчитать её при замене, просто заменив цену одной строки, а не
// пересобирая весь план.
export function buildPlanView(planState, pools, family, priceByName) {
  if (!planState) return null;

  // Рецепт мог прийти либо из статического RECIPES_BY_ID, либо из живых
  // pools (VkusVill, id вида "vv-12345" — в статической карте их нет). Сам
  // buildInitialPlan берёт recipeId ИЗ pools, так что pools гарантированно
  // содержит нужный рецепт на момент вызова — просто ищем в правильном месте.
  const recipesById = new Map(RECIPES_BY_ID);
  Object.values(pools || {}).forEach((list) => list.forEach((r) => recipesById.set(r.id, r)));

  const ingredMap = {};
  let total = 0;

  let anyEstimated = false;

  const days = planState.days.map((d) => {
    const dayMeals = d.dayMeals.map((slot) => {
      const recipe = recipesById.get(slot.recipeId);
      const pool = pools[slot.category] || [];
      const [cost, isRealPrice] = effectiveRecipeCost(recipe);
      if (!isRealPrice) anyEstimated = true;
      total += cost * family;
      recipe.ingr.forEach(([name, amount, unit]) => {
        const key = `${name}|${unit}`;
        ingredMap[key] = (ingredMap[key] || 0) + amount * family;
      });
      return {
        mealId: slot.mealId,
        mealLabel: slot.mealLabel,
        category: slot.category,
        recipe,
        cost,
        isRealPrice,
        canSwap: pool.length > 1,
      };
    });
    return { day: d.day, dayMeals };
  });

  let anyUnpriced = false;
  const shoppingList = Object.entries(ingredMap).map(([key, amount]) => {
    const [name, unit] = key.split("|");
    const roundedAmount = Math.round(amount);
    let cost = null;
    if (priceByName) {
      const info = priceByName.get(name);
      // тот же "род единиц" (вес/объём vs штучно), что и в attachRealCosts —
      // иначе можно случайно посчитать цену по совсем другому товару
      if (info && isWeightOrVolumeUnit(unit) === isWeightOrVolumeUnit(info.productUnit)) {
        cost = Math.round(pricePerBaseUnit(info.price, info.productUnit) * roundedAmount);
      } else {
        anyUnpriced = true;
      }
    }
    return { name, amount: roundedAmount, unit, dept: departmentOf(name), cost };
  });
  const grouped = DEPARTMENTS.map((d) => ({
    name: d.name,
    items: shoppingList.filter((it) => it.dept === d.name),
  })).filter((g) => g.items.length > 0);
  const other = shoppingList.filter((it) => it.dept === "Разное");
  if (other.length > 0) grouped.push({ name: "Разное", items: other });

  // Итемизированный тотал доступен только когда есть priceByName (сейчас —
  // только ВкусВилл: реальные цены по ингредиентам известны). Для остальных
  // сетей другого источника цен нет вообще (prices.json пуст) — там честнее
  // оставить прежнюю сумму по рецептам, чем изобретать несуществующую точность.
  const itemized = priceByName != null;
  const itemizedTotal = itemized ? shoppingList.reduce((sum, it) => sum + (it.cost || 0), 0) : null;

  return {
    days, grouped,
    total: Math.round(itemized ? itemizedTotal : total),
    itemized,
    warnings: planState.warnings || [],
    anyEstimated, anyUnpriced: itemized && anyUnpriced,
  };
}
