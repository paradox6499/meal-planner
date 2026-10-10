// Нелюбимые продукты — МЯГКОЕ предпочтение, в отличие от аллергий (те исключают рецепт жёстко и всегда).
// Человек выбирает готовые варианты (грибы, лук, …) или вводит своё слово; рецепты, где такой продукт есть
// среди ингредиентов, в план стараемся не брать. Если подходящих рецептов совсем мало, ограничение
// смягчается (см. applyDislikes) — лучше план с одним нелюбимым ингредиентом, чем пустой.
//
// В профиле хранится массив строк: id готового варианта («mushrooms») или своё слово («тыква»).

// Ключи — начала слов: «лук» находит «лук репчатый» и «зелёный лук», но не «полукопчёная» (там «лук» внутри слова).
// Знак «$» в конце — слово целиком: «печень$» не цепляет «печенье» (оно тоже начинается с «печень»).
export const DISLIKE_PRESETS = [
  { id: "mushrooms", label: "Грибы", keywords: ["гриб", "шампиньон", "вешенк", "лисичк", "опят"] },
  { id: "eggplant", label: "Баклажаны", keywords: ["баклажан"] },
  { id: "onion", label: "Лук", keywords: ["лук"] },
  { id: "garlic", label: "Чеснок", keywords: ["чеснок"] },
  { id: "cilantro", label: "Кинза", keywords: ["кинз"] },
  { id: "celery", label: "Сельдерей", keywords: ["сельдер"] },
  { id: "broccoli", label: "Брокколи", keywords: ["брокколи"] },
  { id: "offal", label: "Печень и субпродукты", keywords: ["печень$", "печени$", "печёнк", "печенк", "сердц", "желудк", "субпродукт"] },
  { id: "fish", label: "Рыба", keywords: ["рыб", "лосос", "форел", "сёмг", "семг", "треск", "скумбри", "сельд", "тунец", "минтай", "горбуш"] },
  { id: "seafood", label: "Морепродукты", keywords: ["креветк", "кальмар", "мидии", "морепродукт", "осьминог"] },
  { id: "lamb", label: "Баранина", keywords: ["баранин", "ягнят"] },
  { id: "spicy", label: "Острое", keywords: ["чили", "халапеньо", "кайенск", "табаско"] },
];

const PRESET_BY_ID = new Map(DISLIKE_PRESETS.map((p) => [p.id, p]));
export const MAX_CUSTOM_DISLIKES = 15;
const MAX_WORD_LENGTH = 30;

export const isPresetDislike = (entry) => PRESET_BY_ID.has(entry);

/** Приводит введённое слово к виду для хранения: строчные, без лишних знаков и пробелов; null, если слово негодное. */
export function normalizeDislike(text) {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^а-яa-z0-9\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WORD_LENGTH)
    .trim();
  return t.length >= 2 ? t : null;
}

/** Подпись для показа: у готового варианта — «Грибы», у своего слова — оно само. */
export function dislikeLabel(entry) {
  return PRESET_BY_ID.get(entry)?.label ?? entry;
}

const normalizeIngredientName = (name) => String(name ?? "").toLowerCase().replace(/ё/g, "е");
const keywordsOf = (entry) => (PRESET_BY_ID.get(entry)?.keywords ?? [entry]).map((k) => k.replace(/ё/g, "е"));

function nameMatchesKeyword(normalizedName, keyword) {
  if (keyword.includes(" ")) return normalizedName.includes(keyword); // фраза — как есть
  const words = normalizedName.split(/[^а-яa-z0-9]+/);
  if (keyword.endsWith("$")) return words.includes(keyword.slice(0, -1)); // слово целиком
  return words.some((word) => word.startsWith(keyword));
}

/** Есть ли в названии ингредиента что-то из нелюбимого. */
export function nameHasDislike(name, dislikes) {
  if (!dislikes || dislikes.length === 0) return false;
  const normalized = normalizeIngredientName(name);
  return dislikes.some((entry) => keywordsOf(entry).some((kw) => nameMatchesKeyword(normalized, kw)));
}

/** Есть ли нелюбимое среди ингредиентов рецепта (recipe.ingr — [[название, количество, единица], …]). */
export function recipeHasDislike(recipe, dislikes) {
  if (!dislikes || dislikes.length === 0) return false;
  return (recipe.ingr || []).some(([name]) => nameHasDislike(name, dislikes));
}

// Меньше стольки рецептов в категории после фильтра — ограничение смягчаем (иначе повторяются блюда или нечего выбрать).
export const DISLIKE_MIN_POOL = 4;

/** Убирает рецепты с нелюбимым. Если осталось меньше minKeep, возвращает исходный список (softened: true). */
export function applyDislikes(recipes, dislikes, minKeep = DISLIKE_MIN_POOL) {
  if (!dislikes || dislikes.length === 0) return { recipes, softened: false };
  const filtered = recipes.filter((r) => !recipeHasDislike(r, dislikes));
  if (filtered.length >= Math.min(minKeep, recipes.length)) return { recipes: filtered, softened: false };
  return { recipes, softened: true };
}
