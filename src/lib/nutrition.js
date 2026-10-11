// Диеты по КБЖУ («Высокобелковый», «Лёгкое»): считаются по реальным данным каталога ВкусВилл (recipe.nutritionPer100g —
// на 100 г готового блюда). У встроенных рецептов (другие магазины) КБЖУ нет, поэтому эти диеты работают только со ВкусВиллом.
//
// Пороги выбраны по замеру 10.10.2026 (105 рецептов с КБЖУ из 110: «основное» 60/60, завтраки 30/30, перекусы 15/20):
//   высокобелковый — белок ≥ 8 г и ≥ 22% калорий из белка (проходит ~40% рецептов; медиана белка 8,5 г);
//   лёгкое — не больше 150 ккал и не больше 7 г жира на 100 г (проходит ~30%; медиана 166 ккал).
export const NUTRITION_DIETS = {
  protein: { label: "Высокобелковый", test: (n) => n.protein >= 8 && (n.protein * 4) / n.calories >= 0.22 },
  light: { label: "Лёгкое", test: (n) => n.calories <= 150 && n.fat <= 7 },
};

export const isNutritionDiet = (diet) => Object.prototype.hasOwnProperty.call(NUTRITION_DIETS, diet);

/** true/false — подходит ли блюдо под диету; null — нет данных о КБЖУ (подтвердить нельзя). */
export function matchesNutritionDiet(nutrition, diet) {
  if (!isNutritionDiet(diet)) return true;
  if (!nutrition || !(nutrition.calories > 0)) return null;
  return NUTRITION_DIETS[diet].test(nutrition);
}

/** Сколько блюд плана НЕ подходят под диету по КБЖУ (включая блюда без данных) и сколько всего. days — plan.days из ResultView. */
export function countDietMismatches(days, diet) {
  if (!isNutritionDiet(diet)) return { mismatched: 0, total: 0 };
  let mismatched = 0;
  let total = 0;
  for (const { dayMeals } of days || []) {
    for (const dm of dayMeals || []) {
      total++;
      if (matchesNutritionDiet(dm.recipe?.nutritionPer100g, diet) !== true) mismatched++;
    }
  }
  return { mismatched, total };
}
