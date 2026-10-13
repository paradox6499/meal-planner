// Защита от неподходящего товара в поиске каталога. Каталог ищет по смыслу и для странного названия
// ингредиента («Лук перо») отдаёт в первых десяти комбо-наборы и онигири по 380 ₽: они и попадали в
// цену и в корзину. Берём из выдачи не первый товар, а первый, в названии которого есть слово
// ингредиента; если в выдаче такого нет — пробуем искать по отдельным словам названия.
// Этот файл продублирован в server/src/productMatch.js (сервер не импортирует из src/): держите в синхроне.

const MIN_WORD_LEN = 3;

function words(text) {
  return String(text || "").toLowerCase().replace(/ё/g, "е").match(/[a-zа-я]+/g) || [];
}

// Основа слова: «огурец»/«огурцы» → «огур», «картофель»/«картошка» → «карт»; короткие слова («лук», «перо»)
// берём целиком — иначе «перо» совпадало бы с «перепелиные». Совпадение по началу слова.
function stemOf(word) {
  return word.length <= 4 ? word : word.slice(0, 4);
}

// Слова-определения, по которым товар не опознать: «свежий» есть у половины каталога («Сыр свежий для салатов»).
const GENERIC_WORDS = ["свеж", "натур", "мелк", "крупн", "молод", "спел", "домаш", "охла"];

export function significantWords(name) {
  return words(name).filter((w) => w.length >= MIN_WORD_LEN && !GENERIC_WORDS.some((g) => w.startsWith(g)));
}

/** Есть ли в названии товара хотя бы одно слово из названия ингредиента. */
export function isRelevantProduct(ingredientName, product) {
  const stems = significantWords(ingredientName).map(stemOf);
  if (stems.length === 0) return true; // нечем проверять — не придираемся
  const productWords = words(product?.name);
  return stems.some((s) => productWords.some((pw) => pw.startsWith(s)));
}

/** Первый подходящий товар из выдачи или null. */
export function pickRelevantProduct(ingredientName, items) {
  return (items || []).find((p) => isRelevantProduct(ingredientName, p)) ?? null;
}

/** Запросы, которыми можно переискать, если полное название не дало подходящего товара: по одному слову. */
export function fallbackQueries(ingredientName) {
  const all = significantWords(ingredientName);
  return all.length > 1 ? [...new Set(all)] : [];
}

/**
 * Находит товар для ингредиента. search(q) -> { items }. Порядок: подходящий товар из полной выдачи,
 * затем из выдач по отдельным словам, и только если ничего подходящего нет нигде — прежнее поведение
 * (первый товар полной выдачи), чтобы синонимы вроде «картошка»/«картофель» не остались без цены.
 */
export async function findProductFor(ingredientName, search) {
  const first = await search(ingredientName);
  const items = first?.items || [];
  if (items.length === 0) return null;
  const direct = pickRelevantProduct(ingredientName, items);
  if (direct) return direct;
  for (const q of fallbackQueries(ingredientName)) {
    const retry = await search(q);
    const hit = pickRelevantProduct(ingredientName, retry?.items);
    if (hit) return hit;
  }
  return items[0];
}
