// Приведение списка покупок к тому, что человек действительно купит. По живому плану (аудит 19.10.2026) в списке
// были «Перец чили 0 шт», «Масло оливковое 18 г» и тут же «2 мл», «Помидоры 2 шт» и «38 г», «Вода 453 мл · 8 ₽»,
// а три «листа» лаврового листа стоили как три упаковки.

// Не покупают: водопроводная вода и соль (есть в каждом доме). «Вода газированная», «Соль морская» и т.п. остаются.
const NOT_PURCHASED_RE = /^\s*(вода(\s+питьевая)?|соль(\s+(поваренная|пищевая))?)\s*$/i;
export function isNotPurchased(name) {
  return NOT_PURCHASED_RE.test(String(name || ""));
}

// Специи и приправы, которые в рецепте считаются штуками (листьями, горошинами): в корзину идёт одна упаковка,
// а не по упаковке на каждый лист.
const SPICE_RE = /лавров|перец\s+(душистый|горошек|чёрный|черный|красный)|гвоздик|кардамон|бадьян|мускат|шафран|паприк|куркум|зира|орегано|тимьян|розмарин|корица/i;
export function isSpice(name) {
  return SPICE_RE.test(String(name || ""));
}

const isWeightOrVolume = (u) => u === "г" || u === "мл";

/** Склеивает позиции одного названия в разных единицах.
 * entries: [{ name, unit, amount, lastDay }]. pieceGrams(name) → средний вес штуки или null.
 *  • г и мл — одно и то же количество (плотность ≈ 1, ошибка в пределах нескольких процентов для масел и молочного);
 *  • шт и г/мл — только если известен вес штуки: «Помидоры 2 шт» + «38 г» → 3 шт (вверх: полтора помидора не купишь);
 *  • иначе позиции остаются раздельными. */
export function mergeIngredientUnits(entries, pieceGrams = () => null) {
  const byName = new Map();
  for (const e of entries) {
    const key = String(e.name).trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(e);
  }
  const out = [];
  for (const group of byName.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const wv = group.filter((e) => isWeightOrVolume(e.unit));
    const pcs = group.filter((e) => e.unit === "шт");
    const rest = group.filter((e) => !isWeightOrVolume(e.unit) && e.unit !== "шт");
    out.push(...rest);

    const lastDay = Math.max(0, ...group.map((e) => e.lastDay || 0));
    const name = group[0].name;
    const grams = wv.reduce((s, e) => s + e.amount, 0);
    const pieceWeight = pcs.length > 0 && wv.length > 0 ? pieceGrams(name) : null;

    if (pieceWeight) {
      const pieces = pcs.reduce((s, e) => s + e.amount, 0) + grams / pieceWeight;
      out.push({ name, unit: "шт", amount: pieces, lastDay });
      continue;
    }
    if (wv.length > 0) {
      // г и мл — в ту единицу, которой в рецептах больше
      const ml = wv.filter((e) => e.unit === "мл").reduce((s, e) => s + e.amount, 0);
      out.push({ name, unit: ml > grams - ml ? "мл" : "г", amount: grams, lastDay });
    }
    if (pcs.length > 0) out.push({ name, unit: "шт", amount: pcs.reduce((s, e) => s + e.amount, 0), lastDay });
  }
  return out;
}

/** Количество к показу: штуки вверх, остальное до целого, и не меньше единицы (никаких «0 шт»). */
export function displayAmount(amount, unit) {
  if (!(amount > 0)) return 1;
  const v = unit === "шт" ? Math.ceil(amount - 1e-9) : Math.round(amount);
  return Math.max(1, v);
}
