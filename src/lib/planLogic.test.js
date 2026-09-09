import { describe, it, expect } from "vitest";
import { buildPools, buildInitialPlan, buildPlanView } from "./planLogic.js";
import { ALLERGENS } from "../data/recipes.js";

const DIETS = ["any", "pp", "veg", "vegan", "gf"];
const DEVICE_SETS = [[], ["stove"], ["oven"], ["multi"], ["air"], ["blender"], ["stove", "oven"]];
const ALLERGEN_IDS = ALLERGENS.map((a) => a.id);

// Перебирает подмножества массива через битовую маску — используется ниже,
// чтобы прогнать buildPools по ВСЕМ комбинациям аллергий (2^6 = 64), как в
// ручной проверке из чата (2240 комбинаций диета×аллергии×техника).
function subsetsOf(arr) {
  const out = [];
  for (let mask = 0; mask < 1 << arr.length; mask++) {
    out.push(arr.filter((_, i) => mask & (1 << i)));
  }
  return out;
}

describe("buildPools", () => {
  it("никогда не включает рецепт с запрещённым по аллергии ингредиентом", () => {
    for (const allergies of subsetsOf(ALLERGEN_IDS)) {
      const pools = buildPools("any", [], [], allergies);
      const forbidden = new Set(
        ALLERGENS.filter((a) => allergies.includes(a.id)).flatMap((a) => a.ingredients)
      );
      Object.values(pools).forEach((pool) => {
        pool.forEach((recipe) => {
          const hit = recipe.ingr.find(([name]) => forbidden.has(name));
          expect(hit, `рецепт "${recipe.name}" содержит запрещённый ингредиент ${hit?.[0]}`).toBeUndefined();
        });
      });
    }
  });

  it("регрессия: diet=null/undefined не должен опустошать пулы (баг из чата — 'не нашлось рецептов для Перекрёстка')", () => {
    for (const diet of [null, undefined]) {
      const pools = buildPools(diet, [], [], []);
      expect(pools.breakfast.length, "breakfast пуст при falsy diet").toBeGreaterThan(0);
      expect(pools.main.length, "main пуст при falsy diet").toBeGreaterThan(0);
      expect(pools.snack.length, "snack пуст при falsy diet").toBeGreaterThan(0);
    }
  });

  it("ни одна комбинация диета×аллергии×техника не даёт пустой пул одновременно во всех трёх категориях", () => {
    // Смягчение (кухня/техника отбрасываются в фолбэке) должно спасать план
    // при любой технике — единственное, что легитимно опустошает категорию
    // целиком, это диета+аллергии, для которых просто нет ни одного рецепта.
    let anyEmpty = 0;
    for (const diet of DIETS) {
      for (const allergies of subsetsOf(ALLERGEN_IDS)) {
        for (const devices of DEVICE_SETS) {
          const pools = buildPools(diet, [], devices, allergies);
          if (pools.breakfast.length === 0 || pools.main.length === 0 || pools.snack.length === 0) anyEmpty++;
        }
      }
    }
    expect(anyEmpty).toBe(0);
  });

  it("сортирует каждый пул по возрастанию cost", () => {
    const pools = buildPools("any", [], [], []);
    Object.values(pools).forEach((pool) => {
      for (let i = 1; i < pool.length; i++) expect(pool[i].cost).toBeGreaterThanOrEqual(pool[i - 1].cost);
    });
  });

  it("maxCookTime отсекает рецепты дольше указанного времени", () => {
    // Все устройства сразу — deviceOk не должен путаться с проверкой времени,
    // иначе фолбэк может сработать по нехватке техники, а не времени, и тест
    // проверит не то, что заявлено (наступали на это ровно так).
    const allDevices = ["stove", "oven", "multi", "air", "grill", "blender", "micro"];
    const pools = buildPools("any", [], allDevices, [], 20);
    Object.values(pools).forEach((pool) => {
      pool.forEach((recipe) => expect(recipe.time, `"${recipe.name}" — ${recipe.time} мин > 20`).toBeLessThanOrEqual(20));
    });
    // и правда что-то отсеклось, а не "у нас просто все рецепты короткие"
    const poolsUnrestricted = buildPools("any", [], allDevices, [], null);
    const totalRestricted = Object.values(pools).reduce((s, p) => s + p.length, 0);
    const totalUnrestricted = Object.values(poolsUnrestricted).reduce((s, p) => s + p.length, 0);
    expect(totalRestricted).toBeLessThan(totalUnrestricted);
  });

  it("maxCookTime смягчается фолбэком, если из-за него категория опустела (мягкое предпочтение, не жёсткое ограничение)", () => {
    // Нереалистично короткое время — не должно найтись НИ ОДНОГО рецепта в
    // какой-то категории по строгому фильтру, но пул всё равно не пуст —
    // значит фолбэк сработал (та же логика, что у кухни/техники).
    const pools = buildPools("any", [], [], [], 1);
    Object.values(pools).forEach((pool) => expect(pool.length).toBeGreaterThan(0));
  });

  it("maxCookTime отсутствует/null — ведёт себя как раньше, без ограничения времени", () => {
    const withoutArg = buildPools("any", [], [], []);
    const withNull = buildPools("any", [], [], [], null);
    Object.keys(withoutArg).forEach((cat) => {
      expect(withoutArg[cat].map((r) => r.id).sort()).toEqual(withNull[cat].map((r) => r.id).sort());
    });
  });

  it("аллергия не смягчается фолбэком, даже если из-за этого категория опустеет", () => {
    // Синтетический случай: аллергия, которая гипотетически покрывает все
    // рецепты категории — buildPools не должен тайком вернуть их обратно.
    // Берём реальный список запрещённых ингредиентов для ВСЕХ аллергий сразу
    // (самый жёсткий случай) и проверяем, что среди прошедших фильтр нет ни
    // одного нарушителя, даже если пул стал пустым.
    const pools = buildPools("any", [], [], ALLERGEN_IDS);
    const forbidden = new Set(ALLERGENS.flatMap((a) => a.ingredients));
    Object.values(pools).forEach((pool) => {
      pool.forEach((recipe) => {
        recipe.ingr.forEach(([name]) => expect(forbidden.has(name)).toBe(false));
      });
    });
  });
});

