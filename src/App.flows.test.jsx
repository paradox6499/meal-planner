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

  it("сеть с пометкой «скоро» — оценочный план без заказа НЕ списывает бесплатный план", async () => {
    render(<MealPlanner />);
    clickButton(/Другие сети — скоро/);
    clickButton(/Пятёрочка/);
    await passNewUserWizard();
    expect(backend.reportPlanGenerated).not.toHaveBeenCalled();
    expect(backend.savePlanToHistory).not.toHaveBeenCalled();
    expect(vkusvillRecipes.fetchVkusvillPools).not.toHaveBeenCalled();
  });

  it("каталог не ответил только по части категорий — сборка НЕ засчитывается (раньше списывала план с ложным «под ваши аллергии»)", async () => {
    const pools = catalogPools();
    vi.mocked(vkusvillRecipes.fetchVkusvillPools).mockResolvedValue({
      pools: { ...pools, main: [] }, priceByName: fullPrices(pools), failedCategories: ["main"],
    });
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

  it("открытие по реферальной ссылке с сохранённым планом — заявка уходит РАНЬШЕ синхронизации плана", async () => {
    // Синхронизация (/api/plan) создаёт строку пользователя на сервере — после
    // неё заявка была бы отклонена как «уже существует». Порядок держится
    // порядком вызова хуков в MealPlanner.
    const first = render(<MealPlanner />);
    await passNewUserWizard();
    first.unmount();
    vi.clearAllMocks();

    window.Telegram = { WebApp: { initDataUnsafe: { start_param: "ref_5" } } };
    try {
      render(<MealPlanner />);
      await waitFor(() => expect(backend.submitPlanToBackend).toHaveBeenCalled());
      expect(backend.claimReferral).toHaveBeenCalledWith(5);
      expect(vi.mocked(backend.claimReferral).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(backend.submitPlanToBackend).mock.invocationCallOrder[0]);
    } finally {
      delete window.Telegram;
    }
  });

  it("бесплатный лимит исчерпан — экран лимита сразу при открытии, каталог не запрашивается", async () => {
    vi.mocked(backend.checkPlanStatus).mockResolvedValue({ ok: true, isPro: false, canGenerate: false, usedThisWeek: 1, extraPlanCredits: 0, nextResetHint: "2026-10-17T10:00:00.000Z" });
    render(<MealPlanner />);

    expect(await screen.findByText("Бесплатный лимит на этой неделе исчерпан")).toBeTruthy();
    expect(vkusvillRecipes.fetchVkusvillPools).not.toHaveBeenCalled();
    expect(backend.reportPlanGenerated).not.toHaveBeenCalled();
  });
});

