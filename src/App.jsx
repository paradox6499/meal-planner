import { useState, useMemo, useEffect } from "react";
import { ShoppingBasket, Check, ChevronLeft, ChevronRight, Store, Users, Wallet, Salad, ChefHat, Flame, RotateCcw, UtensilsCrossed, Clock, Repeat, Ban, TriangleAlert, X, Loader2, Share2, Settings, Sun, Moon, MonitorSmartphone, Sparkles } from "lucide-react";
import {
  RECIPES,
  RECIPES_BY_ID,
  DEPARTMENTS,
  departmentOf,
  ALLERGENS,
  forbiddenIngredientsFor,
  recipeHasAllergen,
  effectiveRecipeCost,
} from "./data/recipes.js";
import { buildCartFromShoppingList } from "./lib/vkusvillMcp.js";
import { fetchVkusvillPools } from "./lib/vkusvillRecipes.js";
import { loadProfile, saveProfile, clearProfile, loadTheme, saveTheme } from "./lib/profile.js";

// ---------- UI-конфигурация (не контент рецептов — та живёт в data/recipes.js) ----------

const STORES = [
  { id: "vv", name: "ВкусВилл", note: "доставка от 30 мин" },
  { id: "px", name: "Перекрёсток", note: "доставка сегодня" },
  { id: "pt", name: "Пятёрочка", note: "самовывоз рядом" },
  { id: "mg", name: "Магнит", note: "доставка завтра" },
  { id: "az", name: "Азбука Вкуса", note: "доставка от 1 часа" },
];

const DIETS = [
  { id: "any", label: "Как обычно", hint: "без ограничений" },
  { id: "pp", label: "ПП", hint: "баланс белков/жиров/углеводов" },
  { id: "veg", label: "Вегетарианское", hint: "без мяса и рыбы" },
  { id: "vegan", label: "Веганское", hint: "без продуктов животного происхождения" },
  { id: "gf", label: "Без глютена", hint: "без пшеницы, ржи, ячменя" },
];

const CUISINES = [
  { id: "any", label: "Не важно" },
  { id: "ru", label: "Русская" },
  { id: "it", label: "Итальянская" },
  { id: "asia", label: "Азиатская" },
  { id: "cauc", label: "Кавказская" },
  { id: "med", label: "Средиземноморская" },
];

const DEVICES = [
  { id: "stove", label: "Плита" },
  { id: "oven", label: "Духовка" },
  { id: "micro", label: "Микроволновка" },
  { id: "multi", label: "Мультиварка" },
  { id: "air", label: "Аэрогриль" },
  { id: "grill", label: "Гриль" },
  { id: "blender", label: "Блендер" },
];

// какие приёмы пищи планируем закрывать рецептами
const MEALS = [
  { id: "breakfast", label: "Завтрак", category: "breakfast" },
  { id: "lunch", label: "Обед", category: "main" },
  { id: "dinner", label: "Ужин", category: "main" },
  { id: "snack", label: "Перекус", category: "snack" },
];

// Раньше шаги визарда были просто индексами 0..7 и STEP_LABELS — но теперь
// у вернувшегося пользователя с сохранённым профилем (см. lib/profile.js)
// часть шагов не нужна: семья/приёмы пищи/рацион/аллергии/кухня/техника
// меняются раз в несколько месяцев, спрашивать их заново при каждой сборке
// плана — лишнее трение. "store" и "budget" — единственное, что имеет смысл
// спрашивать каждую неделю. Ключи вместо голых индексов нужны, чтобы JSX
// шагов ниже не пересчитывать вручную при пропуске части шагов.
const STEP_META = [
  { key: "store", label: "Магазин" },
  { key: "family", label: "Семья" },
  { key: "meals", label: "Приёмы пищи" },
  { key: "budget", label: "Бюджет" },
  { key: "diet", label: "Рацион" },
  { key: "allergies", label: "Аллергии" },
  { key: "cuisine", label: "Кухня" },
  { key: "devices", label: "Техника" },
];
const QUICK_STEP_KEYS = ["store", "budget"];

// ---------- Plan building (чистые функции, без React-состояния) ----------

// пул подходящих рецептов на категорию: рацион/кухня/техника — мягкие предпочтения
// (при пустом пуле смягчаются), аллергии — жёсткое исключение (не смягчается никогда)
function buildPools(diet, cuisines, devices, allergies) {
  const cuisineFilter = cuisines.length === 0 || cuisines.includes("any");
  const forbidden = forbiddenIngredientsFor(allergies);

  const buildPool = (category) => {
    let pool = RECIPES.filter((r) => {
      if (r.category !== category) return false;
      if (recipeHasAllergen(r, forbidden)) return false;
      const dietOk = diet === "any" || r.diets.includes(diet);
      const cuisineOk = category !== "main" || cuisineFilter || r.cuisine === "any" || cuisines.includes(r.cuisine);
      const deviceOk = r.devices.length === 0 || r.devices.some((d) => devices.includes(d));
      return dietOk && cuisineOk && deviceOk;
    });
    if (pool.length === 0) {
      // смягчаем фильтр по кухне/технике, если совсем ничего не подошло, чтобы план
      // не был пустым — но аллергию НИКОГДА не смягчаем, это не предпочтение
      pool = RECIPES.filter(
        (r) =>
          r.category === category &&
          !recipeHasAllergen(r, forbidden) &&
          (diet === "any" || r.diets.includes(diet))
      );
    }
    return [...pool].sort((a, b) => a.cost - b.cost);
  };

  return { breakfast: buildPool("breakfast"), main: buildPool("main"), snack: buildPool("snack") };
}

// начальный план — только id рецептов, без сумм и списка покупок (их считаем отдельно,
// чтобы «Заменить блюдо» не пересобирало всю неделю заново)
//
// Раньше выбор блюда был просто round-robin по пулу (отсортированному по
// цене), без учёта budget вообще — за 7 дней цикл проходил и по самым
// дешёвым, и по самым дорогим рецептам поровну, поэтому итог почти не
// зависел от того, что выбрал пользователь на шаге "Бюджет". Теперь —
// жадный алгоритм: на каждый приём пищи считаем допустимую среднюю цену на
// оставшиеся приёмы (remainingBudget / remainingSlots) и берём САМЫЙ ДОРОГОЙ
// рецепт из пула, который в неё укладывается — так бюджет тратится
// осмысленно (не всегда самое дешёвое), но итог целится в заданную сумму, а
// не в среднюю по больнице. Если бюджет физически ниже, чем даже самые
// дешёвые рецепты в пуле, алгоритм просто берёт минимально возможное и даёт
// уйти в минус — дальше это видно пользователю по индикатору "превышен
// бюджет" в ResultView, а не скрывается.
function buildInitialPlan(pools, selectedMeals, budget, family) {
  const totalSlots = 7 * selectedMeals.length;
  let remainingBudget = family > 0 ? budget / family : budget; // считаем в цене на человека, family умножается позже в buildPlanView
  let remainingSlots = totalSlots;
  const recentByCategory = {}; // последние выбранные id на категорию — чтобы не повторять одно и то же блюдо подряд без нужды

  const pickRecipe = (category) => {
    const pool = pools[category];
    if (!pool || pool.length === 0) return null;
    const allowedAvg = remainingSlots > 0 ? remainingBudget / remainingSlots : Infinity;
    // pool отсортирован по возрастанию цены (buildPools/fetchVkusvillPools) —
    // ищем самый дорогой вариант, который всё ещё укладывается в допустимое
    // среднее на оставшиеся приёмы пищи
    let candidateIdx = 0;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].cost <= allowedAvg) candidateIdx = i;
      else break;
    }
    const recent = recentByCategory[category] || [];
    let chosen = pool[candidateIdx];
    if (candidateIdx > 0) {
      // из вариантов в рамках бюджета — предпочитаем не повторять последние 2 блюда подряд
      const notRecent = pool.slice(0, candidateIdx + 1).filter((r) => !recent.includes(r.id));
      if (notRecent.length > 0) chosen = notRecent[notRecent.length - 1];
    }
    recentByCategory[category] = [...recent, chosen.id].slice(-2);
    remainingBudget -= chosen.cost;
    remainingSlots -= 1;
    return chosen;
  };

  const days = [];
  const emptyMealLabels = new Set();
  for (let day = 1; day <= 7; day++) {
    const dayMeals = [];
    selectedMeals.forEach((m) => {
      const pool = pools[m.category];
      if (!pool || pool.length === 0) {
        emptyMealLabels.add(m.label);
        return;
      }
      const r = pickRecipe(m.category);
      dayMeals.push({ mealId: m.id, mealLabel: m.label, category: m.category, recipeId: r.id });
    });
    days.push({ day, dayMeals });
  }
  return { days, warnings: Array.from(emptyMealLabels) };
}