describe("buildInitialPlan", () => {
  const mkRecipe = (id, cost, category = "main") => ({ id, name: `r${id}`, cost, category, ingr: [], time: 10, emoji: "🍽️" });
  const MEALS_2 = [
    { id: "lunch", label: "Обед", category: "main" },
    { id: "dinner", label: "Ужин", category: "main" },
  ];

  it("целится в заданный бюджет, а не в среднее по пулу (регрессия: раньше round-robin игнорировал бюджет)", () => {
    const pool = [120, 150, 170, 190, 200, 220, 250, 270].map((c, i) => mkRecipe(i, c));
    const pools = { breakfast: [], main: pool, snack: [] };
    // 14 приёмов (2 в день × 7 дней), бюджет 3000 на семью из 2 -> 1500 на человека -> ~107/приём
    const plan = buildInitialPlan(pools, MEALS_2, 3000, 2);
    const perPersonTotal = plan.days.flatMap((d) => d.dayMeals).reduce((sum, m) => sum + pool.find((r) => r.id === m.recipeId).cost, 0);
    const total = perPersonTotal * 2;
    // Не обязано попасть тютелька-в-тютельку (дискретные цены), но должно
    // быть близко и точно не "как получится" — старый round-robin на этом
    // самом пуле давал ~3080 в среднем независимо от бюджета.
    expect(total).toBeGreaterThan(2500);
    expect(total).toBeLessThan(3500);
  });

  it("при бюджете ниже самого дешёвого варианта берёт минимально возможное, не роняясь", () => {
    const pool = [500, 600, 700].map((c, i) => mkRecipe(i, c));
    const pools = { breakfast: [], main: pool, snack: [] };
    const plan = buildInitialPlan(pools, MEALS_2, 100, 2);
    const allCosts = plan.days.flatMap((d) => d.dayMeals).map((m) => pool.find((r) => r.id === m.recipeId).cost);
    expect(allCosts.every((c) => c === 500)).toBe(true); // всегда самое дешёвое, план не падает
  });

  it("при большом бюджете не тратит больше, чем стоит самый дорогой рецепт в пуле, за приём", () => {
    const pool = [500, 600, 700].map((c, i) => mkRecipe(i, c));
    const pools = { breakfast: [], main: pool, snack: [] };
    const plan = buildInitialPlan(pools, MEALS_2, 999999, 2);
    const allCosts = plan.days.flatMap((d) => d.dayMeals).map((m) => pool.find((r) => r.id === m.recipeId).cost);
    expect(Math.max(...allCosts)).toBe(700);
  });

  it("помечает предупреждением и пропускает приём, если пул категории пуст", () => {
    const pools = { breakfast: [], main: [], snack: [] };
    const meals = [{ id: "breakfast", label: "Завтрак", category: "breakfast" }];
    const plan = buildInitialPlan(pools, meals, 3000, 2);
    expect(plan.warnings).toContain("Завтрак");
    expect(plan.days.every((d) => d.dayMeals.length === 0)).toBe(true);
  });

  it("не повторяет одно и то же блюдо больше 2 дней подряд, если в бюджете есть другие варианты", () => {
    const pool = [100, 105, 110, 115, 120].map((c, i) => mkRecipe(i, c));
    const pools = { breakfast: [], main: pool, snack: [] };
    const plan = buildInitialPlan(pools, [{ id: "lunch", label: "Обед", category: "main" }], 5000, 2);
    const ids = plan.days.map((d) => d.dayMeals[0].recipeId);
    for (let i = 2; i < ids.length; i++) {
      const allSame = ids[i] === ids[i - 1] && ids[i - 1] === ids[i - 2];
      expect(allSame, `дни ${i - 2}-${i} — три раза подряд одно и то же блюдо`).toBe(false);
    }
  });
});

