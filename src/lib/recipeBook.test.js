// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  recipeKey, reloadRecipeBook, toggleFavorite, isFavorite, toggleCookedToday, cookedDates, cookedToday, totalCooked, todayISO, MAX_FAVORITES,
} from "./recipeBook.js";

// Снимок состояния — через localStorage (так же, как читает его само приложение).
const book = () => JSON.parse(localStorage.getItem("sedim.recipeBook.v1") || '{"favorites":[],"cooked":{}}');
const asBook = () => { const b = book(); return { favorites: b.favorites, cooked: b.cooked }; };
const dm = (over = {}) => ({ recipe: { id: "vv-1", name: "Суп", emoji: "🍲", time: 30, ingr: [["Вода", 1, "л"]], steps: ["Варить"], ...over }, cost: 120 });

beforeEach(() => { localStorage.clear(); reloadRecipeBook(); });

describe("recipeBook: избранное", () => {
  it("добавляет и убирает рецепт, ключ — id; хранит всё нужное, чтобы открыть без каталога", () => {
    expect(toggleFavorite(dm())).toBe(true);
    expect(isFavorite(asBook(), { id: "vv-1" })).toBe(true);
    const saved = book().favorites[0];
    expect(saved).toMatchObject({ key: "vv-1", cost: 120, recipe: { name: "Суп", ingr: [["Вода", 1, "л"]], steps: ["Варить"] } });
    expect(toggleFavorite(dm())).toBe(false);
    expect(book().favorites).toEqual([]);
  });

  it("у рецептов без id (старая история) ключ — название", () => {
    expect(recipeKey({ name: "Борщ" })).toBe("Борщ");
    toggleFavorite(dm({ id: undefined, name: "Борщ" }));
    expect(isFavorite(asBook(), { name: "Борщ" })).toBe(true);
  });

  it("новые — сверху; больше MAX_FAVORITES — самые старые вытесняются", () => {
    for (let i = 0; i < MAX_FAVORITES + 3; i++) toggleFavorite(dm({ id: `r${i}`, name: `Блюдо ${i}` }));
    const favs = book().favorites;
    expect(favs).toHaveLength(MAX_FAVORITES);
    expect(favs[0].key).toBe(`r${MAX_FAVORITES + 2}`);
    expect(favs.some((f) => f.key === "r0")).toBe(false);
  });

  it("повреждённые данные в localStorage не ломают загрузку", () => {
    localStorage.setItem("sedim.recipeBook.v1", "{не json");
    reloadRecipeBook();
    expect(toggleFavorite(dm())).toBe(true);
  });
});

describe("recipeBook: приготовлено", () => {
  const now = new Date(2026, 9, 11, 12, 0);

  it("отметка на сегодня переключается; даты копятся по дням; счётчик по всем рецептам", () => {
    expect(toggleCookedToday({ id: "vv-1" }, now)).toBe(true);
    expect(cookedToday(asBook(), { id: "vv-1" }, now)).toBe(true);
    expect(toggleCookedToday({ id: "vv-1" }, new Date(2026, 9, 12, 9, 0))).toBe(true);
    expect(cookedDates(asBook(), { id: "vv-1" })).toEqual(["2026-10-11", "2026-10-12"]);
    toggleCookedToday({ id: "vv-2" }, now);
    expect(totalCooked(asBook())).toBe(3);
    expect(toggleCookedToday({ id: "vv-1" }, now)).toBe(false); // снять отметку за 11 октября
    expect(cookedDates(asBook(), { id: "vv-1" })).toEqual(["2026-10-12"]);
  });

  it("последняя снятая отметка убирает запись рецепта совсем", () => {
    toggleCookedToday({ id: "vv-1" }, now);
    toggleCookedToday({ id: "vv-1" }, now);
    expect(book().cooked["vv-1"]).toBeUndefined();
  });

  it("todayISO — локальная дата без UTC-сдвига", () => {
    expect(todayISO(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
