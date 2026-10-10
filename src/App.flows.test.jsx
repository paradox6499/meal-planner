// @vitest-environment jsdom
//
// Денежные инварианты главного экрана — защитная сетка перед разбиением
// MealPlanner на хуки (docs/refactor-plan-app-jsx.md, раздел 8, ответ 1).
// Бэкенд и каталог ВкусВилл замоканы: проверяем не сеть, а то, КОГДА
// приложение сообщает серверу о сборке плана (reportPlanGenerated — это
// списание бесплатного лимита или купленного кредита) и кладёт план в историю.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { buildPools } from "./lib/planLogic.js";
import { ALL_DEVICE_IDS } from "./constants.js";
import * as backend from "./lib/backend.js";
import * as vkusvillRecipes from "./lib/vkusvillRecipes.js";
import MealPlanner from "./App.jsx";

// Только сетевые функции — чистые (getBackendUrl, buildMealSlots и т.п.) остаются настоящими.
vi.mock("./lib/backend.js", async (importOriginal) => {
  const orig = await importOriginal();
  const network = [
    "checkPlanStatus", "sendSupportPrompt", "createPayment", "createProPayment", "createExtraPlanPayment",
    "resolvePricesViaBackend", "savePlanToHistory", "fetchPlanHistory", "updateMealTimes", "submitPlanToBackend",
    "reportPlanGenerated", "claimReferral", "fetchReferralStatus", "createFamily", "joinFamily", "leaveFamily",
    "fetchFamilyStatus", "toggleFamilyPantryItem", "deleteAccount", "callCatalogViaBackend",
  ];
  return { ...orig, ...Object.fromEntries(network.map((name) => [name, vi.fn(async () => null)])) };
});

vi.mock("./lib/vkusvillRecipes.js", async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, fetchVkusvillPools: vi.fn(), attachRealCosts: vi.fn() };
});

// Пулы "как из каталога ВкусВилл": статические рецепты с id вида vv-…
// (по этому префиксу приложение отличает каталог от запасного набора).
function catalogPools() {
  const pools = buildPools("any", [], ALL_DEVICE_IDS, [], null);
  return Object.fromEntries(Object.entries(pools).map(([cat, list]) => [cat, list.map((r) => ({ ...r, id: `vv-${r.id}` }))]));
}

// Цена на каждый ингредиент в той же единице, что и в рецепте — план полноценный.
function fullPrices(pools) {
  const map = new Map();
  Object.values(pools).flat().forEach((r) => r.ingr.forEach(([name, , unit]) => map.set(name, { price: 1, productUnit: unit })));
  return map;
}

function clickButton(name) {
  fireEvent.click(screen.getByRole("button", { name }));
}

// Визард новичка: магазин → семья → приёмы пищи → бюджет → рацион → аллергии.
async function passNewUserWizard() {
  for (let i = 0; i < 5; i++) clickButton(/Далее/);
  clickButton(/Аллергий нет/);
  clickButton(/Собрать список/);
  await screen.findByText("Ваш план на неделю");
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  // jsdom не реализует scrollIntoView (ResultView прокручивает к сегодняшнему дню).
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(backend.checkPlanStatus).mockResolvedValue({ ok: true, isPro: false, canGenerate: true, usedThisWeek: 0, extraPlanCredits: 0, nextResetHint: null });
  const pools = catalogPools();
  vi.mocked(vkusvillRecipes.fetchVkusvillPools).mockResolvedValue({ pools, priceByName: fullPrices(pools) });
  vi.mocked(vkusvillRecipes.attachRealCosts).mockResolvedValue(new Map());
});

afterEach(() => {
  cleanup();
});

describe("MealPlanner: когда сборка засчитывается", () => {
  it("полноценная сборка — ровно один reportPlanGenerated и одна запись в историю", async () => {
    render(<MealPlanner />);
    await passNewUserWizard();

    expect(backend.reportPlanGenerated).toHaveBeenCalledTimes(1);
    expect(backend.savePlanToHistory).toHaveBeenCalledTimes(1);
    expect(vkusvillRecipes.fetchVkusvillPools).toHaveBeenCalledTimes(1);
  });

  it("повторное открытие с сохранённым планом и замена блюда — НЕ засчитываются", async () => {
    const first = render(<MealPlanner />);
    await passNewUserWizard();
    first.unmount();
    vi.clearAllMocks();

    render(<MealPlanner />);
    // План восстановлен из localStorage, визарда нет.
    expect(await screen.findByText("Ваш план на неделю")).toBeTruthy();
    // Синхронизация напоминаний при открытии — да, это не списание.
    await waitFor(() => expect(backend.submitPlanToBackend).toHaveBeenCalled());

    const swap = screen.getAllByRole("button").find((b) => /Заменить блюдо/i.test(b.getAttribute("aria-label") || b.title || ""));
    expect(swap).toBeTruthy();
    fireEvent.click(swap);

    await new Promise((r) => setTimeout(r, 50));
    expect(backend.reportPlanGenerated).not.toHaveBeenCalled();
    expect(backend.savePlanToHistory).not.toHaveBeenCalled();
  });

  it("каталог не ответил — базовые рецепты, сборка НЕ засчитывается и не попадает в историю", async () => {
    vi.mocked(vkusvillRecipes.fetchVkusvillPools).mockRejectedValue(new Error("сеть недоступна"));
    render(<MealPlanner />);
    await passNewUserWizard();

    expect(screen.getByText(/Бесплатный план при этом не тратится/)).toBeTruthy();
    expect(backend.reportPlanGenerated).not.toHaveBeenCalled();
    expect(backend.savePlanToHistory).not.toHaveBeenCalled();
  });

  it("рецепты из каталога без цен — не засчитано; после удачного повтора цен — засчитано ровно один раз", async () => {
    const pools = catalogPools();
    vi.mocked(vkusvillRecipes.fetchVkusvillPools).mockResolvedValue({ pools, priceByName: new Map() });
    render(<MealPlanner />);
    await passNewUserWizard();
    expect(backend.reportPlanGenerated).not.toHaveBeenCalled();

    // Неудачный повтор — по-прежнему не засчитано.
    vi.mocked(vkusvillRecipes.attachRealCosts).mockResolvedValueOnce(new Map());
    clickButton(/Повторить получение цен/);
    await waitFor(() => expect(vkusvillRecipes.attachRealCosts).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: /Повторить получение цен/ });
    expect(backend.reportPlanGenerated).not.toHaveBeenCalled();

    // Удачный повтор — засчитано и в истории, плашка ушла.
    vi.mocked(vkusvillRecipes.attachRealCosts).mockResolvedValueOnce(fullPrices(pools));
    clickButton(/Повторить получение цен/);
    await waitFor(() => expect(backend.reportPlanGenerated).toHaveBeenCalledTimes(1));
    expect(backend.savePlanToHistory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Повторить получение цен/ })).toBeNull());
  });

  it("бесплатный лимит исчерпан — экран лимита сразу при открытии, каталог не запрашивается", async () => {
    vi.mocked(backend.checkPlanStatus).mockResolvedValue({ ok: true, isPro: false, canGenerate: false, usedThisWeek: 1, extraPlanCredits: 0, nextResetHint: "2026-10-17T10:00:00.000Z" });
    render(<MealPlanner />);

    expect(await screen.findByText("Бесплатный лимит на этой неделе исчерпан")).toBeTruthy();
    expect(vkusvillRecipes.fetchVkusvillPools).not.toHaveBeenCalled();
    expect(backend.reportPlanGenerated).not.toHaveBeenCalled();
  });
});