describe("buildPlanView", () => {
  const recipe = {
    id: "r1", name: "Тест-рецепт", category: "main", cost: 100, time: 10, emoji: "🍽️",
    ingr: [["морковь", 200, "г"], ["яйцо", 2, "шт"]],
  };
  const pools = { breakfast: [], main: [recipe], snack: [] };
  const planState = { days: [{ day: 1, dayMeals: [{ mealId: "lunch", mealLabel: "Обед", category: "main", recipeId: "r1" }] }], warnings: [] };

  it("возвращает null без planState", () => {
    expect(buildPlanView(null, pools, 2, null)).toBeNull();
  });

  it("без priceByName считает total по cost рецепта × family (старое поведение)", () => {
    const view = buildPlanView(planState, pools, 2, null);
    expect(view.itemized).toBe(false);
    expect(view.total).toBe(100 * 2); // cost=100, family=2
  });

  it("группирует список покупок по отделам", () => {
    const view = buildPlanView(planState, pools, 2, null);
    const flat = view.grouped.flatMap((g) => g.items);
    expect(flat.find((it) => it.name === "морковь").dept).toBe("Овощи и фрукты");
    expect(flat.find((it) => it.name === "яйцо").dept).toBe("Молочное и яйца");
  });

  it("с priceByName считает total как сумму цен по позициям (итемизированная модель)", () => {
    const priceByName = new Map([
      ["морковь", { price: 55, productUnit: "кг" }], // 55 ₽/кг -> 0.055 ₽/г
      ["яйцо", { price: 10, productUnit: "шт" }],
    ]);
    const view = buildPlanView(planState, pools, 2, priceByName);
    expect(view.itemized).toBe(true);
    // морковь: 200г × 2 (family) = 400г × 0.055 ₽/г = 22 ₽
    // яйцо: 2шт × 2 (family) = 4шт × 10 ₽/шт = 40 ₽
    expect(view.total).toBe(22 + 40);
    expect(view.anyUnpriced).toBe(false);
  });

  it("помечает anyUnpriced, если цена товара не совпадает по 'роду' единиц (вес/объём vs штучно)", () => {
    // морковь у нас в граммах, а в каталоге вдруг нашлась "штучная" морковь —
    // разный род единиц, честно отказываемся от цены, а не считаем наугад
    const priceByName = new Map([["морковь", { price: 20, productUnit: "шт" }]]);
    const view = buildPlanView(planState, pools, 2, priceByName);
    expect(view.anyUnpriced).toBe(true);
    const carrotItem = view.grouped.flatMap((g) => g.items).find((it) => it.name === "морковь");
    expect(carrotItem.cost).toBeNull();
  });

  it("mostlyUnpriced=true, когда цену не нашли для большинства позиций (регрессия: жалоба 'корзина на 3000₽ стала 0₽' — на деле это был rate-limit ВкусВилл, но само сообщение об этом не говорило)", () => {
    // priceByName пуст целиком — как при системном сбое/rate-limit: ничего не резолвится
    const view = buildPlanView(planState, pools, 2, new Map());
    expect(view.mostlyUnpriced).toBe(true);
    expect(view.total).toBe(0);
  });

  it("mostlyUnpriced=false, когда не нашлась цена только для меньшинства позиций", () => {
    const priceByName = new Map([
      ["морковь", { price: 55, productUnit: "кг" }],
      // "яйцо" отсутствует в карте — 1 из 2 позиций без цены, это МЕНЬШИНСТВО
    ]);
    const view = buildPlanView(planState, pools, 2, priceByName);
    expect(view.anyUnpriced).toBe(true);
    expect(view.mostlyUnpriced).toBe(false);
  });

  it("mostlyUnpriced=false вне итемизированного режима (не-ВкусВилл — там своя, старая логика)", () => {
    const view = buildPlanView(planState, pools, 2, null);
    expect(view.mostlyUnpriced).toBe(false);
  });
});
