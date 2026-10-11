// «Книга рецептов» человека: избранное и отметки «приготовил(а)». Хранится ТОЛЬКО на устройстве (localStorage), на
// сервер не уходит — как профиль и планы; «Удалить мои данные» стирает всё вместе с остальным локальным.
//
// Рецепт ищем по ключу: id рецепта (у каталога ВкусВилл — «vv-…»), а у старых записей истории без id — по названию.
import { useSyncExternalStore } from "react";

const KEY = "sedim.recipeBook.v1";
export const MAX_FAVORITES = 50;
const MAX_COOKED_DATES = 60; // на один рецепт; старше — не нужны

export const recipeKey = (recipe) => String(recipe?.id ?? recipe?.name ?? "");

// Минимум полей, чтобы открыть рецепт позже без каталога (как в истории планов).
const compactRecipe = (r) => ({
  id: r.id ?? null, name: r.name, emoji: r.emoji ?? null, photoUrl: r.photoUrl ?? null, time: r.time ?? null,
  ingr: r.ingr ?? [], steps: r.steps ?? [], nutritionPer100g: r.nutritionPer100g ?? null,
});

const EMPTY = { favorites: [], cooked: {} };
let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || typeof raw !== "object") return EMPTY;
    return {
      favorites: Array.isArray(raw.favorites) ? raw.favorites.filter((f) => f && f.key && f.recipe?.name) : [],
      cooked: raw.cooked && typeof raw.cooked === "object" ? raw.cooked : {},
    };
  } catch {
    return EMPTY;
  }
}

function commit(next) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* приватный режим/квота: работаем в памяти до закрытия приложения, не критично */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const getSnapshot = () => state;

/** Для тестов: перечитать состояние из localStorage (после ручной подготовки/очистки). */
export function reloadRecipeBook() {
  state = load();
  listeners.forEach((l) => l());
}

export const todayISO = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export function isFavorite(book, recipe) {
  return book.favorites.some((f) => f.key === recipeKey(recipe));
}

/** Добавляет в избранное или убирает. dm — как в окне рецепта: { recipe, cost }. Возвращает true, если теперь в избранном. */
export function toggleFavorite(dm) {
  const key = recipeKey(dm.recipe);
  if (!key) return false;
  if (state.favorites.some((f) => f.key === key)) {
    commit({ ...state, favorites: state.favorites.filter((f) => f.key !== key) });
    return false;
  }
  const entry = { key, recipe: compactRecipe(dm.recipe), cost: dm.cost ?? null, savedAt: new Date().toISOString() };
  commit({ ...state, favorites: [entry, ...state.favorites].slice(0, MAX_FAVORITES) });
  return true;
}

export function cookedDates(book, recipe) {
  return book.cooked[recipeKey(recipe)] ?? [];
}

export const cookedToday = (book, recipe, now = new Date()) => cookedDates(book, recipe).includes(todayISO(now));

/** «Приготовил(а) сегодня» — переключатель на сегодняшнюю дату (повторное нажатие снимает отметку). Возвращает true, если отмечено. */
export function toggleCookedToday(recipe, now = new Date()) {
  const key = recipeKey(recipe);
  if (!key) return false;
  const today = todayISO(now);
  const dates = state.cooked[key] ?? [];
  if (dates.includes(today)) {
    const left = dates.filter((d) => d !== today);
    const cooked = { ...state.cooked };
    if (left.length === 0) delete cooked[key]; else cooked[key] = left;
    commit({ ...state, cooked });
    return false;
  }
  commit({ ...state, cooked: { ...state.cooked, [key]: [...dates, today].slice(-MAX_COOKED_DATES) } });
  return true;
}

/** Всего приготовлено раз (по всем рецептам и датам). */
export const totalCooked = (book) => Object.values(book.cooked).reduce((sum, dates) => sum + dates.length, 0);

export const useRecipeBook = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