// разворачивает planState (id-шники) в полные объекты для отображения + считает
// итоговую сумму и сгруппированный список покупок
function buildPlanView(planState, pools, family) {
  if (!planState) return null;

  // Рецепт мог прийти либо из статического RECIPES_BY_ID, либо из живых
  // pools (VkusVill, id вида "vv-12345" — в статической карте их нет). Сам
  // buildInitialPlan берёт recipeId ИЗ pools, так что pools гарантированно
  // содержит нужный рецепт на момент вызова — просто ищем в правильном месте.
  const recipesById = new Map(RECIPES_BY_ID);
  Object.values(pools || {}).forEach((list) => list.forEach((r) => recipesById.set(r.id, r)));

  const ingredMap = {};
  let total = 0;

  let anyEstimated = false;

  const days = planState.days.map((d) => {
    const dayMeals = d.dayMeals.map((slot) => {
      const recipe = recipesById.get(slot.recipeId);
      const pool = pools[slot.category] || [];
      const [cost, isRealPrice] = effectiveRecipeCost(recipe);
      if (!isRealPrice) anyEstimated = true;
      total += cost * family;
      recipe.ingr.forEach(([name, amount, unit]) => {
        const key = `${name}|${unit}`;
        ingredMap[key] = (ingredMap[key] || 0) + amount * family;
      });
      return {
        mealId: slot.mealId,
        mealLabel: slot.mealLabel,
        category: slot.category,
        recipe,
        cost,
        isRealPrice,
        canSwap: pool.length > 1,
      };
    });
    return { day: d.day, dayMeals };
  });

  const shoppingList = Object.entries(ingredMap).map(([key, amount]) => {
    const [name, unit] = key.split("|");
    return { name, amount: Math.round(amount), unit, dept: departmentOf(name) };
  });
  const grouped = DEPARTMENTS.map((d) => ({
    name: d.name,
    items: shoppingList.filter((it) => it.dept === d.name),
  })).filter((g) => g.items.length > 0);
  const other = shoppingList.filter((it) => it.dept === "Разное");
  if (other.length > 0) grouped.push({ name: "Разное", items: other });

  return { days, total: Math.round(total), grouped, warnings: planState.warnings || [], anyEstimated };
}

// Telegram сам присылает имя пользователя при открытии Mini App — это
// бесплатно (initDataUnsafe), никакого своего логина/аккаунта заводить не
// нужно. Вне Telegram (например, в этом браузерном превью) window.Telegram
// просто не существует — приветствие тогда не показываем вообще, а не
// подставляем заглушку "Гость".
function getTelegramFirstName() {
  return window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name || null;
}

// ---------- Component ----------

