import { describe, it, expect } from "vitest";
import {
  DISLIKE_PRESETS, normalizeDislike, dislikeLabel, isPresetDislike, nameHasDislike, recipeHasDislike, applyDislikes, DISLIKE_MIN_POOL,
} from "./dislikes.js";

const recipe = (id, ...names) => ({ id, ingr: names.map((n) => [n, 100, "г"]) });

describe("нелюбимые продукты: совпадение по началу слова", () => {
  it("«лук» находит лук репчатый, зелёный лук и луковицу, но не «полукопчёную» колбасу", () => {
    expect(nameHasDislike("Лук репчатый", ["onion"])).toBe(true);
    expect(nameHasDislike("Лук зелёный", ["onion"])).toBe(true);
    expect(nameHasDislike("Луковица", ["onion"])).toBe(true);
    expect(nameHasDislike("Колбаса полукопчёная", ["onion"])).toBe(false);
  });

  it("«печень» не цепляет «печенье» и «печёные овощи»", () => {
    expect(nameHasDislike("Печень куриная", ["offal"])).toBe(true);
    expect(nameHasDislike("Печенье овсяное", ["offal"])).toBe(false);
    expect(nameHasDislike("Печёный перец", ["offal"])).toBe(false);
  });

  it("свои слова: основа находит формы («баклажан» → «баклажаны»), регистр и ё не важны", () => {
    expect(nameHasDislike("Баклажаны", ["баклажан"])).toBe(true);
    expect(nameHasDislike("Свёкла", ["свекл"])).toBe(true);
    expect(nameHasDislike("Свекла вареная", ["свёкл".replace("ё", "е")])).toBe(true);
  });

  it("готовые варианты: грибы, рыба, морепродукты, острое", () => {
    expect(nameHasDislike("Шампиньоны", ["mushrooms"])).toBe(true);
    expect(nameHasDislike("Филе лосося", ["fish"])).toBe(true);
    expect(nameHasDislike("Креветки очищенные", ["seafood"])).toBe(true);
    expect(nameHasDislike("Перец чили", ["spicy"])).toBe(true);
    expect(nameHasDislike("Перец сладкий", ["spicy"])).toBe(false);
  });

  it("пустой список нелюбимого ничего не находит", () => {
    expect(nameHasDislike("Лук", [])).toBe(false);
    expect(nameHasDislike("Лук", undefined)).toBe(false);
  });

  it("фраза из нескольких слов ищется как есть", () => {
    expect(nameHasDislike("Сыр плавленый", ["сыр плавленый"])).toBe(true);
    expect(nameHasDislike("Сыр твёрдый", ["сыр плавленый"])).toBe(false);
  });
});

describe("нелюбимые продукты: слова пользователя", () => {
  it("normalizeDislike: строчные, без знаков и лишних пробелов, ё→е, слишком короткое отбрасывается", () => {
    expect(normalizeDislike("  Тыква!! ")).toBe("тыква");
    expect(normalizeDislike("Свёкла")).toBe("свекла");
    expect(normalizeDislike("а")).toBeNull();
    expect(normalizeDislike("   ")).toBeNull();
    expect(normalizeDislike(null)).toBeNull();
    expect(normalizeDislike("я".repeat(80))).toHaveLength(30);
  });

  it("подпись: у готового варианта — название, у своего слова — оно само", () => {
    expect(dislikeLabel("mushrooms")).toBe("Грибы");
    expect(dislikeLabel("тыква")).toBe("тыква");
    expect(isPresetDislike("fish")).toBe(true);
    expect(isPresetDislike("тыква")).toBe(false);
  });

  it("у всех готовых вариантов есть id, подпись и ключи", () => {
    for (const p of DISLIKE_PRESETS) {
      expect(p.id).toBeTruthy(); expect(p.label).toBeTruthy(); expect(p.keywords.length).toBeGreaterThan(0);
    }
    expect(new Set(DISLIKE_PRESETS.map((p) => p.id)).size).toBe(DISLIKE_PRESETS.length);
  });
});

describe("applyDislikes: мягкое ограничение", () => {
  const pool = [recipe(1, "Курица", "Лук"), recipe(2, "Гречка"), recipe(3, "Рис"), recipe(4, "Картофель"), recipe(5, "Тыква")];

  it("убирает рецепты с нелюбимым, если остаётся достаточно", () => {
    const r = applyDislikes(pool, ["onion"]);
    expect(r.recipes.map((x) => x.id)).toEqual([2, 3, 4, 5]);
    expect(r.softened).toBe(false);
  });

  it("если осталось меньше DISLIKE_MIN_POOL — возвращает исходный список и помечает softened", () => {
    const r = applyDislikes(pool, ["onion", "гречк", "рис", "картофел"]);
    expect(r.softened).toBe(true);
    expect(r.recipes).toHaveLength(pool.length);
  });

  it("маленький исходный пул (меньше порога) не считается «смягчённым», если фильтр ничего не убрал", () => {
    const small = [recipe(1, "Гречка"), recipe(2, "Рис")];
    const r = applyDislikes(small, ["onion"]);
    expect(r.softened).toBe(false);
    expect(r.recipes).toHaveLength(2);
  });

  it("без нелюбимого — тот же список, softened=false", () => {
    expect(applyDislikes(pool, [])).toEqual({ recipes: pool, softened: false });
    expect(DISLIKE_MIN_POOL).toBe(4);
  });

  it("recipeHasDislike смотрит только на названия ингредиентов", () => {
    expect(recipeHasDislike(recipe(1, "Курица", "Лук"), ["onion"])).toBe(true);
    expect(recipeHasDislike({ name: "Луковый суп", ingr: [["Вода", 1, "л"]] }, ["onion"])).toBe(false);
  });
});