describe("MealPlanner: «ждёт засчитывания» принадлежит конкретному плану", () => {
  const PRO = { ok: true, isPro: true, canGenerate: true, usedThisWeek: 0, extraPlanCredits: 0, nextResetHint: null };
  const slotChips = () => screen.getAllByRole("button").filter((b) => /^ВкусВилл · /.test(b.textContent.trim()));
  const pendingNote = () => screen.queryByText(/Бесплатный план при этом не тратится/);

  // Короткий визард вернувшегося пользователя: магазин → бюджет.
  async function passReturningUserWizard() {
    clickButton(/Далее/);
    clickButton(/Собрать список/);
    await screen.findByText("Ваш план на неделю");
  }

  it("вырожденная сборка, перезапуск приложения, удачный повтор цен — засчитано ровно один раз", async () => {
    const pools = catalogPools();
    vi.mocked(vkusvillRecipes.fetchVkusvillPools).mockResolvedValue({ pools, priceByName: new Map() });
    const first = render(<MealPlanner />);
    await passNewUserWizard();
    first.unmount();
    vi.clearAllMocks();
    vi.mocked(backend.checkPlanStatus).mockResolvedValue({ ok: true, isPro: false, canGenerate: true, usedThisWeek: 0, extraPlanCredits: 0, nextResetHint: null });

    render(<MealPlanner />);
    await screen.findByText("Ваш план на неделю");
    // После перезапуска план по-прежнему «не засчитан» — и экран это говорит.
    expect(pendingNote()).toBeTruthy();

    vi.mocked(vkusvillRecipes.attachRealCosts).mockResolvedValueOnce(fullPrices(pools));
    clickButton(/Повторить получение цен/);
    await waitFor(() => expect(backend.reportPlanGenerated).toHaveBeenCalledTimes(1));
    expect(backend.savePlanToHistory).toHaveBeenCalledTimes(1);
  });

  it("Pro: вырожденный слот 1, полноценный слот 2 — у слота 1 отметка сохраняется, его повтор засчитывается", async () => {
    vi.mocked(backend.checkPlanStatus).mockResolvedValue(PRO);
    const pools = catalogPools();
    vi.mocked(vkusvillRecipes.fetchVkusvillPools).mockResolvedValueOnce({ pools, priceByName: new Map() });
    render(<MealPlanner />);
    await passNewUserWizard();
    expect(pendingNote()).toBeTruthy();

    // Слот 2 — полноценный: засчитан сразу.
    clickButton(/Ещё план/);
    await passReturningUserWizard();
    expect(backend.reportPlanGenerated).toHaveBeenCalledTimes(1);
    expect(pendingNote()).toBeNull();

    // Назад к слоту 1: он всё ещё ждёт засчитывания.
    fireEvent.click(slotChips()[0]);
    await waitFor(() => expect(pendingNote()).toBeTruthy());
    vi.mocked(vkusvillRecipes.attachRealCosts).mockResolvedValueOnce(fullPrices(pools));
    clickButton(/Повторить получение цен/);
    await waitFor(() => expect(backend.reportPlanGenerated).toHaveBeenCalledTimes(2));
  });

  it("повтор цен закончился уже после переключения на другой слот — результат не применяется к чужому плану", async () => {
    vi.mocked(backend.checkPlanStatus).mockResolvedValue(PRO);
    const pools = catalogPools();
    render(<MealPlanner />);
    await passNewUserWizard(); // слот 1 — полноценный
    expect(backend.reportPlanGenerated).toHaveBeenCalledTimes(1);

    vi.mocked(vkusvillRecipes.fetchVkusvillPools).mockResolvedValueOnce({ pools, priceByName: new Map() });
    clickButton(/Ещё план/);
    await passReturningUserWizard(); // слот 2 — вырожденный
    expect(pendingNote()).toBeTruthy();

    let resolveRetry;
    vi.mocked(vkusvillRecipes.attachRealCosts).mockImplementationOnce(() => new Promise((r) => { resolveRetry = r; }));
    clickButton(/Повторить получение цен/);
    await waitFor(() => expect(resolveRetry).toBeTypeOf("function"));

    fireEvent.click(slotChips()[0]); // переключились на слот 1, пока повтор в полёте
    await waitFor(() => expect(pendingNote()).toBeNull());
    const totalOfSlot1 = () => screen.getByText(/Итого за продукты/).parentElement.textContent;
    const before = totalOfSlot1();
    // Цены устаревшего повтора заметно другие — если бы они легли в слот 1, его сумма бы изменилась.
    const stalePrices = new Map([...fullPrices(pools)].map(([name, info]) => [name, { ...info, price: info.price * 100 }]));
    resolveRetry(stalePrices);
    await new Promise((r) => setTimeout(r, 50));

    expect(totalOfSlot1()).toBe(before);
    expect(backend.reportPlanGenerated).toHaveBeenCalledTimes(1);
    // Слот 2 по-прежнему ждёт засчитывания: результат повтора к нему тоже не применился молча.
    fireEvent.click(slotChips()[1]);
    await waitFor(() => expect(pendingNote()).toBeTruthy());
  });
});

describe("MealPlanner: запросы статуса тарифа при запуске", () => {
  // Каждый /api/plan-status на сервере запускает сверку незавершённых платежей
  // с ЮKassa — при запуске он нужен ровно один, а не по запросу на каждый эффект.
  it("без сохранённого плана — один checkPlanStatus (и статус, и экран лимита из одного ответа)", async () => {
    vi.mocked(backend.checkPlanStatus).mockResolvedValue({ ok: true, isPro: false, canGenerate: false, usedThisWeek: 1, extraPlanCredits: 0, nextResetHint: "2026-10-17T10:00:00.000Z" });
    render(<MealPlanner />);
    expect(await screen.findByText("Бесплатный лимит на этой неделе исчерпан")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.checkPlanStatus).toHaveBeenCalledTimes(1);
  });

  it("с сохранённым планом — тоже один", async () => {
    const first = render(<MealPlanner />);
    await passNewUserWizard();
    first.unmount();
    vi.clearAllMocks();
    vi.mocked(backend.checkPlanStatus).mockResolvedValue({ ok: true, isPro: false, canGenerate: true, usedThisWeek: 1, extraPlanCredits: 0, nextResetHint: null });

    render(<MealPlanner />);
    await screen.findByText("Ваш план на неделю");
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.checkPlanStatus).toHaveBeenCalledTimes(1);
  });
});

