// Чистая логика сборки плана — без React-состояния, без сети. Вынесено из
// App.jsx (где раньше жило прямо рядом с компонентом) в отдельный модуль по
// двум причинам: (1) App.jsx уже разросся до ~1500 строк, и (2) чистые
// функции без React/DOM тестируются напрямую в Vitest, без jsdom и рендера
// компонентов — см. planLogic.test.js рядом.
import { RECIPES, RECIPES_BY_ID, DEPARTMENTS, departmentOf, forbiddenIngredientsFor, recipeHasAllergen, effectiveRecipeCost } from "../data/recipes.js";
import { pricePerBaseUnit, isWeightOrVolumeUnit } from "./vkusvillRecipes.js";

// пул подходящих рецептов на категорию: рацион/кухня/техника — мягкие предпочтения
// (при пустом пуле смягчаются), аллергии — жёсткое исключение (не смягчается никогда)
export function buildPools(diet, cuisines, devices, allergies, maxCookTime) {
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
      const timeOk = !maxCookTime || r.time <= maxCookTime;
      return dietOk && cuisineOk && deviceOk && timeOk;
    });
    if (pool.length === 0) {
      // смягчаем кухню/технику/время готовки, если совсем ничего не подошло,
      // чтобы план не был пустым — но аллергию НИКОГДА не смягчаем, это не предпочтение
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
  // Сколько раз рецепт уже использован за всю неделю (id уникальны в рамках
  // категории, так что один общий счётчик на все категории безопасен) —
  // раньше избегали повтора только среди ПОСЛЕДНИХ 2 выборов, из-за чего на
  // небольшом пуле одно и то же блюдо вполне могло вернуться уже через пару
  // дней (жалоба в чате: "может предложить одно и то же блюдо несколько раз
  // за неделю"). Теперь среди вариантов в рамках бюджета всегда предпочитаем
  // наименее использованный — блюда распределяются по неделе куда ровнее.
  const usageCount = {};
  // Сбрасывается на каждый новый день — то же блюдо не должно повторяться
  // ДВАЖДЫ В ОДИН ДЕНЬ (жалоба: "то же самое блюдо в рамках одного дня и на
  // завтрак, и на обед"). Раньше это тоже как бы исключалось "последними 2",
  // но только пока в бюджет укладывалось больше одного варианта — если из
  // всего пула на этот приём проходил ровно один рецепт (частый случай при
  // низком бюджете), защиты не было вообще.
  let usedToday = new Set();

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
    const affordable = pool.slice(0, candidateIdx + 1);

    // Сначала — жёстко исключаем то, что уже было сегодня, если есть хоть
    // одна альтернатива в рамках бюджета (иначе оставляем как есть: лучше
    // повтор, чем пустой приём пищи).
    const notToday = affordable.filter((r) => !usedToday.has(r.id));
    const candidates = notToday.length > 0 ? notToday : affordable;

    // Среди оставшихся — наименее использованные за неделю; при равенстве
    // берём самый дорогой из них (сохраняет прежнее свойство "тратим бюджет
    // осмысленно", а не всегда самое дешёвое).
    const minUsage = Math.min(...candidates.map((r) => usageCount[r.id] || 0));
    const leastUsed = candidates.filter((r) => (usageCount[r.id] || 0) === minUsage);
    const chosen = leastUsed[leastUsed.length - 1];

    usageCount[chosen.id] = (usageCount[chosen.id] || 0) + 1;
    usedToday.add(chosen.id);
    remainingBudget -= chosen.cost;
    remainingSlots -= 1;
    return chosen;
  };

  const days = [];
  const emptyMealLabels = new Set();
  for (let day = 1; day <= 7; day++) {
    usedToday = new Set();
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

  let unpricedCount = 0;
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
        unpricedCount++;
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
  // Раньше был только булев anyUnpriced — "не нашли цену для яблочного
  // уксуса" и "ВкусВилл сейчас лимитирует запросы, не нашли цену ВООБЩЕ
  // ни для чего" показывали ОДНУ И ТУ ЖЕ мелкую подпись, хотя это разные по
  // серьёзности ситуации (нашли живьём при жалобе в чате на "корзину на
  // 3000 ₽, которая стала 0 ₽"). mostlyUnpriced — явный сигнал ResultView
  // показать не мелкую подпись, а полноценное предупреждение "похоже,
  // ВкусВилл сейчас недоступен".
  const mostlyUnpriced = itemized && shoppingList.length > 0 && unpricedCount / shoppingList.length > 0.5;

  return {
    days, grouped,
    total: Math.round(itemized ? itemizedTotal : total),
    itemized,
    warnings: planState.warnings || [],
    anyEstimated, anyUnpriced: itemized && unpricedCount > 0, mostlyUnpriced,
  };
}

/** plan.grouped идёт по отделам (см. DEPARTMENTS в data/recipes.js) — "Овощи
 * и фрукты" всегда первый. При сборке настоящей корзины (buildCartFromShoppingList
 * в vkusvillMcp.js) товары ищутся в ЭТОМ ЖЕ порядке с ограниченным
 * параллелизмом (см. mapWithConcurrency) — если ВкусВилл начинает лимитировать
 * запросы посреди сборки, страдают непропорционально ПОЗДНИЕ по порядку
 * товары. Жалоба в чате: "в корзине 10 позиций, и то все овощи, без бакалеи"
 * — овощи просто были первым отделом и успели пройти ДО того, как лимит
 * включился, а бакалея/мясо/молочное шли следом и не успели вообще.
 * interleaveGroups превращает [овощи...][молочное...][мясо...] в
 * [овощ, молочное, мясо, овощ, молочное, мясо, ...] — если лимит всё же
 * наступит на середине списка, потери размажутся по всем отделам примерно
 * поровну, а не выкосят всё "после овощей" целиком. */
export function interleaveGroups(groups) {
  const queues = groups.map((g) => [...g.items]);
  const result = [];
  let anyLeft = true;
  while (anyLeft) {
    anyLeft = false;
    for (const q of queues) {
      if (q.length > 0) {
        result.push(q.shift());
        anyLeft = true;
      }
    }
  }
  return result;
}
