import { describe, it, expect } from "vitest";
import { estimateWeek, assessBudget, budgetMessage, PORTION_COST_VV, PORTION_COST_STATIC, WEEK_DAYS } from "./budgetCheck.js";

const two = { meals: ["lunch", "dinner"], family: 2 };

describe("estimateWeek", () => {
  it("двое, обед и ужин на 7 дней: 28 порций, ориентиры кратны 50 ₽", () => {
    const e = estimateWeek(two);
    expect(e.portions).toBe(WEEK_DAYS * 2 * 2);
    for (const k of ["floor", "comfy", "generous"]) expect(e[k] % 50).toBe(0);
    expect(e.floor).toBeLessThan(e.comfy);
    expect(e.comfy).toBeLessThan(e.generous);
  });

  it("стандартный бюджет 4 000 ₽ на двоих (обед и ужин) попадает в «хватит» — как в настоящих сборках", () => {
    expect(assessBudget(4000, estimateWeek(two)).level).toBe("ok");
  });

  it("по приёмам пищи можно задать разное число едоков (familyByMeal)", () => {
    const base = estimateWeek({ meals: ["breakfast", "dinner"], family: 2 });
    const mixed = estimateWeek({ meals: ["breakfast", "dinner"], family: 2, familyByMeal: { breakfast: 1 } });
    expect(mixed.portions).toBe(WEEK_DAYS * (1 + 2));
    expect(mixed.comfy).toBeLessThan(base.comfy);
  });

  it("больше приёмов пищи и людей — больше ориентир; неизвестный приём пищи игнорируется", () => {
    expect(estimateWeek({ meals: ["breakfast", "lunch", "dinner"], family: 3 }).comfy).toBeGreaterThan(estimateWeek(two).comfy);
    expect(estimateWeek({ meals: ["неизвестно"], family: 2 }).portions).toBe(0);
  });

  it("для магазинов без каталога ориентиры считаются из встроенных рецептов и тоже упорядочены", () => {
    for (const c of ["breakfast", "main", "snack"]) {
      const t = PORTION_COST_STATIC[c];
      expect(t.floor).toBeLessThan(t.comfy);
      expect(t.comfy).toBeLessThan(t.generous);
      expect(PORTION_COST_VV[c].floor).toBeLessThan(PORTION_COST_VV[c].comfy);
    }
    expect(estimateWeek({ ...two, store: "px" }).portions).toBe(28);
  });
});

describe("assessBudget", () => {
  const est = { floor: 2100, comfy: 3800, generous: 7000, portions: 28 };

  it("четыре уровня по порогам", () => {
    expect(assessBudget(1500, est).level).toBe("low");
    expect(assessBudget(3000, est).level).toBe("tight");
    expect(assessBudget(5000, est).level).toBe("ok");
    expect(assessBudget(9000, est).level).toBe("rich");
  });

  it("границы: ровно floor — уже «впритык», ровно comfy — «хватит», ровно generous — «с запасом»", () => {
    expect(assessBudget(2100, est).level).toBe("tight");
    expect(assessBudget(3800, est).level).toBe("ok");
    expect(assessBudget(7000, est).level).toBe("rich");
  });

  it("сумма на порцию считается от всех порций недели", () => {
    expect(assessBudget(2800, est).perPortion).toBe(100);
  });

  it("предлагается разумная сумма только когда мало, кратная шагу слайдера и в его пределах; иначе null", () => {
    expect(assessBudget(1500, est).suggest).toBe(4000); // 3800 → вверх до шага 250
    expect(assessBudget(3000, est).suggest).toBe(4000);
    expect(assessBudget(assessBudget(3000, est).suggest, est).level).toBe("ok"); // принятое предложение попадает в «Хватит»
    expect(assessBudget(5000, est).suggest).toBeNull();
    expect(assessBudget(9000, est).suggest).toBeNull();
    expect(assessBudget(1500, { ...est, comfy: 30000 }).suggest).toBe(15000); // не выше максимума слайдера
  });

  it("если уже выбран максимум слайдера, а ориентир выше — кнопки нет (предложить больше нельзя)", () => {
    const a = assessBudget(15000, { floor: 16000, comfy: 20000, generous: 30000, portions: 28 });
    expect(a.level).toBe("low");
    expect(a.suggest).toBeNull();
  });

  it("без порций (нет приёмов пищи) оценки нет", () => {
    expect(assessBudget(4000, estimateWeek({ meals: [], family: 2 }))).toBeNull();
    expect(assessBudget(4000, null)).toBeNull();
  });
});

describe("budgetMessage", () => {
  it("заголовок и текст под каждым уровнем; в «маловато» и «впритык» названа сумма ориентира", () => {
    const base = { perPortion: 90, comfy: 3800, portions: 28 };
    expect(budgetMessage({ ...base, level: "low" })).toEqual({ title: "Маловато", text: expect.stringMatching(/3\s?800/) });
    expect(budgetMessage({ ...base, level: "tight" }).title).toBe("Впритык");
    expect(budgetMessage({ ...base, level: "ok" }).title).toBe("Хватит");
    expect(budgetMessage({ ...base, level: "rich" }).title).toBe("С запасом");
    expect(budgetMessage({ ...base, level: "ok" }).text).toMatch(/90 ₽ на порцию/);
  });
});
