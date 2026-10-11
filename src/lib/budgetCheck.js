// Подсказка на шаге «Бюджет»: хватит ли выбранной суммы на неделю при таком составе семьи и числе приёмов пищи.
// Нужна, чтобы человек не получал «пустой» план (слишком мало) или не недооценивал, что может позволить (с запасом).
//
// Оценка ГРУБАЯ и честно называется ориентиром. Источник — стоимость порции (₽ на человека за один приём пищи)
// по рецептам каталога ВкусВилл с реальными ценами, замер 10.10.2026 (50 «основных» рецептов, 30 завтраков,
// 20 перекусов; цена найдена у ~40% — у остальных не хватало совпадений ингредиентов). Медиана порции у всех
// категорий около 170–180 ₽, нижняя четверть — 100–150 ₽. Пороги ниже выбраны так, чтобы согласоваться с
// настоящими сборками: при бюджете 4 000 ₽ на двоих (обед и ужин, 7 дней) план реально выходил ≈ 3 770 ₽.
import { RECIPES } from "../data/recipes.js";
import { MEALS } from "../constants.js";

export const WEEK_DAYS = 7;

// ₽ на человека за приём пищи:
//   floor    — ниже этого пул дешёвых рецептов почти не находит блюд, план выйдет заметно дороже бюджета;
//   comfy    — примерно нижняя четверть порций: можно брать обычные блюда, не только самые простые;
//   generous — выше этого можно выбирать блюда повкуснее и подороже.
export const PORTION_COST_VV = {
  breakfast: { floor: 55, comfy: 105, generous: 230 },
  main: { floor: 75, comfy: 135, generous: 250 },
  snack: { floor: 80, comfy: 150, generous: 255 },
};

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

// Для остальных магазинов план собирается из встроенных рецептов — те же пороги, но из их собственных цен.
function portionCostFromStaticRecipes() {
  const result = {};
  for (const category of ["breakfast", "main", "snack"]) {
    const costs = RECIPES.filter((r) => r.category === category && r.cost > 0).map((r) => r.cost).sort((a, b) => a - b);
    if (costs.length === 0) { result[category] = PORTION_COST_VV[category]; continue; }
    const comfy = percentile(costs, 25);
    result[category] = { floor: Math.round(comfy * 0.55), comfy, generous: Math.round(percentile(costs, 50) * 1.4) };
  }
  return result;
}
export const PORTION_COST_STATIC = portionCostFromStaticRecipes();

const roundTo = (n, step) => Math.round(n / step) * step;

/** Ориентиры на неделю для выбранных приёмов пищи: { floor, comfy, generous, portions } (₽ и число порций). */
export function estimateWeek({ meals, family, familyByMeal = {}, store = "vv" }) {
  const table = store === "vv" ? PORTION_COST_VV : PORTION_COST_STATIC;
  const totals = { floor: 0, comfy: 0, generous: 0, portions: 0 };
  for (const mealId of meals || []) {
    const meal = MEALS.find((m) => m.id === mealId);
    if (!meal) continue;
    const people = familyByMeal[mealId] || family || 1;
    const c = table[meal.category];
    totals.floor += WEEK_DAYS * people * c.floor;
    totals.comfy += WEEK_DAYS * people * c.comfy;
    totals.generous += WEEK_DAYS * people * c.generous;
    totals.portions += WEEK_DAYS * people;
  }
  return { floor: roundTo(totals.floor, 50), comfy: roundTo(totals.comfy, 50), generous: roundTo(totals.generous, 50), portions: totals.portions };
}

/** Что сказать про выбранную сумму: level — low | tight | ok | rich; perPortion — ₽ на порцию; suggest — разумная сумма (или null). */
export function assessBudget(budget, estimate, { min = 1500, max = 15000, step = 250 } = {}) {
  if (!estimate || estimate.portions <= 0) return null;
  const perPortion = Math.round(budget / estimate.portions);
  let level;
  if (budget < estimate.floor) level = "low";
  else if (budget < estimate.comfy) level = "tight";
  else if (budget < estimate.generous) level = "ok";
  else level = "rich";
  // Вверх до шага слайдера: предложенная сумма сама должна попасть в «Хватит», а не оказаться чуть ниже порога.
  const clamp = (v) => Math.min(max, Math.max(min, Math.ceil(v / step) * step));
  const suggest = level === "low" || level === "tight" ? clamp(estimate.comfy) : null;
  return { level, perPortion, suggest: suggest !== null && suggest > budget ? suggest : null, comfy: estimate.comfy, portions: estimate.portions };
}

const fmt = (n) => n.toLocaleString("ru-RU");

/** Текст под слайдером. */
export function budgetMessage(assessment) {
  const { level, perPortion, comfy, portions } = assessment;
  const per = `≈ ${fmt(perPortion)} ₽ на порцию (всего ${portions} порций за неделю)`;
  if (level === "low") return { title: "Маловато", text: `${per}. Такая неделя обычно выходит от ≈ ${fmt(comfy)} ₽ — при меньшей сумме придётся брать самые простые блюда, и итог может оказаться выше бюджета.` };
  if (level === "tight") return { title: "Впритык", text: `${per}. Хватит, если брать самые доступные блюда; спокойнее — от ≈ ${fmt(comfy)} ₽.` };
  if (level === "ok") return { title: "Хватит", text: `${per}. Подберём разные блюда в рамках этой суммы.` };
  return { title: "С запасом", text: `${per}. Можно выбирать блюда повкуснее и подороже — или потратить меньше.` };
}