describe("MealPlanner: нелюбимые продукты и вопрос «откуда узнали»", () => {
  it("выбранное на шаге аллергий уходит в сборку плана и сохраняется в профиль", async () => {
    render(<MealPlanner />);
    for (let i = 0; i < 5; i++) clickButton(/Далее/);
    clickButton(/Аллергий нет/);
    clickButton(/Есть продукты, которые не любите/);
    fireEvent.click(screen.getByText("Грибы"));
    fireEvent.change(screen.getByLabelText("Добавить нелюбимый продукт"), { target: { value: "Тыква" } });
    fireEvent.click(screen.getByLabelText("Добавить"));
    clickButton(/Собрать список/);
    await screen.findByText("Ваш план на неделю");

    expect(vkusvillRecipes.fetchVkusvillPools).toHaveBeenCalledWith(expect.objectContaining({ dislikes: ["mushrooms", "тыква"] }));
    expect(JSON.parse(localStorage.getItem("sedim.profile.v1")).dislikes).toEqual(["mushrooms", "тыква"]);
  });

  it("без выбора нелюбимого визард работает как раньше: блок свёрнут, dislikes пустой", async () => {
    render(<MealPlanner />);
    await passNewUserWizard();
    expect(vkusvillRecipes.fetchVkusvillPools).toHaveBeenCalledWith(expect.objectContaining({ dislikes: [] }));
  });

  it("новичок после первого плана видит вопрос «Откуда вы о нас узнали?», ответ скрывает его навсегда", async () => {
    const first = render(<MealPlanner />);
    await passNewUserWizard();
    expect(screen.getByText("Откуда вы о нас узнали?")).toBeTruthy();
    fireEvent.click(screen.getByText("От друзей или семьи"));
    expect(screen.queryByText("Откуда вы о нас узнали?")).toBeNull();
    expect(localStorage.getItem("sedim.acquisition.v1")).toBe("1");
    first.unmount();

    render(<MealPlanner />);
    await screen.findByText("Ваш план на неделю");
    expect(screen.queryByText("Откуда вы о нас узнали?")).toBeNull();
  });

  it("закрытие крестиком тоже считается «спросили» — не показываем снова", async () => {
    render(<MealPlanner />);
    await passNewUserWizard();
    fireEvent.click(screen.getByLabelText("Закрыть вопрос"));
    expect(screen.queryByText("Откуда вы о нас узнали?")).toBeNull();
    expect(localStorage.getItem("sedim.acquisition.v1")).toBe("1");
  });

  it("вернувшемуся пользователю (профиль уже сохранён) вопрос не показываем", async () => {
    localStorage.setItem("sedim.profile.v1", JSON.stringify({
      family: 2, meals: ["lunch", "dinner"], diet: "any", allergies: [], dislikes: [], cuisines: [], devices: ALL_DEVICE_IDS,
    }));
    render(<MealPlanner />);
    clickButton(/Далее/); // магазин -> бюджет
    clickButton(/Собрать список/);
    await screen.findByText("Ваш план на неделю");
    expect(screen.queryByText("Откуда вы о нас узнали?")).toBeNull();
  });
});

describe("MealPlanner: диеты по КБЖУ", () => {
  async function buildWithDiet(dietLabel) {
    render(<MealPlanner />);
    for (let i = 0; i < 4; i++) clickButton(/Далее/); // магазин → семья → приёмы пищи → бюджет
    clickButton(new RegExp(dietLabel));
    clickButton(/Далее/);
    clickButton(/Аллергий нет/);
    clickButton(/Собрать список/);
    await screen.findByText("Ваш план на неделю");
  }

  it("диета передаётся в сборку; если ни у одного блюда нет подходящего КБЖУ — честная заметка", async () => {
    await buildWithDiet("Высокобелковый");
    expect(vkusvillRecipes.fetchVkusvillPools).toHaveBeenCalledWith(expect.objectContaining({ diet: "protein" }));
    expect(screen.getByText(/Рецептов, подходящих под диету «Высокобелковый», не нашлось/)).toBeTruthy();
  });

  it("часть блюд подходит — заметка считает неподходящие", async () => {
    const pools = catalogPools();
    // Половине блюд пула даём КБЖУ под «лёгкое», остальным — нет
    for (const list of Object.values(pools)) list.forEach((r, i) => { r.nutritionPer100g = i % 2 === 0 ? { calories: 100, protein: 5, fat: 3, carbs: 10 } : null; });
    vi.mocked(vkusvillRecipes.fetchVkusvillPools).mockResolvedValue({ pools, priceByName: fullPrices(pools) });
    await buildWithDiet("Лёгкое");
    expect(screen.getByText(/блюд не подходят под диету «Лёгкое» по КБЖУ/)).toBeTruthy();
  });

  it("без диеты по КБЖУ заметки нет", async () => {
    render(<MealPlanner />);
    await passNewUserWizard();
    expect(screen.queryByText(/по КБЖУ/)).toBeNull();
  });
});