export default function MealPlanner() {
  const [tgFirstName] = useState(getTelegramFirstName);

  // ready()/expand() — просим Telegram сразу развернуть Mini App на всю
  // доступную высоту, а не в свёрнутом состоянии по умолчанию. Без этого
  // сам Telegram может показывать приложение в неполный экран независимо
  // от нашего CSS — это его собственное поведение, не наш layout.
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.ready?.();
    tg.expand?.();
  }, []);

  // Сохранённый профиль читаем один раз при монтировании (не подписываемся
  // на изменения localStorage из других вкладок — это редкий кейс, не стоит
  // усложнять). Наличие профиля решает, показывать ли полный визард из 8
  // шагов или короткий (магазин + бюджет) — см. STEP_META/QUICK_STEP_KEYS.
  const [savedProfile] = useState(loadProfile);
  const hasProfile = !!savedProfile;

  const [step, setStep] = useState(0);
  const [store, setStore] = useState(null);
  const [family, setFamily] = useState(savedProfile?.family ?? 2);
  const [meals, setMeals] = useState(savedProfile?.meals ?? ["lunch", "dinner"]);
  const [budget, setBudget] = useState(4000);
  const [diet, setDiet] = useState(savedProfile?.diet ?? null);
  const [allergies, setAllergies] = useState(savedProfile?.allergies ?? []);
  const [cuisines, setCuisines] = useState(savedProfile?.cuisines ?? []);
  const [devices, setDevices] = useState(savedProfile?.devices ?? []);
  const [done, setDone] = useState(false);
  const [assembling, setAssembling] = useState(false);
  const [planState, setPlanState] = useState(null);
  const [openRecipe, setOpenRecipe] = useState(null);
  const [showAccount, setShowAccount] = useState(false);
  const [displayName, setDisplayName] = useState(savedProfile?.displayName ?? "");

  // "system" | "light" | "dark" — управляется вручную из Аккаунта, поверх
  // системной темы по умолчанию (см. data-theme в <style> ниже и useEffect,
  // который проставляет атрибут на <html>).
  const [theme, setTheme] = useState(loadTheme);
  useEffect(() => {
    saveTheme(theme);
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleSimple = (arr, setArr, id) => {
    setArr((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleCuisine = (arr, setArr, id) => {
    if (id === "any") return setArr(["any"]);
    setArr((prev) => {
      const withoutAny = prev.filter((x) => x !== "any");
      return withoutAny.includes(id) ? withoutAny.filter((x) => x !== id) : [...withoutAny, id];
    });
  };

  // У вернувшегося пользователя (есть сохранённый профиль) визард
  // схлопывается до "Магазин" + "Бюджет" — остальное уже известно и
  // редактируется через Аккаунт, а не проходится заново на каждую неделю.
  const activeSteps = useMemo(
    () => (hasProfile ? STEP_META.filter((s) => QUICK_STEP_KEYS.includes(s.key)) : STEP_META),
    [hasProfile]
  );
  const currentStepKey = activeSteps[step]?.key;

  const canNextByKey = {
    store: !!store,
    family: family > 0,
    meals: meals.length > 0,
    budget: budget >= 500,
    diet: !!diet,
    allergies: true, // необязательны — их отсутствие тоже осознанный ответ
    cuisine: true, // необязательна
    devices: devices.length > 0,
  };

  // Раньше пересчитывалось на каждое изменение фильтра (useMemo) — теперь
  // пулы для ВкусВилл тянутся живьём из MCP, это асинхронно, поэтому
  // считаются один раз, в момент "Собрать список" (handleFinish), а не
  // реактивно по ходу визарда. До первого нажатия — null, и это ок:
  // planView ниже явно проверяет planState на null раньше, чем тронуть pools.
  const [pools, setPools] = useState(null);

  // planState хранит только id рецептов по дням — так swapMeal меняет один слот,
  // не трогая остальную неделю и не требуя пересборки с нуля
  const planView = useMemo(() => buildPlanView(planState, pools, family), [planState, pools, family]);

  const handleFinish = async () => {
    const selectedMeals = MEALS.filter((m) => meals.includes(m.id));
    const neededCategories = [...new Set(selectedMeals.map((m) => m.category))];
    setAssembling(true);

    let resolvedPools;
    if (store === "vv") {
      // Реальные рецепты ВкусВилл — с реальными фото, шагами и (по
      // возможности) реальной ценой. Если MCP недоступен/упал — тихо
      // откатываемся на прежний статический список, а не роняем экран:
      // пользователь всё равно должен получить план, просто оценочный.
      try {
        resolvedPools = await fetchVkusvillPools({ diet, cuisines, devices, allergies, categories: neededCategories });
        const gotAnything = neededCategories.some((c) => (resolvedPools[c] || []).length > 0);
        if (!gotAnything) throw new Error("VkusVill не вернул рецептов под эти фильтры");
      } catch (err) {
        console.warn("VkusVill MCP недоступен, откат на статические рецепты:", err.message);
        resolvedPools = buildPools(diet, cuisines, devices, allergies);
      }
    } else {
      resolvedPools = buildPools(diet, cuisines, devices, allergies);
    }

    setPools(resolvedPools);
    setPlanState(buildInitialPlan(resolvedPools, selectedMeals, budget, family));
    setDone(true);
    setAssembling(false);
  };

  const swapMeal = (dayIndex, slotIndex) => {
    setPlanState((prev) => {
      if (!prev) return prev;
      const days = prev.days.map((d, i) => {
        if (i !== dayIndex) return d;
        const dayMeals = d.dayMeals.map((slot, j) => {
          if (j !== slotIndex) return slot;
          const pool = pools[slot.category] || [];
          if (pool.length <= 1) return slot;
          const curIdx = pool.findIndex((r) => r.id === slot.recipeId);
          const nextRecipe = pool[(curIdx + 1) % pool.length];
          return { ...slot, recipeId: nextRecipe.id };
        });
        return { ...d, dayMeals };
      });
      return { ...prev, days };
    });
  };

  // "Заново" — начать новый план. Если есть сохранённый профиль, семья/приёмы
  // пищи/рацион/аллергии/кухня/техника НЕ сбрасываются на дефолт — они и
  // так уже верные (в этом весь смысл профиля), сбрасывается только то, что
  // специфично для конкретной прошлой сборки: магазин, бюджет и сам план.
  const reset = () => {
    setStep(0); setStore(null); setBudget(4000); setDone(false); setPlanState(null);
    setOpenRecipe(null); setAssembling(false); setPools(null);
    if (!hasProfile) {
      setFamily(2); setMeals(["lunch", "dinner"]); setDiet(null);
      setAllergies([]); setCuisines([]); setDevices([]);
    }
  };

  const handleSaveProfile = () => {
    saveProfile({ family, meals, diet, allergies, cuisines, devices, displayName });
  };
  const handleClearProfile = () => {
    clearProfile();
    // после сброса про профиль приложение узнает заново только при перезагрузке
    // (hasProfile вычислен один раз при монтировании) — это ок, простое и
    // предсказуемое поведение, не тянет за собой сложную ре-синхронизацию стейта
    window.location.reload();
  };

  return (
    <div style={styles.page} className="mp-page">
      <style>{`
        :root {
          --page-bg: radial-gradient(circle at 12% 15%, #dcebff 0%, transparent 42%), radial-gradient(circle at 88% 12%, #ffe1f0 0%, transparent 40%), radial-gradient(circle at 50% 95%, #dcfce4 0%, transparent 45%), #eef1f5;
          --glass-rgb: 255,255,255;
          --text-primary: #1c1c1e;
          --text-secondary: #6e6e73;
          --text-tertiary: #8e8e93;
          --accent: #0A84FF;
          --accent-2: #64D2FF;
          --danger: #FF3B30;
          --danger-soft: rgba(255,59,48,0.14);
          --warning-soft: rgba(255,159,10,0.14);
          --warning-border: rgba(255,159,10,0.35);
          --warning-text: #8a5a1e;
          --hairline: rgba(0,0,0,0.06);
          --hairline-2: rgba(0,0,0,0.05);
          --card-shadow: 0 24px 60px rgba(20,20,30,0.12), inset 0 1px 0 rgba(255,255,255,0.6);
          --modal-backdrop: rgba(20,20,30,0.4);
          --modal-shadow: 0 30px 80px rgba(0,0,0,0.35);
          --skeleton-base: rgba(120,120,128,0.12);
          --skeleton-shine: rgba(120,120,128,0.24);
          --track-bg: rgba(60,60,67,0.15);
        }
        /* Раньше тема была только автоматической (prefers-color-scheme), без
           ручного переключателя. Теперь в Аккаунте можно явно выбрать
           светлую/тёмную — :not([data-theme="light"]) в media-блоке не даёт
           системной тёмной теме перебить явный выбор "светлая", а отдельный
           :root[data-theme="dark"] ниже включает тёмную тему явно даже если
           система светлая. */
        @media (prefers-color-scheme: dark) {
          :root:not([data-theme="light"]) {
            --page-bg: radial-gradient(circle at 12% 15%, rgba(10,70,130,0.4) 0%, transparent 42%), radial-gradient(circle at 88% 12%, rgba(140,20,80,0.32) 0%, transparent 40%), radial-gradient(circle at 50% 95%, rgba(20,100,55,0.32) 0%, transparent 45%), #0b0b0d;
            --glass-rgb: 42,42,46;
            --text-primary: #f2f2f7;
            --text-secondary: #b6b6bb;
            --text-tertiary: #8e8e93;
            --hairline: rgba(255,255,255,0.1);
            --hairline-2: rgba(255,255,255,0.08);
            --card-shadow: 0 24px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);
            --modal-backdrop: rgba(0,0,0,0.6);
            --modal-shadow: 0 30px 80px rgba(0,0,0,0.6);
            --skeleton-base: rgba(255,255,255,0.08);
            --skeleton-shine: rgba(255,255,255,0.16);
            --track-bg: rgba(255,255,255,0.14);
          }
        }
        :root[data-theme="dark"] {
          --page-bg: radial-gradient(circle at 12% 15%, rgba(10,70,130,0.4) 0%, transparent 42%), radial-gradient(circle at 88% 12%, rgba(140,20,80,0.32) 0%, transparent 40%), radial-gradient(circle at 50% 95%, rgba(20,100,55,0.32) 0%, transparent 45%), #0b0b0d;
          --glass-rgb: 42,42,46;
          --text-primary: #f2f2f7;
          --text-secondary: #b6b6bb;
          --text-tertiary: #8e8e93;
          --hairline: rgba(255,255,255,0.1);
          --hairline-2: rgba(255,255,255,0.08);
          --card-shadow: 0 24px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);
          --modal-backdrop: rgba(0,0,0,0.6);
          --modal-shadow: 0 30px 80px rgba(0,0,0,0.6);
          --skeleton-base: rgba(255,255,255,0.08);
          --skeleton-shine: rgba(255,255,255,0.16);
          --track-bg: rgba(255,255,255,0.14);
        }
        * { box-sizing: border-box; }
        .chip { transition: background-color .15s ease, border-color .15s ease, transform .18s cubic-bezier(0.34, 1.56, 0.64, 1); -webkit-tap-highlight-color: transparent; }
        .chip:hover { filter: brightness(1.03); }
        .chip:active { transform: scale(0.97); }
        button { font-family: inherit; }
        .recipe-row-btn:hover .recipe-name-text { text-decoration: underline; text-decoration-color: rgba(10,132,255,0.4); }
        .fade-in-up { animation: fadeInUp .32s cubic-bezier(0.22, 1, 0.36, 1) both; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .greeting-fade { animation: greetingFade 3s ease forwards; }
        @keyframes greetingFade { 0%, 80% { opacity: 1; } 100% { opacity: 0; } }
        .modal-overlay-in { animation: overlayIn .2s ease both; }
        @keyframes overlayIn { from { opacity: 0; } to { opacity: 1; } }
        .modal-card-in { animation: modalIn .28s cubic-bezier(0.22, 1, 0.36, 1) both; }
        @keyframes modalIn { from { opacity: 0; transform: scale(0.94) translateY(12px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        .skeleton-bar { border-radius: 12px; background: linear-gradient(90deg, var(--skeleton-base) 25%, var(--skeleton-shine) 37%, var(--skeleton-base) 63%); background-size: 400% 100%; animation: shimmer 1.4s ease infinite; }
        @keyframes shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        /* На узких экранах (телефон, в т.ч. внутри Telegram Mini App) — не
           плавающая карточка на фоне с большими полями, а карточка во весь
           экран, как у нативных приложений. 100dvh, а не 100vh — динамическая
           высота viewport'а, корректно учитывает шторки/безопасные зоны
           мобильных браузеров и WebView Telegram (обычный 100vh там часто
           врёт, оставляя пустое место снизу — это была жалоба). */
        @media (max-width: 600px) {
          .mp-page { padding: 0 !important; align-items: stretch !important; }
          .mp-card {
            max-width: 100% !important; min-height: 100dvh !important; border-radius: 0 !important;
            border-left: none !important; border-right: none !important;
            /* Раньше карточка была растянута на 100dvh, но её содержимое —
               обычный блочный поток, поэтому короткие шаги (например выбор
               магазина) оставляли пустую область снизу до конца экрана —
               визуально выглядело как "не заполнено", хотя карточка технически
               была на всю высоту. Теперь сама карточка — flex-колонка, а
               тело шага (.mp-step-body) занимает всё оставшееся место и
               центрирует контент по вертикали, как в нативных онбордингах. */
            display: flex !important; flex-direction: column !important;
          }
          /* Раньше здесь стоял justify-content:center — контент шага и кнопка
             центрировались как единая группа, но из-за этого между строкой
             "Шаг X из Y" и самим шагом появлялся заметный пустой отступ
             сверху (жалоба). Контенту лучше идти сразу за прогресс-баром —
             flex-start (по умолчанию), а не искать симметрию. Оставшееся
             свободное место (flex:1 на body) само уходит вниз, ПОСЛЕ кнопки —
             это просто безопасный отступ у нижнего края экрана, а не дыра
             посреди интерфейса. */
          .mp-step-body { flex: 1; }
          /* navRow держит marginTop:auto для "плавающей" карточки на десктопе
             (там это нужно, чтобы кнопка не отрывалась от контента при
             разной длине шагов) — но на mobile это же auto съедало ВСЁ
             свободное место сам по себе, из-за чего кнопка уезжала в самый
             низ, а контент оставался прижат к верху с разрывом посередине.
             Обычный фиксированный отступ вместо auto — кнопка идёт сразу за
             контентом шага. */
          .mp-nav-row { margin-top: 22px !important; }
          .mp-result-body, .mp-skeleton-body, .mp-account-body { flex: 1; }
        }
        input[type="range"] { -webkit-appearance: none; height: 4px; border-radius: 2px; background: var(--track-bg); }
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.04); cursor: pointer; }
      `}</style>

      <div style={styles.card} className="mp-card">
        <div style={styles.header}>
          <div>
            <div style={styles.brandRow}>
              <ShoppingBasket size={22} color={ACCENT} strokeWidth={1.75} />
              <span style={styles.brand}>Список на неделю</span>
            </div>
            {(displayName || tgFirstName) && (
              <div style={styles.greeting} className="greeting-fade">Привет, {displayName || tgFirstName} 👋</div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {done && !showAccount && (
              <button onClick={reset} style={styles.resetBtn}>
                <RotateCcw size={14} /> заново
              </button>
            )}
            <button
              onClick={() => setShowAccount((v) => !v)}
              style={styles.accountBtn}
              title={showAccount ? "Закрыть аккаунт" : "Аккаунт"}
            >
              <Settings size={16} />
            </button>
          </div>
        </div>

        {showAccount && (
          <AccountView
            displayName={displayName} setDisplayName={setDisplayName}
            theme={theme} setTheme={setTheme}
            family={family} setFamily={setFamily}
            meals={meals} setMeals={setMeals}
            diet={diet} setDiet={setDiet}
            allergies={allergies} setAllergies={setAllergies}
            cuisines={cuisines} setCuisines={setCuisines}
            devices={devices} setDevices={setDevices}
            toggleSimple={toggleSimple} toggleCuisine={toggleCuisine}
            hasProfile={hasProfile}
            onSave={handleSaveProfile}
            onClear={handleClearProfile}
            onClose={() => setShowAccount(false)}
          />
        )}

        {!showAccount && !done && !assembling && (
          <div style={styles.progressWrap}>
            <div style={styles.progressTrack}>
              <div style={{ ...styles.progressFill, width: `${((step + 1) / activeSteps.length) * 100}%` }} />
            </div>
            <div style={styles.progressLabel}>
              Шаг {step + 1} из {activeSteps.length} · {activeSteps[step]?.label}
            </div>
          </div>
        )}

        {!showAccount && assembling && <SkeletonView />}

        {!showAccount && !done && !assembling && (
          <div style={styles.stepBody} className="mp-step-body">
            {currentStepKey === "store" && (
              <StepShell icon={<Store size={20} />} title="Где вам удобно заказывать?" sub="Выберите магазин с доставкой в вашем районе">
                <div style={styles.grid2}>
                  {STORES.map((s) => (
                    <button key={s.id} className="chip" onClick={() => setStore(s.id)} style={styles.storeChip(store === s.id)}>
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      <div style={styles.chipHint}>
                        {s.note}
                        {s.id !== "vv" && " · скоро"}
                      </div>
                    </button>
                  ))}
                </div>
              </StepShell>
            )}

            {currentStepKey === "family" && (
              <StepShell icon={<Users size={20} />} title="Сколько человек в семье?" sub="Это определит объём продуктов и порции">
                <div style={styles.counterRow}>
                  <button style={styles.counterBtn} onClick={() => setFamily((f) => Math.max(1, f - 1))}>−</button>
                  <div style={styles.counterVal}>{family}</div>
                  <button style={styles.counterBtn} onClick={() => setFamily((f) => Math.min(8, f + 1))}>+</button>
                </div>
                <div style={styles.counterCaption}>{family === 1 ? "человек" : family < 5 ? "человека" : "человек"}</div>
              </StepShell>
            )}

            {currentStepKey === "meals" && (
              <StepShell icon={<UtensilsCrossed size={20} />} title="Какие приёмы пищи планируем?" sub="Например, если вы обедаете на работе — уберите обед, и список будет только с завтраками и ужинами">
                <div style={styles.stack}>
                  {MEALS.map((m) => (
                    <button key={m.id} className="chip" onClick={() => toggleSimple(meals, setMeals, m.id)} style={styles.rowChip(meals.includes(m.id))}>
                      <div style={{ fontWeight: 600 }}>{m.label}</div>
                      {meals.includes(m.id) && <Check size={16} color={ACCENT} />}
                    </button>
                  ))}
                </div>
              </StepShell>
            )}

            {currentStepKey === "budget" && (
              <StepShell icon={<Wallet size={20} />} title="Бюджет на неделю" sub={`Сколько готовы потратить на продукты на ${meals.length || 0} ${meals.length === 1 ? "приём пищи в день" : "приёма/приёмов пищи в день"}`}>
                <div style={styles.budgetVal}>{budget.toLocaleString("ru-RU")} ₽</div>
                <input type="range" min={1500} max={15000} step={250} value={budget} onChange={(e) => setBudget(Number(e.target.value))} style={styles.slider} />
                <div style={styles.sliderLabels}><span>1 500 ₽</span><span>15 000 ₽</span></div>
              </StepShell>
            )}

            {currentStepKey === "diet" && (
              <StepShell icon={<Salad size={20} />} title="Какой рацион вам нужен?" sub="Мы подберём рецепты под ваши предпочтения">
                <div style={styles.stack}>
                  {DIETS.map((d) => (
                    <button key={d.id} className="chip" onClick={() => setDiet(d.id)} style={styles.rowChip(diet === d.id)}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{d.label}</div>
                        <div style={styles.chipHint}>{d.hint}</div>
                      </div>
                      {diet === d.id && <Check size={16} color={ACCENT} />}
                    </button>
                  ))}
                </div>
              </StepShell>
            )}

            {currentStepKey === "allergies" && (
              <StepShell icon={<Ban size={20} />} title="Есть аллергии или непереносимости?" sub="Это не предпочтение, а жёсткое ограничение — такие рецепты исключаются полностью, без компромиссов.">
                <div style={styles.grid2}>
                  <button
                    className="chip"
                    onClick={() => setAllergies([])}
                    style={styles.storeChip(allergies.length === 0)}
                  >
                    <div style={{ fontWeight: 600 }}>Нет, ем всё подряд</div>
                  </button>
                  {ALLERGENS.map((a) => (
                    <button key={a.id} className="chip" onClick={() => toggleSimple(allergies, setAllergies, a.id)} style={styles.storeChip(allergies.includes(a.id))}>
                      <div style={{ fontWeight: 600 }}>{a.label}</div>
                    </button>
                  ))}
                </div>
              </StepShell>
            )}

            {currentStepKey === "cuisine" && (
              <StepShell icon={<ChefHat size={20} />} title="Кухня" sub="Необязательно — можно выбрать несколько или пропустить">
                <div style={styles.grid2}>
                  {CUISINES.map((c) => (
                    <button key={c.id} className="chip" onClick={() => toggleCuisine(cuisines, setCuisines, c.id)} style={styles.storeChip(cuisines.includes(c.id) || (c.id === "any" && cuisines.length === 0))}>
                      <div style={{ fontWeight: 600 }}>{c.label}</div>
                    </button>
                  ))}
                </div>
              </StepShell>
            )}

            {currentStepKey === "devices" && (
              <StepShell icon={<Flame size={20} />} title="На чём будете готовить?" sub="Выберите доступную технику — рецепты подстроятся под неё">
                <div style={styles.grid2}>
                  {DEVICES.map((d) => (
                    <button key={d.id} className="chip" onClick={() => toggleSimple(devices, setDevices, d.id)} style={styles.storeChip(devices.includes(d.id))}>
                      <div style={{ fontWeight: 600 }}>{d.label}</div>
                    </button>
                  ))}
                </div>
              </StepShell>
            )}

            <div style={styles.navRow} className="mp-nav-row">
              <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} style={{ ...styles.navBtn, visibility: step === 0 ? "hidden" : "visible" }}>
                <ChevronLeft size={16} /> назад
              </button>
              <button
                onClick={() => (step === activeSteps.length - 1 ? handleFinish() : setStep((s) => s + 1))}
                disabled={!canNextByKey[currentStepKey]}
                style={{ ...styles.navBtnPrimary, opacity: canNextByKey[currentStepKey] ? 1 : 0.4 }}
              >
                {step === activeSteps.length - 1 ? "Собрать список" : "Далее"} <ChevronRight size={16} />
              </button>
            </div>
            {hasProfile && (
              <p style={styles.quickHint}>
                Семья, приёмы пищи, рацион и остальное — из вашего профиля. Изменить — в{" "}
                <button onClick={() => setShowAccount(true)} style={styles.inlineLinkBtn}>Аккаунте</button>.
              </p>
            )}
          </div>
        )}

        {!showAccount && done && planView && (
          <ResultView
            plan={planView}
            storeId={store}
            storeName={STORES.find((s) => s.id === store)?.name}
            budget={budget}
            family={family}
            mealsCount={meals.length}
            onSwap={swapMeal}
            onOpenRecipe={setOpenRecipe}
          />
        )}
      </div>

      {openRecipe && (
        <RecipeModal dm={openRecipe} family={family} onClose={() => setOpenRecipe(null)} />
      )}
    </div>
  );
}

function StepShell({ icon, title, sub, children }) {
  return (
    <div className="fade-in-up">
      <div style={styles.stepIcon}>{icon}</div>
      <h2 style={styles.stepTitle}>{title}</h2>
      <p style={styles.stepSub}>{sub}</p>
      {children}
    </div>
  );
}

function SkeletonView() {
  return (
    <div style={styles.stepBody} className="fade-in-up mp-skeleton-body">
      <div style={styles.assemblingCaption}>
        <Loader2 size={15} className="spin" />
        Собираем план и список покупок…
      </div>
      <div className="skeleton-bar" style={styles.skeletonBar(24, "65%")} />
      <div className="skeleton-bar" style={styles.skeletonBar(74)} />
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <div className="skeleton-bar" style={styles.skeletonBar(11, "25%")} />
          <div className="skeleton-bar" style={styles.skeletonBar(38)} />
          <div className="skeleton-bar" style={styles.skeletonBar(38)} />
        </div>
      ))}
    </div>
  );
}

const THEME_OPTIONS = [
  { id: "system", label: "Системная", icon: MonitorSmartphone },
  { id: "light", label: "Светлая", icon: Sun },
  { id: "dark", label: "Тёмная", icon: Moon },
];

// Вкладка "Аккаунт" — открывается поверх визарда/результата (не отдельный
// роут, это одностраничное приложение без роутера). Тут живёт всё, что
// пользователь настраивает один раз и не хочет проходить заново на каждую
// сборку плана: профиль (семья/приёмы пищи/рацион/аллергии/кухня/техника),
// имя для приветствия и тема. Плюс место под подписку — см. комментарий
// у AccountSubscriptionCard ниже про то, почему кнопка пока не платит.
function AccountView({
  displayName, setDisplayName, theme, setTheme,
  family, setFamily, meals, setMeals, diet, setDiet,
  allergies, setAllergies, cuisines, setCuisines, devices, setDevices,
  toggleSimple, toggleCuisine, hasProfile, onSave, onClear, onClose,
}) {
  const [saved, setSaved] = useState(false);
  const handleSave = () => {
    onSave();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="fade-in-up mp-account-body" style={styles.stepBody}>
      <div style={styles.accountHeaderRow}>
        <button onClick={onClose} style={styles.navBtn}>
          <ChevronLeft size={16} /> назад
        </button>
      </div>
      <h2 style={{ ...styles.stepTitle, marginTop: 4 }}>Аккаунт</h2>

      <div style={styles.acctSection}>
        <div style={styles.acctLabel}>Как к вам обращаться</div>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Имя для приветствия"
          style={styles.textInput}
        />
      </div>

      <div style={styles.acctSection}>
        <div style={styles.acctLabel}>Тема</div>
        <div style={{ display: "flex", gap: 8 }}>
          {THEME_OPTIONS.map(({ id, label, icon: Icon }) => (
            <button key={id} className="chip" onClick={() => setTheme(id)} style={styles.themeChip(theme === id)}>
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={styles.acctDivider} />

      <div style={styles.acctSection}>
        <div style={styles.acctSectionTitle}>Профиль для плана</div>
        <p style={styles.acctSectionHint}>
          Эти настройки редко меняются, поэтому сохраняются один раз — при следующей сборке плана визард спросит только магазин и бюджет.
        </p>

        <div style={styles.acctLabel}>Семья</div>
        <div style={styles.counterRow}>
          <button style={styles.counterBtn} onClick={() => setFamily((f) => Math.max(1, f - 1))}>−</button>
          <div style={styles.counterVal}>{family}</div>
          <button style={styles.counterBtn} onClick={() => setFamily((f) => Math.min(8, f + 1))}>+</button>
        </div>

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Приёмы пищи</div>
        <div style={styles.stack}>
          {MEALS.map((m) => (
            <button key={m.id} className="chip" onClick={() => toggleSimple(meals, setMeals, m.id)} style={styles.rowChip(meals.includes(m.id))}>
              <div style={{ fontWeight: 600 }}>{m.label}</div>
              {meals.includes(m.id) && <Check size={16} color={ACCENT} />}
            </button>
          ))}
        </div>

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Рацион</div>
        <div style={styles.stack}>
          {DIETS.map((d) => (
            <button key={d.id} className="chip" onClick={() => setDiet(d.id)} style={styles.rowChip(diet === d.id)}>
              <div style={{ fontWeight: 600 }}>{d.label}</div>
              {diet === d.id && <Check size={16} color={ACCENT} />}
            </button>
          ))}
        </div>

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Аллергии</div>
        <div style={styles.grid2}>
          <button className="chip" onClick={() => setAllergies([])} style={styles.storeChip(allergies.length === 0)}>
            <div style={{ fontWeight: 600 }}>Нет</div>
          </button>
          {ALLERGENS.map((a) => (
            <button key={a.id} className="chip" onClick={() => toggleSimple(allergies, setAllergies, a.id)} style={styles.storeChip(allergies.includes(a.id))}>
              <div style={{ fontWeight: 600 }}>{a.label}</div>
            </button>
          ))}
        </div>

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Кухня</div>
        <div style={styles.grid2}>
          {CUISINES.map((c) => (
            <button key={c.id} className="chip" onClick={() => toggleCuisine(cuisines, setCuisines, c.id)} style={styles.storeChip(cuisines.includes(c.id) || (c.id === "any" && cuisines.length === 0))}>
              <div style={{ fontWeight: 600 }}>{c.label}</div>
            </button>
          ))}
        </div>

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Техника</div>
        <div style={styles.grid2}>
          {DEVICES.map((d) => (
            <button key={d.id} className="chip" onClick={() => toggleSimple(devices, setDevices, d.id)} style={styles.storeChip(devices.includes(d.id))}>
              <div style={{ fontWeight: 600 }}>{d.label}</div>
            </button>
          ))}
        </div>

        <button onClick={handleSave} style={{ ...styles.navBtnPrimary, width: "100%", justifyContent: "center", marginTop: 18 }}>
          {saved ? <><Check size={16} /> Сохранено</> : "Сохранить как профиль"}
        </button>
        {hasProfile && (
          <button onClick={onClear} style={styles.acctClearBtn}>
            Сбросить сохранённый профиль
          </button>
        )}
      </div>

      <div style={styles.acctDivider} />
      <AccountSubscriptionCard />
    </div>
  );
}

// Реальной оплаты тут пока нет — ни один платёжный провайдер (Stars,
// ЮKassa) не подключён, кнопка ничего не списывает. Это осознанно: платить
// за то, чего нет, — обман пользователя. Как только появится бэкенд с
// вебхуком от платёжного провайдера (см. docs/telegram-bot-architecture.md),
// кнопка ниже превратится в реальный openLink на страницу оплаты.
function AccountSubscriptionCard() {
  return (
    <div style={styles.acctSection}>
      <div style={styles.subCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Sparkles size={16} color={ACCENT} />
          <span style={{ fontWeight: 700, fontSize: 15 }}>Подписка</span>
          <span style={styles.freeBadge}>Free</span>
        </div>
        <p style={styles.acctSectionHint}>
          Сейчас доступно всё, включая реальный заказ в ВкусВилл. Позже премиум откроет: безлимитную пересборку плана,
          несколько планов одновременно, напоминания от бота и общий список на семью.
        </p>
        <button disabled style={{ ...styles.orderBtn, opacity: 0.4, cursor: "default", marginTop: 4 }}>
          Скоро
        </button>
      </div>
    </div>
  );
}

function ResultView({ plan, storeId, storeName, budget, family, mealsCount, onSwap, onOpenRecipe }) {
  const over = plan.total > budget;
  const [orderState, setOrderState] = useState({ status: "idle" }); // idle | loading | error

  // Реальный заказ пока подключён только для ВкусВилл — у них единственных
  // есть официальный MCP с генерацией ссылки на корзину (см.
  // src/lib/vkusvillMcp.js). У остальных сетей такого нет, кнопка для них
  // остаётся неактивной — не потому что забыли, а потому что нечем её
  // подкрепить по-настоящему.
  const canOrderForReal = storeId === "vv";

  const handleOrder = async () => {
    setOrderState({ status: "loading" });
    try {
      const items = plan.grouped.flatMap((g) => g.items);
      const { link, matchedCount, totalCount, unmatched } = await buildCartFromShoppingList(items);
      window.open(link, "_blank", "noopener,noreferrer");
      // Раньше при неполном совпадении это уходило только в console.warn —
      // пользователь открывал корзину и молча недосчитывался части товаров,
      // не понимая почему. ВкусВилл вдобавок принимает максимум 20 позиций
      // за раз (см. vkusvillMcp.js) — при длинном списке это тоже причина
      // расхождения, а не только "не нашли в каталоге". Показываем сразу обе.
      const note =
        matchedCount < totalCount
          ? `В корзину добавлено ${matchedCount} из ${totalCount} товаров.` +
            (totalCount > 20 ? " ВкусВилл принимает максимум 20 позиций за раз — часть пришлось докупить отдельно." : " Часть не нашлась в каталоге — докупите её отдельно.")
          : null;
      setOrderState({ status: "idle", note });
      if (unmatched.length > 0) console.warn("Не нашли в каталоге ВкусВилл:", unmatched);
    } catch (err) {
      setOrderState({ status: "error", message: err.message });
    }
  };

  return (
    <div style={styles.stepBody} className="fade-in-up mp-result-body">
      <div style={styles.resultHeader}>
        <h2 style={styles.stepTitle}>Ваш план на неделю</h2>
        <p style={styles.stepSub}>{mealsCount} приёма/приёмов пищи в день · {storeName} · на {family} {family === 1 ? "человека" : "человек"}</p>
      </div>

      {plan.warnings.length > 0 && (
        <div style={styles.warningBox}>
          <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            Под ваши аллергии/рацион не нашлось рецептов для: {plan.warnings.join(", ")}.
            Эти приёмы пищи пропущены в плане — уберите часть ограничений, если это важно.
          </span>
        </div>
      )}

      <div style={{ ...styles.totalBox, borderColor: over ? "rgba(255,59,48,0.35)" : "rgba(10,132,255,0.3)" }}>
        <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Итого за продукты</span>
        <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.01em", color: over ? DANGER : ACCENT }}>
          {plan.total.toLocaleString("ru-RU")} ₽
        </span>
        <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>из {budget.toLocaleString("ru-RU")} ₽ бюджета</span>
        {plan.anyEstimated && (
          <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
            Часть цен — оценочные, без данных из магазина
          </span>
        )}
      </div>

      <h3 style={styles.sectionTitle}>Рецепты на неделю</h3>
      <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "-4px 0 10px 0" }}>
        Нажмите на блюдо, чтобы посмотреть рецепт
      </p>
      <div style={styles.stack}>
        {plan.days.map(({ day, dayMeals }, dayIndex) => (
          <div key={day} style={styles.dayBlock}>
            <div style={styles.dayTag}>День {day}</div>
            {dayMeals.map((dm, i) => (
              <div key={i} style={styles.recipeRow}>
                <span style={{ width: 68, flexShrink: 0, fontSize: 12, color: "var(--text-tertiary)" }}>{dm.mealLabel}</span>
                <button onClick={() => onOpenRecipe(dm)} title="Открыть рецепт" className="recipe-row-btn" style={styles.recipeRowBtn}>
                  <span style={styles.recipeEmoji}>{dm.recipe.emoji}</span>
                  <span className="recipe-name-text" style={{ fontWeight: 500 }}>{dm.recipe.name}</span>
                  <ChevronRight size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                </button>
                <span style={styles.timeBadge}>
                  <Clock size={11} /> {dm.recipe.time} мин
                </span>
                <span style={{ color: "var(--text-tertiary)", fontSize: 13, flexShrink: 0 }}>{(dm.cost * family).toLocaleString("ru-RU")} ₽</span>
                <button
                  onClick={() => onSwap(dayIndex, i)}
                  disabled={!dm.canSwap}
                  title={dm.canSwap ? "Заменить блюдо" : "Нет других вариантов под ваши фильтры"}
                  style={styles.swapBtn(dm.canSwap)}
                >
                  <Repeat size={14} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <h3 style={styles.sectionTitle}>Список покупок</h3>
      {plan.grouped.map((g) => (
        <div key={g.name} style={{ marginBottom: 14 }}>
          <div style={styles.deptLabel}>{g.name}</div>
          <div style={styles.listBox}>
            {g.items.map((it) => (
              <div key={it.name} style={styles.listRow}>
                <span>{it.name}</span>
                <span style={{ color: "var(--text-tertiary)" }}>{it.amount} {it.unit}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <button onClick={() => shareViaTelegram(buildShareText(plan, storeName, family), BOT_SHARE_URL)} style={styles.shareBtn}>
        <Share2 size={16} /> Поделиться
      </button>
      {canOrderForReal ? (
        <>
          <button onClick={handleOrder} disabled={orderState.status === "loading"} style={{ ...styles.orderBtn, opacity: orderState.status === "loading" ? 0.6 : 1 }}>
            {orderState.status === "loading" ? "Собираем корзину…" : `Заказать в ${storeName}`}
          </button>
          {orderState.status === "error" && (
            <p style={styles.orderError}>Не получилось собрать корзину: {orderState.message}. Попробуйте ещё раз.</p>
          )}
          {orderState.status === "idle" && orderState.note && (
            <p style={styles.orderNote}>{orderState.note}</p>
          )}
        </>
      ) : (
        <button disabled style={{ ...styles.orderBtn, opacity: 0.4, cursor: "default" }} title="Реальный заказ пока подключён только для ВкусВилл">
          Заказать в {storeName} (скоро)
        </button>
      )}
    </div>
  );
}

// Пока бот не заведён через @BotFather — здесь null, и в пересланное
// сообщение не добавляется ссылка (иначе была бы нерабочей — хуже, чем без
// неё). Появится юзернейм бота — вписать сюда, шеринг сразу начнёт вести
// новых людей в приложение, ничего больше менять не нужно. Дальше, когда
// план будет сохраняться на сервере (см. docs/telegram-bot-architecture.md),
// это должно стать функцией вида `t.me/<bot>/<app>?startapp=plan_${plan.id}` —
// тогда получатель попадает не просто в бота, а сразу в ЭТОТ план.
const BOT_SHARE_URL = "https://t.me/s_edim_bot";

// Формирует читаемый текст плана для пересылки в Telegram-чат — например,
// семейный: "вот что мы едим на этой неделе, как тебе?"
function buildShareText(plan, storeName, family) {
  const lines = [
    `🛒 Наш план на неделю — ${storeName}, на ${family} ${family === 1 ? "человека" : "человек"}`,
    `Итого: ${plan.total.toLocaleString("ru-RU")} ₽`,
    "",
  ];
  plan.days.forEach(({ day, dayMeals }) => {
    lines.push(`День ${day}:`);
    dayMeals.forEach((dm) => lines.push(`  ${dm.mealLabel}: ${dm.recipe.emoji} ${dm.recipe.name}`));
  });
  lines.push("", "Как вам? 🙂");
  return lines.join("\n");
}

// Универсальная ссылка t.me/share/url — работает и внутри Mini App, и как
// обычная веб-ссылка: открывает штатный диалог Telegram "переслать в чат".
// `url` (если задан через BOT_SHARE_URL) даёт кликабельную карточку-превью
// поверх текста — это и есть тот самый "рост узнаваемости через шеринг".
function shareViaTelegram(text, url) {
  const params = new URLSearchParams({ text });
  if (url) params.set("url", url);
  window.open(`https://t.me/share/url?${params}`, "_blank", "noopener,noreferrer");
}

function RecipeModal({ dm, family, onClose }) {
  const { recipe, cost, isRealPrice } = dm;
  return (
    <div style={styles.modalOverlay} className="modal-overlay-in" onClick={onClose}>
      <div style={styles.modalCard} className="modal-card-in" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} title="Закрыть" style={styles.modalClose}>
          <X size={16} />
        </button>

        {recipe.photoUrl ? (
          <img src={recipe.photoUrl} alt={recipe.name} style={styles.modalHeroPhoto} />
        ) : (
          <div style={styles.modalHero}>{recipe.emoji}</div>
        )}

        <h2 style={{ ...styles.stepTitle, marginBottom: 8 }}>{recipe.name}</h2>
        <div style={styles.modalMeta}>
          <span style={styles.timeBadge}><Clock size={13} /> {recipe.time} мин</span>
          <span>
            {(cost * family).toLocaleString("ru-RU")} ₽ на {family} {family === 1 ? "человека" : "человек"}
            {!isRealPrice && " (оценочно)"}
          </span>
        </div>

        <h3 style={styles.sectionTitle}>Ингредиенты</h3>
        <div style={{ ...styles.listBox, marginBottom: 18 }}>
          {recipe.ingr.map(([name, amount, unit]) => (
            <div key={name} style={styles.listRow}>
              <span>{name}</span>
              <span style={{ color: "var(--text-tertiary)" }}>{Math.round(amount * family)} {unit}</span>
            </div>
          ))}
        </div>

        <h3 style={styles.sectionTitle}>Приготовление</h3>
        <ol style={styles.stepsList}>
          {recipe.steps.map((step, i) => (
            <li key={i} style={styles.stepItem}>{step}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ---------- styles ----------
// Liquid Glass: полупрозрачные слои с backdrop-filter поверх мягкого
// градиентного фона, тонкие hairline-обводки вместо жёстких рамок, системный
// шрифт Apple вместо декоративных веб-шрифтов, всё скруглено и "парит".

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif";
// Цвета читаются из CSS-переменных (см. <style> в JSX), а не хардкожены —
// так работает автоматическая тёмная тема через prefers-color-scheme, без
// какого-либо JS-состояния или переключателя.
const ACCENT = "var(--accent)";
const DANGER = "var(--danger)";

const glass = (opacity = 0.55, blur = 20) => ({
  background: `rgba(var(--glass-rgb), ${opacity})`,
  backdropFilter: `blur(${blur}px) saturate(180%)`,
  WebkitBackdropFilter: `blur(${blur}px) saturate(180%)`,
});

const styles = {
  page: {
    minHeight: "100dvh", width: "100%", display: "flex", justifyContent: "center", alignItems: "flex-start",
    background: "var(--page-bg)",
    padding: "40px 16px", fontFamily: FONT, color: "var(--text-primary)",
  },
  card: { width: "100%", maxWidth: 440, ...glass(0.55, 24), borderRadius: 28, border: "1px solid var(--hairline)", padding: 26, boxShadow: "var(--card-shadow)" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  brandRow: { display: "flex", alignItems: "center", gap: 8 },
  brand: { fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em" },
  greeting: { fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 },
  resetBtn: { display: "flex", alignItems: "center", gap: 5, ...glass(0.5, 8), border: "1px solid var(--hairline)", borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", cursor: "pointer" },
  accountBtn: { display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, ...glass(0.5, 8), border: "1px solid var(--hairline)", borderRadius: "50%", color: "var(--text-secondary)", cursor: "pointer" },
  quickHint: { fontSize: 12, color: "var(--text-tertiary)", textAlign: "center", marginTop: 10, lineHeight: 1.4 },
  inlineLinkBtn: { background: "none", border: "none", padding: 0, color: ACCENT, fontWeight: 600, fontSize: 12, cursor: "pointer", textDecoration: "underline" },
  accountHeaderRow: { display: "flex", alignItems: "center", marginBottom: 2 },
  acctSection: { marginTop: 18 },
  acctSectionTitle: { fontSize: 15, fontWeight: 700, marginBottom: 4 },
  acctSectionHint: { fontSize: 12.5, color: "var(--text-tertiary)", lineHeight: 1.45, margin: "0 0 12px 0" },
  acctLabel: { fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.02em", marginBottom: 8 },
  acctDivider: { height: 1, background: "var(--hairline)", margin: "22px 0" },
  acctClearBtn: { width: "100%", background: "none", border: "none", color: "var(--danger)", fontSize: 12.5, fontWeight: 500, cursor: "pointer", padding: "10px 0 0 0" },
  textInput: {
    width: "100%", padding: "12px 14px", borderRadius: 14, border: "1px solid var(--hairline)",
    ...glass(0.45, 10), color: "var(--text-primary)", fontSize: 14, fontFamily: "inherit",
  },
  themeChip: (active) => ({
    flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "12px 6px", borderRadius: 16, cursor: "pointer",
    border: active ? "1.5px solid rgba(10,132,255,0.55)" : "1px solid var(--hairline)",
    ...glass(active ? 0.7 : 0.45, 12),
    boxShadow: active ? "0 4px 14px rgba(10,132,255,0.18)" : "none",
    color: active ? ACCENT : "var(--text-secondary)", fontSize: 11.5, fontWeight: 600,
  }),
  subCard: { border: "1px solid var(--hairline)", borderRadius: 20, padding: "16px 16px 18px", ...glass(0.5, 12) },
  freeBadge: { fontSize: 10.5, fontWeight: 700, color: "var(--text-tertiary)", background: "var(--track-bg)", padding: "2px 8px", borderRadius: 999, marginLeft: "auto" },
  progressWrap: { marginBottom: 22 },
  progressTrack: { height: 5, borderRadius: 999, background: "var(--track-bg)", overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 999, background: `linear-gradient(90deg, ${ACCENT}, var(--accent-2))`, transition: "width .25s ease" },
  progressLabel: { fontSize: 12, fontWeight: 500, color: "var(--text-tertiary)", marginTop: 8 },
  stepBody: { minHeight: 260, display: "flex", flexDirection: "column" },
  stepIcon: { width: 40, height: 40, borderRadius: 14, background: "rgba(10,132,255,0.12)", color: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 14 },
  stepTitle: { fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em", margin: "0 0 4px 0" },
  stepSub: { fontSize: 13.5, color: "var(--text-secondary)", margin: "0 0 18px 0", lineHeight: 1.4 },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  storeChip: (active) => ({
    textAlign: "left", padding: "13px 15px", borderRadius: 18, cursor: "pointer",
    border: active ? `1.5px solid rgba(10,132,255,0.55)` : "1px solid var(--hairline)",
    ...glass(active ? 0.7 : 0.45, 12),
    boxShadow: active ? "0 4px 14px rgba(10,132,255,0.18)" : "none",
    color: "var(--text-primary)",
  }),
  rowChip: (active) => ({
    display: "flex", alignItems: "center", justifyContent: "space-between", textAlign: "left", padding: "13px 15px", borderRadius: 18, cursor: "pointer",
    border: active ? `1.5px solid rgba(10,132,255,0.55)` : "1px solid var(--hairline)",
    ...glass(active ? 0.7 : 0.45, 12),
    boxShadow: active ? "0 4px 14px rgba(10,132,255,0.18)" : "none",
    color: "var(--text-primary)",
  }),
  chipHint: { fontSize: 12, color: "var(--text-tertiary)", marginTop: 4, lineHeight: 1.4, fontWeight: 400 },
  stack: { display: "flex", flexDirection: "column", gap: 8 },
  counterRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 24, marginTop: 8 },
  counterBtn: { width: 44, height: 44, borderRadius: "50%", border: "1px solid var(--hairline)", ...glass(0.6, 10), color: ACCENT, fontSize: 20, cursor: "pointer", lineHeight: 1, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  counterVal: { fontSize: 36, fontWeight: 700, minWidth: 44, textAlign: "center" },
  counterCaption: { textAlign: "center", fontSize: 13, color: "var(--text-tertiary)", marginTop: 8 },
  budgetVal: { fontSize: 36, fontWeight: 700, textAlign: "center", marginBottom: 16 },
  slider: { width: "100%" },
  sliderLabels: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-tertiary)", marginTop: 6 },
  navRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto", paddingTop: 22 },
  navBtn: { display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 13.5, fontWeight: 500, cursor: "pointer", padding: "8px 4px" },
  navBtnPrimary: { display: "flex", alignItems: "center", gap: 4, background: `linear-gradient(180deg, ${ACCENT}, #0066DB)`, border: "none", color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", padding: "11px 18px", borderRadius: 999, marginLeft: "auto", boxShadow: "0 6px 16px rgba(10,132,255,0.35)" },
  resultHeader: { marginBottom: 14 },
  warningBox: { display: "flex", gap: 8, alignItems: "flex-start", background: "var(--warning-soft)", border: "1px solid var(--warning-border)", borderRadius: 16, padding: "12px 14px", fontSize: 12.5, color: "var(--warning-text)", marginBottom: 14, lineHeight: 1.4 },
  totalBox: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "18px 0", border: "1px solid var(--hairline)", borderRadius: 20, marginBottom: 20, ...glass(0.55, 12) },
  sectionTitle: { fontSize: 13, fontWeight: 600, color: "var(--text-tertiary)", margin: "0 0 8px 0" },
  dayBlock: { paddingBottom: 8, marginBottom: 4, borderBottom: "1px solid var(--hairline)" },
  dayTag: { fontSize: 11, fontWeight: 700, color: ACCENT, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.02em" },
  recipeRow: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 14 },
  timeBadge: { display: "flex", alignItems: "center", gap: 3, color: "var(--text-tertiary)", fontSize: 11, flexShrink: 0 },
  swapBtn: (canSwap) => ({ display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", padding: 2, flexShrink: 0, color: ACCENT, cursor: canSwap ? "pointer" : "default", opacity: canSwap ? 0.8 : 0.25 }),
  deptLabel: { fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.02em" },
  listBox: { display: "flex", flexDirection: "column" },
  listRow: { display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--hairline-2)", fontSize: 13.5 },
  orderBtn: { width: "100%", padding: "14px 0", background: `linear-gradient(180deg, ${ACCENT}, #0066DB)`, border: "none", borderRadius: 18, color: "#fff", fontSize: 14.5, fontWeight: 600, cursor: "pointer", marginTop: 8, boxShadow: "0 8px 20px rgba(10,132,255,0.35)" },
  orderError: { fontSize: 12, color: "var(--danger)", textAlign: "center", marginTop: 8 },
  orderNote: { fontSize: 12, color: "var(--text-tertiary)", textAlign: "center", marginTop: 8, lineHeight: 1.4 },
  shareBtn: { width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "13px 0", ...glass(0.6, 10), border: "1px solid var(--hairline)", borderRadius: 18, color: "var(--text-primary)", fontSize: 14, fontWeight: 600, cursor: "pointer", marginTop: 8 },

  recipeRowBtn: { flex: 1, display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: "4px 2px", borderRadius: 10, textAlign: "left", cursor: "pointer", color: "var(--text-primary)", font: "inherit", minWidth: 0 },
  recipeEmoji: { fontSize: 17, flexShrink: 0, width: 20, textAlign: "center" },

  modalOverlay: { position: "fixed", inset: 0, background: "var(--modal-backdrop)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 },
  modalCard: { width: "100%", maxWidth: 420, maxHeight: "85vh", overflowY: "auto", ...glass(0.9, 30), borderRadius: 28, border: "1px solid var(--hairline)", padding: 26, boxShadow: "var(--modal-shadow)", position: "relative" },
  modalClose: { position: "absolute", top: 16, right: 16, width: 32, height: 32, borderRadius: "50%", border: "1px solid var(--hairline)", background: "rgba(120,120,128,0.16)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--text-primary)" },
  modalHero: { width: "100%", height: 120, borderRadius: 20, background: "linear-gradient(135deg, rgba(10,132,255,0.14), rgba(100,210,255,0.14))", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 56, marginBottom: 16 },
  modalHeroPhoto: { width: "100%", height: 180, borderRadius: 20, objectFit: "cover", marginBottom: 16, display: "block" },
  modalMeta: { display: "flex", gap: 14, fontSize: 13, color: "var(--text-tertiary)", marginBottom: 18, flexWrap: "wrap" },
  stepsList: { margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 8, fontSize: 13.5, lineHeight: 1.5, color: "var(--text-primary)" },
  stepItem: { paddingLeft: 4 },

  skeletonBar: (h, w) => ({ height: h, width: w || "100%", marginBottom: 10 }),
  assemblingCaption: { display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "var(--text-secondary)", marginBottom: 20 },
};
