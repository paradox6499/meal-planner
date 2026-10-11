// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RecipeModal } from "./RecipeModal.jsx";
import { FavoritesSection, FAVORITES_VISIBLE_DEFAULT } from "./account/FavoritesSection.jsx";
import { reloadRecipeBook, toggleFavorite, toggleCookedToday } from "../lib/recipeBook.js";

const recipe = (n) => ({ id: `vv-${n}`, name: `Блюдо ${n}`, emoji: "🍲", time: 20, ingr: [["Вода", 1, "л"]], steps: ["Варить"], nutritionPer100g: null });
const dm = (n = 1) => ({ recipe: recipe(n), cost: 100, isRealPrice: true });

beforeEach(() => { localStorage.clear(); reloadRecipeBook(); });
afterEach(cleanup);

describe("окно рецепта: избранное и «приготовил»", () => {
  it("сердечко добавляет в избранное и убирает; состояние видно на кнопке", () => {
    render(<RecipeModal dm={dm()} family={2} onClose={() => {}} />);
    const heart = screen.getByRole("button", { name: /В избранное/ });
    expect(heart.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(heart);
    expect(screen.getByRole("button", { name: /В избранном/ }).getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem("sedim.recipeBook.v1")).favorites).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /В избранном/ }));
    expect(JSON.parse(localStorage.getItem("sedim.recipeBook.v1")).favorites).toHaveLength(0);
  });

  it("«Приготовил(а)» отмечает на сегодня, показывает счётчик, повторное нажатие снимает", () => {
    render(<RecipeModal dm={dm()} family={2} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Приготовил/ }));
    expect(screen.getByRole("button", { name: /Приготовлено сегодня/ })).toBeTruthy();
    expect(screen.getByText(/Готовили 1 раз/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Приготовлено сегодня/ }));
    expect(screen.queryByText(/Готовили/)).toBeNull();
  });

  it("отметки сохраняются между открытиями окна", () => {
    const first = render(<RecipeModal dm={dm()} family={2} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /В избранное/ }));
    first.unmount();
    render(<RecipeModal dm={dm()} family={2} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /В избранном/ })).toBeTruthy();
  });
});

describe("Избранное в Аккаунте", () => {
  it("пусто — раздела нет вообще", () => {
    const { container } = render(<FavoritesSection family={2} />);
    expect(container.textContent).toBe("");
  });

  it("показывает последние добавленные, остальное по кнопке; нажатие открывает рецепт", () => {
    for (let n = 1; n <= FAVORITES_VISIBLE_DEFAULT + 2; n++) toggleFavorite(dm(n));
    render(<FavoritesSection family={2} />);
    expect(screen.getByText(`Блюдо ${FAVORITES_VISIBLE_DEFAULT + 2}`)).toBeTruthy(); // новые сверху
    expect(screen.queryByText("Блюдо 1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Показать ещё 2/ }));
    expect(screen.getByText("Блюдо 1")).toBeTruthy();
    fireEvent.click(screen.getByText("Блюдо 1"));
    expect(screen.getByText("Ингредиенты")).toBeTruthy(); // окно рецепта открылось
  });

  it("если есть только отметки «приготовил» — раздел виден со счётчиком", () => {
    toggleCookedToday({ id: "vv-9" });
    render(<FavoritesSection family={2} />);
    expect(screen.getByText(/всего приготовлено: 1/)).toBeTruthy();
  });
});
