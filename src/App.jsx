import { useState, useMemo, useEffect } from "react";
import { Check, ChevronLeft, ChevronRight, Store, Users, Wallet, Salad, ChefHat, Flame, RotateCcw, UtensilsCrossed, Clock, Repeat, Ban, TriangleAlert, X, Loader2, Share2, Settings, Sun, Moon, MonitorSmartphone, Sparkles, PackageSearch, Home, MessageCircle } from "lucide-react";
import { ALLERGENS } from "./data/recipes.js";
import { buildCartFromShoppingList, toVkusvillQuantity, clearMcpCache } from "./lib/vkusvillMcp.js";
import { fetchVkusvillPools, getSubstituteOptions, attachRealCosts } from "./lib/vkusvillRecipes.js";
import { loadProfile, saveProfile, clearProfile, loadTheme, saveTheme } from "./lib/profile.js";
import { buildPools, buildInitialPlan, buildPlanView, interleaveGroups } from "./lib/planLogic.js";
import { submitPlanToBackend, checkPlanStatus, savePlanToHistory, fetchPlanHistory, updateMealTimes } from "./lib/backend.js";
import { trackEvent } from "./lib/analytics.js";
import logoUrl from "./assets/logo.svg";
import { hapticSelect, hapticImpact, hapticNotify } from "./lib/haptics.js";
import { checkHomeScreenStatus, promptAddToHomeScreen, onHomeScreenAdded } from "./lib/homeScreen.js";

// Разумные дефолты "во сколько вы обычно едите" — единственное, чего не
// хватало для напоминаний от бота (см. server/README.md и обсуждение в
// чате): раньше визард спрашивал КАКИЕ приёмы пищи, но не КОГДА. Отдельного
// шага под это нет — правится в Аккаунте, вместе с остальными "настроил
// один раз" полями.
const DEFAULT_MEAL_TIMES = { breakfast: "08:00", lunch: "13:00", dinner: "19:00", snack: "16:00" };

// t.me-ссылка на чат для обратной связи — это чат с самим ботом
// (https://t.me/s_edim_bot), не личный аккаунт разработчика: сервер умеет
// принимать и агрегировать такие сообщения (см. server/src/webhook.js —
// свободный текст сохраняется как обращение и отвечает благодарностью,
// админ смотрит накопленное командой /feedback). Задаётся переменной
// окружения при сборке (см. .github/workflows/deploy.yml), кнопка в
// Аккаунте сама скрывается, если переменная не задана.
const SUPPORT_URL = import.meta.env.VITE_SUPPORT_URL || null;

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

// Уровни привязаны к реальной таксономии ВкусВилл (см. vkusvillRecipes.js,
// COOKING_TIME_BUCKET_IDS) — не произвольные 10/15/30, а то, что реально
// достижимо без пустых пулов: у них самый мелкий бакет "до 20 минут", более
// дробного деления в их данных просто нет.
const COOK_TIME_TIERS = [
  { id: "any", label: "Неважно", hint: "покажем любые по времени", maxMinutes: null },
  { id: "fast", label: "До 20 минут", hint: "быстро, когда пришли уставшие", maxMinutes: 20 },
  { id: "medium", label: "До 40 минут", hint: "готовы уделить готовке чуть больше", maxMinutes: 40 },
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
  { key: "cooktime", label: "Время готовки" },
];
const QUICK_STEP_KEYS = ["store", "budget"];

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
  const [maxCookTime, setMaxCookTime] = useState(savedProfile?.maxCookTime ?? null);
  const [done, setDone] = useState(false);
  const [assembling, setAssembling] = useState(false);
  const [planState, setPlanState] = useState(null);
  const [openRecipe, setOpenRecipe] = useState(null);
  const [showProModal, setShowProModal] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [displayName, setDisplayName] = useState(savedProfile?.displayName ?? "");
  const [mealTimes, setMealTimes] = useState(savedProfile?.mealTimes ?? DEFAULT_MEAL_TIMES);

  // Тариф и история — реальные данные с бэкенда (null = ещё не спрашивали
  // или нечем спросить, см. lib/backend.js). Запрашиваем при открытии
  // Аккаунта, не на каждый рендер — это единственное место, где они видны.
  const [planStatus, setPlanStatus] = useState(null);
  const [planHistory, setPlanHistory] = useState(null);
  useEffect(() => {
    if (!showAccount) return;
    checkPlanStatus().then(setPlanStatus);
    fetchPlanHistory().then(setPlanHistory);
  }, [showAccount]);

  // Блокировка "бесплатный лимит исчерпан" — знаем об этом только после
  // ответа бэкенда на попытку "Собрать список" (см. handleFinish), поэтому
  // отдельное состояние, а не часть planStatus выше (тот обновляется только
  // пока открыт Аккаунт).
  const [limitBlocked, setLimitBlocked] = useState(null); // null | { nextResetHint }

  // "Добавить на экран" (Bot API 8.0+, см. lib/homeScreen.js) — статус
  // проверяем один раз при монтировании, а не при каждом открытии Аккаунта:
  // он не меняется сам по себе, кроме момента, когда пользователь реально
  // подтвердит добавление (тогда прилетит событие homeScreenAdded).
  const [homeScreenStatus, setHomeScreenStatus] = useState("unsupported");
  useEffect(() => {
    checkHomeScreenStatus().then(setHomeScreenStatus);
    return onHomeScreenAdded(() => {
      setHomeScreenStatus("added");
      trackEvent("home_screen_added");
    });
  }, []);

  // "Открыли приложение" — раз за сессию, не при каждом ререндере.
  useEffect(() => {
    trackEvent("app_opened", { has_profile: hasProfile });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Известный баг части Android-WebView (в т.ч. внутри Telegram Mini App) —
  // после программного обновления DOM (без тач-события от пользователя)
  // экран не перерисовывается сразу: кадр готов внутри WebView, но не
  // "запаяснен" на экран, пока пользователь не коснётся его пальцем/не
  // проскроллит — это и триггерит перерисовку, которую WebView иначе
  // откладывает. Жалоба в чате: именно на переходе в состояние "собираем
  // список" и обратно, где контент меняется полностью и программно.
  // Форсируем reflow вручную на каждый такой переход.
  useEffect(() => {
    const el = document.documentElement;
    el.style.transform = "translateZ(0)";
    void el.offsetHeight; // синхронно форсирует reflow — без чтения layout-свойства присвоение transform выше могло бы быть "отложено" браузером
    const raf = requestAnimationFrame(() => {
      el.style.transform = "";
    });
    return () => cancelAnimationFrame(raf);
  }, [assembling, done]);

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
    hapticSelect();
    setArr((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleCuisine = (arr, setArr, id) => {
    hapticSelect();
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
    cooktime: true, // необязателен — "неважно" тоже осознанный ответ
  };

  // Раньше пересчитывалось на каждое изменение фильтра (useMemo) — теперь
  // пулы для ВкусВилл тянутся живьём из MCP, это асинхронно, поэтому
  // считаются один раз, в момент "Собрать список" (handleFinish), а не
  // реактивно по ходу визарда. До первого нажатия — null, и это ок:
  // planView ниже явно проверяет planState на null раньше, чем тронуть pools.
  const [pools, setPools] = useState(null);
  // Карта ингредиент->цена товара (ВкусВилл) — null для остальных сетей или
  // если реальные рецепты не подтянулись (см. комментарий у buildPlanView).
  const [priceByName, setPriceByName] = useState(null);
  const [retryingPrices, setRetryingPrices] = useState(false);
  const [priceRetryFailed, setPriceRetryFailed] = useState(false);

  // "Повторить получение цен" — ВкусВилл иногда лимитирует burst запросов
  // (см. vkusvillMcp.js), и план собирается с mostlyUnpriced=true. Раньше
  // единственный совет был "соберите план заново через пару минут" — то есть
  // заново пройти весь визард ради того, чтобы пулы рецептов остались теми
  // же, просто ещё раз спросить цены. Пулы уже есть в состоянии — просто
  // зовём attachRealCosts ещё раз на них же и обновляем priceByName.
  //
  // Жалоба в чате "нажимаю кнопку — ничего не происходит": вероятная причина —
  // сам MCP-клиент кэширует УСПЕШНЫЕ ответы на 10 минут (см. vkusvillMcp.js),
  // а VkusVill под нагрузкой иногда отвечает 200 с пустым items вместо
  // честного 429 — такой ответ не ошибка, значит кэшируется как есть, и
  // повтор молча получал бы тот же пустой результат из кэша, ни разу не
  // спросив сеть заново. clearMcpCache() перед повтором — чтобы "повторить"
  // означало по-настоящему повторить, а не отдать то же самое из кэша.
  const handleRetryPrices = async () => {
    if (!pools) return;
    setRetryingPrices(true);
    setPriceRetryFailed(false);
    clearMcpCache();
    try {
      const fresh = await attachRealCosts(pools);
      setPriceByName(fresh);
      // Та же грубая эвристика, что и mostlyUnpriced в planLogic.js — если
      // цену не нашли почти ни для чего и на этот раз, честно показываем,
      // что попытка не удалась, а не молча оставляем ту же надпись, будто
      // кнопка вообще ничего не сделала.
      setPriceRetryFailed(fresh.size === 0);
    } catch (err) {
      console.warn("Повторная попытка получить цены не удалась:", err.message);
      setPriceRetryFailed(true);
    } finally {
      setRetryingPrices(false);
    }
  };

  // planState хранит только id рецептов по дням — так swapMeal меняет один слот,
  // не трогая остальную неделю и не требуя пересборки с нуля
  const planView = useMemo(() => buildPlanView(planState, pools, family, priceByName), [planState, pools, family, priceByName]);

  // Best-effort отправка плана на сервер напоминаний — см. lib/backend.js,
  // там же и все причины, по которым это может тихо ничего не сделать
  // (бэкенд не задеплоен, приложение открыто не в Telegram). Срабатывает
  // и повторно при "Заменить блюдо" (planView меняется) — это правильно:
  // сервер должен напоминать про АКТУАЛЬНОЕ блюдо, а не про то, что было
  // до замены.
  useEffect(() => {
    if (done && planView) submitPlanToBackend(planView, mealTimes);
  }, [done, planView, mealTimes]);

  const handleFinish = async () => {
    // Бесплатный лимит — только если есть у кого спросить (бэкенд задеплоен
    // и мы в Telegram); без него checkPlanStatus() вернёт null и мы честно
    // ничего не блокируем — тот же принцип "бэкенд опционален", что и везде.
    const status = await checkPlanStatus();
    if (status && status.canGenerate === false) {
      hapticNotify("error");
      setLimitBlocked({ nextResetHint: status.nextResetHint });
      return;
    }
    setLimitBlocked(null);

    const selectedMeals = MEALS.filter((m) => meals.includes(m.id));
    const neededCategories = [...new Set(selectedMeals.map((m) => m.category))];
    setAssembling(true);

    let resolvedPools;
    let resolvedPriceByName = null;
    if (store === "vv") {
      // Реальные рецепты ВкусВилл — с реальными фото, шагами и (по
      // возможности) реальной ценой. Если MCP недоступен/упал — тихо
      // откатываемся на прежний статический список, а не роняем экран:
      // пользователь всё равно должен получить план, просто оценочный.
      try {
        const result = await fetchVkusvillPools({ diet, cuisines, devices, allergies, categories: neededCategories, maxCookTime });
        resolvedPools = result.pools;
        resolvedPriceByName = result.priceByName;
        const gotAnything = neededCategories.some((c) => (resolvedPools[c] || []).length > 0);
        if (!gotAnything) throw new Error("VkusVill не вернул рецептов под эти фильтры");
      } catch (err) {
        console.warn("VkusVill MCP недоступен, откат на статические рецепты:", err.message);
        resolvedPools = buildPools(diet, cuisines, devices, allergies, maxCookTime);
      }
    } else {
      resolvedPools = buildPools(diet, cuisines, devices, allergies, maxCookTime);
    }

    const newPlanState = buildInitialPlan(resolvedPools, selectedMeals, budget, family);
    setPools(resolvedPools);
    setPriceByName(resolvedPriceByName);
    setPlanState(newPlanState);
    setDone(true);
    setAssembling(false);
    hapticNotify("success");
    trackEvent("plan_generated", { store, budget, family, meals_count: selectedMeals.length });

    // Считаем planView сами, здесь же — planView-в-состоянии соберётся
    // только на следующий рендер (useMemo), а в историю нужно положить
    // РОВНО тот план, что только что собрали, один раз, а не всё, во что он
    // потом превратится после замен товаров (см. лимит выше — тот сценарий
    // сознательно повторяет отправку при каждой замене, этот — нет).
    const freshPlanView = buildPlanView(newPlanState, resolvedPools, family, resolvedPriceByName);
    savePlanToHistory({
      storeId: store,
      storeName: STORES.find((s) => s.id === store)?.name || store,
      budget,
      family,
      totalCost: freshPlanView.total,
      plan: {
        total: freshPlanView.total,
        itemized: freshPlanView.itemized,
        shoppingItemsCount: freshPlanView.grouped.reduce((sum, g) => sum + g.items.length, 0),
        days: freshPlanView.days.map((d) => ({
          day: d.day,
          dayMeals: d.dayMeals.map((dm) => ({ mealLabel: dm.mealLabel, name: dm.recipe.name, emoji: dm.recipe.emoji, time: dm.recipe.time, cost: dm.cost })),
        })),
      },
    });
  };

  const swapMeal = (dayIndex, slotIndex) => {
    hapticImpact("light");
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
    hapticImpact("light");
    setStep(0); setStore(null); setBudget(4000); setDone(false); setPlanState(null);
    setOpenRecipe(null); setAssembling(false); setPools(null); setPriceByName(null);
    if (!hasProfile) {
      setFamily(2); setMeals(["lunch", "dinner"]); setDiet(null);
      setAllergies([]); setCuisines([]); setDevices([]); setMaxCookTime(null);
    }
  };

  const handleSaveProfile = () => {
    hapticNotify("success");
    saveProfile({ family, meals, diet, allergies, cuisines, devices, displayName, mealTimes, maxCookTime });
    // Раньше время приёмов пищи долетало до сервера напоминаний ТОЛЬКО вместе
    // с целым планом (см. useEffect ниже на submitPlanToBackend) — если
    // открыть Аккаунт и поменять время, не пересобирая план заново в этой же
    // сессии, новое время никогда не сохранялось на сервере, и напоминания
    // продолжали приходить по старому времени. Обновляем его отдельно и
    // сразу же, best-effort — как и всё остальное здесь, без бэкенда просто
    // ничего не произойдёт.
    updateMealTimes(mealTimes);
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
        /* Нативная иконка часов у <input type="time"> красится браузером сама
           (обычно серым/чёрным) — CSS не даёт задать ей произвольный цвет
           напрямую. Прячем её (opacity почти 0, а не 0 — на части WebKit
           полностью прозрачный элемент перестаёт быть кликабельным), а
           поверх рисуем свою Clock-иконку в акцентном цвете (см. mealTimeRow
           в JSX) — клик всё равно попадает на невидимый нативный контрол под
           ней, просто визуально показываем свою. */
        input[type="time"]::-webkit-calendar-picker-indicator { opacity: 0.015; }
      `}</style>

      <div style={styles.card} className="mp-card">
        <div style={styles.header}>
          <div>
            <div style={styles.brandRow}>
              {/* Раньше тут была generic-иконка корзины + функциональная подпись
                  "Список на неделю" — узнаваемого бренда в этом не было, приложение
                  выглядело как безымянный виджет. Теперь — настоящий логотип (тот
                  же образ дымящейся миски, что уже на аватарке @s_edim_bot) плюс
                  название — шапка сразу говорит "это Съедим", а не описывает
                  функцию, которую и так видно по контенту ниже. */}
              <img src={logoUrl} alt="" style={styles.logoMark} />
              <span style={styles.brand}>Съедим</span>
            </div>
            {(displayName || tgFirstName) && (
              <div style={styles.greeting} className="greeting-fade">Привет, {displayName || tgFirstName} 👋</div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {done && !showAccount && (
              <button onClick={reset} style={styles.resetBtn}>
                <RotateCcw size={14} /> Заново
              </button>
            )}
            <button
              onClick={() => setShowAccount((v) => !v)}
              style={styles.accountBtn}
              title={showAccount ? "Закрыть аккаунт" : "Аккаунт"}
              aria-label={showAccount ? "Закрыть аккаунт" : "Аккаунт"}
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
            maxCookTime={maxCookTime} setMaxCookTime={setMaxCookTime}
            mealTimes={mealTimes} setMealTimes={setMealTimes}
            toggleSimple={toggleSimple} toggleCuisine={toggleCuisine}
            hasProfile={hasProfile}
            onSave={handleSaveProfile}
            onClear={handleClearProfile}
            onClose={() => setShowAccount(false)}
            onOpenPro={() => { trackEvent("pro_modal_opened"); setShowProModal(true); }}
            homeScreenStatus={homeScreenStatus}
            onAddToHomeScreen={() => { hapticImpact("light"); trackEvent("home_screen_prompted"); promptAddToHomeScreen(); }}
            planStatus={planStatus}
            planHistory={planHistory}
          />
        )}

        {!showAccount && limitBlocked && (
          <div style={styles.stepBody} className="mp-step-body">
            <StepShell icon={<Sparkles size={20} color={ACCENT} />} title="Бесплатный лимит на этой неделе исчерпан" sub="На бесплатном тарифе доступен 1 план в неделю">
              <p style={{ ...styles.acctSectionHint, marginTop: 0 }}>
                Новый план будет доступен позже — или оформите Pro прямо сейчас, чтобы собирать план без ограничений.
              </p>
              <button
                onClick={() => { hapticImpact("light"); trackEvent("pro_modal_opened", { source: "limit_blocked" }); setShowProModal(true); }}
                style={{ ...styles.navBtnPrimary, width: "100%", justifyContent: "center", marginTop: 8 }}
              >
                Открыть Pro
              </button>
              <button onClick={() => setLimitBlocked(null)} style={styles.acctClearBtn}>Назад</button>
            </StepShell>
          </div>
        )}

        {!showAccount && !limitBlocked && !done && !assembling && (
          <div style={styles.progressWrap}>
            {/* Раньше — одна сплошная полоска-заливка. Отдельный сегмент на
                каждый шаг читается яснее ("вот сколько шагов всего, вот сколько
                пройдено") и выглядит менее как generic progress bar с любого
                сайта — мелкая деталь, но из тех, что складываются в ощущение
                "сделано осмысленно", а не типовым компонентом из коробки. */}
            <div style={styles.progressSegments}>
              {activeSteps.map((s, i) => (
                <div key={s.key} style={styles.progressSegment(i <= step)} />
              ))}
            </div>
            <div style={styles.progressLabel}>
              Шаг {step + 1} из {activeSteps.length} · {activeSteps[step]?.label}
            </div>
          </div>
        )}

        {!showAccount && !limitBlocked && assembling && <SkeletonView />}

        {!showAccount && !limitBlocked && !done && !assembling && (
          <div style={styles.stepBody} className="mp-step-body">
            {currentStepKey === "store" && (
              <StepShell icon={<Store size={20} />} title="Где вам удобно заказывать?" sub="Выберите магазин с доставкой в вашем районе">
                <div style={styles.grid2}>
                  {STORES.map((s) => (
                    <button key={s.id} className="chip" onClick={() => { hapticSelect(); setStore(s.id); }} style={styles.storeChip(store === s.id)}>
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
                    <button key={d.id} className="chip" onClick={() => { hapticSelect(); setDiet(d.id); }} style={styles.rowChip(diet === d.id)}>
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
                    onClick={() => { hapticSelect(); setAllergies([]); }}
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

            {currentStepKey === "cooktime" && (
              <StepShell icon={<Clock size={20} />} title="Сколько времени готовы тратить на готовку?" sub="Пришли уставшие после работы — выберите быстрые рецепты, будет время — берите любые">
                <div style={styles.stack}>
                  {COOK_TIME_TIERS.map((t) => (
                    <button key={t.id} className="chip" onClick={() => { hapticSelect(); setMaxCookTime(t.maxMinutes); }} style={styles.rowChip(maxCookTime === t.maxMinutes)}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{t.label}</div>
                        <div style={styles.chipHint}>{t.hint}</div>
                      </div>
                      {maxCookTime === t.maxMinutes && <Check size={16} color={ACCENT} />}
                    </button>
                  ))}
                </div>
              </StepShell>
            )}

            <div style={styles.navRow} className="mp-nav-row">
              <button onClick={() => { hapticImpact("light"); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0} style={{ ...styles.navBtn, visibility: step === 0 ? "hidden" : "visible" }}>
                <ChevronLeft size={16} /><span>Назад</span>
              </button>
              <button
                onClick={() => {
                  hapticImpact("medium");
                  trackEvent("wizard_step_completed", { step: currentStepKey });
                  step === activeSteps.length - 1 ? handleFinish() : setStep((s) => s + 1);
                }}
                disabled={!canNextByKey[currentStepKey]}
                style={{ ...styles.navBtnPrimary, opacity: canNextByKey[currentStepKey] ? 1 : 0.4 }}
              >
                <span>{step === activeSteps.length - 1 ? "Собрать список" : "Далее"}</span><ChevronRight size={16} />
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
            diet={diet}
            allergies={allergies}
            onSwap={swapMeal}
            onOpenRecipe={setOpenRecipe}
            onRetryPrices={handleRetryPrices}
            retryingPrices={retryingPrices}
            priceRetryFailed={priceRetryFailed}
          />
        )}
      </div>

      {openRecipe && (
        <RecipeModal dm={openRecipe} family={family} onClose={() => setOpenRecipe(null)} />
      )}
      {showProModal && <ProModal onClose={() => setShowProModal(false)} />}
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
  maxCookTime, setMaxCookTime,
  mealTimes, setMealTimes,
  toggleSimple, toggleCuisine, hasProfile, onSave, onClear, onClose, onOpenPro,
  homeScreenStatus, onAddToHomeScreen,
  planStatus, planHistory,
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
          <ChevronLeft size={16} /><span>Назад</span>
        </button>
      </div>
      <h2 style={{ ...styles.stepTitle, marginTop: 4 }}>Аккаунт</h2>

      <div style={styles.acctSection}>
        <div style={styles.acctLabel}>Как к вам обращаться</div>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          placeholder="Имя для приветствия"
          enterKeyHint="done"
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

      {SUPPORT_URL && (
        <div style={styles.acctSection}>
          <button
            className="chip"
            onClick={() => {
              hapticImpact("light");
              trackEvent("support_clicked");
              // openTelegramLink — официальный способ открыть t.me-ссылку из
              // Mini App (обычный window.open в некоторых клиентах может не
              // сработать); вне Telegram (локальный просмотр) — просто
              // открываем как обычную ссылку.
              window.Telegram?.WebApp?.openTelegramLink ? window.Telegram.WebApp.openTelegramLink(SUPPORT_URL) : window.open(SUPPORT_URL, "_blank");
            }}
            style={styles.rowChip(false)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <MessageCircle size={16} color={ACCENT} />
              <div style={{ fontWeight: 600 }}>Написать в поддержку</div>
            </div>
          </button>
        </div>
      )}

      {homeScreenStatus !== "unsupported" && (
        <div style={styles.acctSection}>
          <div style={styles.acctLabel}>Быстрый доступ</div>
          {homeScreenStatus === "added" ? (
            <div style={styles.homeScreenAddedRow}>
              <Home size={16} color={ACCENT} />
              <span>Уже на экране телефона</span>
            </div>
          ) : (
            <button onClick={onAddToHomeScreen} className="chip" style={styles.rowChip(false)}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Home size={16} color={ACCENT} />
                <div>
                  <div style={{ fontWeight: 600 }}>Добавить на экран</div>
                  <div style={styles.chipHint}>Открывать одним тапом, без захода в Telegram</div>
                </div>
              </div>
            </button>
          )}
        </div>
      )}

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

        {meals.length > 0 && (
          <>
            <div style={{ ...styles.acctLabel, marginTop: 16 }}>Во сколько обычно едите</div>
            <p style={styles.acctSectionHint}>Нужно только для напоминаний от бота — без этого мы не знаем, за сколько до еды написать.</p>
            <div style={styles.stack}>
              {MEALS.filter((m) => meals.includes(m.id)).map((m) => (
                <div key={m.id} style={styles.mealTimeRow}>
                  <span>{m.label}</span>
                  <div style={styles.timeInputWrap}>
                    <input
                      type="time"
                      value={mealTimes[m.id] || DEFAULT_MEAL_TIMES[m.id]}
                      onChange={(e) => setMealTimes((prev) => ({ ...prev, [m.id]: e.target.value }))}
                      style={styles.timeInput}
                    />
                    <Clock size={14} color={ACCENT} style={styles.timeInputIcon} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Рацион</div>
        <div style={styles.stack}>
          {DIETS.map((d) => (
            <button key={d.id} className="chip" onClick={() => { hapticSelect(); setDiet(d.id); }} style={styles.rowChip(diet === d.id)}>
              <div style={{ fontWeight: 600 }}>{d.label}</div>
              {diet === d.id && <Check size={16} color={ACCENT} />}
            </button>
          ))}
        </div>

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Аллергии</div>
        <div style={styles.grid2}>
          <button className="chip" onClick={() => { hapticSelect(); setAllergies([]); }} style={styles.storeChip(allergies.length === 0)}>
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

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Время готовки</div>
        <div style={styles.stack}>
          {COOK_TIME_TIERS.map((t) => (
            <button key={t.id} className="chip" onClick={() => { hapticSelect(); setMaxCookTime(t.maxMinutes); }} style={styles.rowChip(maxCookTime === t.maxMinutes)}>
              <div>
                <div style={{ fontWeight: 600 }}>{t.label}</div>
                <div style={styles.chipHint}>{t.hint}</div>
              </div>
              {maxCookTime === t.maxMinutes && <Check size={16} color={ACCENT} />}
            </button>
          ))}
        </div>

        <button
          onClick={handleSave}
          disabled={!diet}
          style={{ ...styles.navBtnPrimary, width: "100%", justifyContent: "center", marginTop: 18, opacity: diet ? 1 : 0.4 }}
        >
          {saved ? <><Check size={16} /> Сохранено</> : "Сохранить как профиль"}
        </button>
        {!diet && (
          <p style={styles.acctWarnHint}>Сначала выберите рацион выше — без него план собрать не получится.</p>
        )}
        {hasProfile && (
          <button onClick={onClear} style={styles.acctClearBtn}>
            Сбросить сохранённый профиль
          </button>
        )}
      </div>

      <div style={styles.acctDivider} />
      <AccountSubscriptionCard onOpenPro={onOpenPro} planStatus={planStatus} />
      <PlanHistorySection planHistory={planHistory} />
    </div>
  );
}

// Реальной оплаты тут пока нет — ни один платёжный провайдер (Stars,
// ЮKassa) не подключён, кнопка ничего не списывает. Это осознанно: платить
// за то, чего нет, — обман пользователя. Как только появится бэкенд с
// вебхуком от платёжного провайдера (см. docs/telegram-bot-architecture.md),
// кнопка ниже превратится в реальный openLink на страницу оплаты. Само
// разделение на бесплатный/платный тариф — уже реальное (см.
// server/src/app.js: /api/plan-status), просто выдать Pro можно сейчас
// только вручную (server/scripts/set-pro.js), а не по факту оплаты.
// Раньше был один абзац текста — сухое перечисление без объяснения "зачем
// мне это". Пользователь в чате прямо попросил: разворачивающиеся пункты,
// чтобы понять пользу подробнее, а не просто прочитать список слов.
const SUBSCRIPTION_BENEFITS = [
  {
    title: "Безлимитная пересборка плана",
    short: "Меняйте магазин, бюджет или просто пересобирайте заново — без ограничений",
    detail: "На бесплатном тарифе — 1 план в неделю. С подпиской ограничения нет вообще.",
  },
  {
    title: "Несколько планов одновременно",
    short: "Свой план, план для родителей, план на праздник — раздельно",
    detail: "Сейчас активен только один план — «заново» стирает предыдущий. С подпиской можно будет держать несколько планов и переключаться между ними, не теряя ни один.",
  },
  {
    title: "Напоминания от бота",
    short: "Бот сам напишет, когда пора готовить — не нужно открывать приложение",
    detail: "За 30 минут до ужина (или другого приёма пищи) бот пришлёт сообщение с названием блюда прямо в чат — уже в разработке, скоро можно будет проверить на деле.",
  },
  {
    title: "Общий список на семью",
    short: "Все видят один и тот же план и список покупок в реальном времени",
    detail: "Отметил купленное один член семьи — увидят все. Меньше дублирующихся покупок и созвонов «а ты купил...».",
  },
];

// Раньше в Аккаунте был мини-аккордеон с тем же списком, что и здесь — теперь
// он переехал в отдельный полноэкранный ProModal (пользователь в чате прямо
// это попросил: компактная карточка в Аккаунте + большое окно с полным
// питчем и ценой по кнопке "Перейти на Pro", а не два дублирующих друг друга
// списка). Карточка в Аккаунте теперь просто честно называет, что доступно
// сейчас, и одной кнопкой ведёт к продающему экрану.
function AccountSubscriptionCard({ onOpenPro, planStatus }) {
  // planStatus === null — либо бэкенд не задеплоен, либо ещё грузится:
  // в обоих случаях честнее не утверждать конкретную цифру лимита, раз мы
  // её на самом деле не знаем прямо сейчас.
  const isPro = planStatus?.isPro ?? false;
  return (
    <div style={styles.acctSection}>
      <div style={styles.subCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Sparkles size={16} color={ACCENT} />
          <span style={{ fontWeight: 700, fontSize: 15 }}>Подписка</span>
          <span style={isPro ? styles.proBadge : styles.freeBadge}>{isPro ? "Pro" : "Free"}</span>
        </div>
        {isPro ? (
          <p style={styles.acctSectionHint}>Спасибо за подписку — пересборка плана без ограничений.</p>
        ) : (
          <p style={styles.acctSectionHint}>
            На бесплатном тарифе — 1 план в неделю{planStatus ? ` (использовано: ${planStatus.usedThisWeek}/${planStatus.freeLimitPerWeek})` : ""}.
            Pro снимает это ограничение и добавляет напоминания, несколько планов и общий список на семью.
          </p>
        )}
        {!isPro && (
          <button onClick={() => { hapticImpact("light"); onOpenPro(); }} style={{ ...styles.orderBtn, marginTop: 4 }}>
            Перейти на Pro
          </button>
        )}
      </div>
    </div>
  );
}

const HISTORY_DAY_EMOJI_FALLBACK = "🍽";

// Список прошлых планов — только если бэкенд вообще способен на него
// ответить (planHistory !== null, см. lib/backend.js:fetchPlanHistory).
// Пустой массив — реальное "пока нет истории", не то же самое, что "нечем
// спросить" (тогда весь раздел скрыт целиком, чтобы не обещать того, что
// зависит от недоступного бэкенда).
function PlanHistorySection({ planHistory }) {
  const [openId, setOpenId] = useState(null);
  if (planHistory === null) return null;

  return (
    <div style={styles.acctSection}>
      <div style={styles.acctSectionTitle}>История планов</div>
      {planHistory.length === 0 ? (
        <p style={styles.acctSectionHint}>Пока пусто — здесь появятся планы, которые вы соберёте.</p>
      ) : (
        <div style={styles.stack}>
          {planHistory.map((p) => {
            const open = openId === p.id;
            const dateLabel = new Date(p.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
            return (
              <div key={p.id}>
                <button className="chip" onClick={() => { hapticSelect(); setOpenId(open ? null : p.id); }} style={styles.rowChip(false)}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{dateLabel} · {p.storeName}</div>
                    <div style={styles.chipHint}>
                      {p.totalCost != null ? `${p.totalCost.toLocaleString("ru-RU")} ₽` : "без цены"} из {p.budget.toLocaleString("ru-RU")} ₽ · на {p.family} {p.family === 1 ? "человека" : "человек"}
                    </div>
                  </div>
                  <ChevronRight size={16} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
                </button>
                {open && (
                  <div style={styles.historyDetail}>
                    {p.plan?.days?.map((d) => (
                      <div key={d.day} style={styles.historyDay}>
                        <span style={styles.historyDayLabel}>День {d.day}</span>
                        <span>
                          {d.dayMeals.map((dm) => `${dm.emoji || HISTORY_DAY_EMOJI_FALLBACK} ${dm.name}`).join(" · ")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Полноэкранный продающий экран подписки — открывается кнопкой "Перейти на
// Pro" из Аккаунта. Пользователь в чате прямо описал желаемую механику:
// зачёркнутая старая цена рядом с новой (классический якорь цены) + кнопка
// оформления. Сама оплата пока никуда не ведёт по-настоящему — ни один
// провайдер не подключён (см. комментарий у SUBSCRIPTION_BENEFITS выше) —
// нажатие честно говорит "скоро", а не притворяется, что списало деньги.
function ProModal({ onClose }) {
  const [pendingPayment, setPendingPayment] = useState(false);
  const handleSubscribe = () => {
    hapticNotify("warning");
    trackEvent("pro_subscribe_clicked");
    setPendingPayment(true);
  };
  return (
    <div style={styles.modalOverlay} className="modal-overlay-in" onClick={onClose}>
      <div style={styles.modalCard} className="modal-card-in" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} title="Закрыть" aria-label="Закрыть" style={styles.modalClose}>
          <X size={16} />
        </button>

        <div style={styles.proHero}>
          <Sparkles size={32} color={ACCENT} />
        </div>
        <h2 style={{ ...styles.stepTitle, textAlign: "center" }}>Съедим Pro</h2>
        <p style={{ ...styles.stepSub, textAlign: "center" }}>Всё то же самое, что уже работает, — но без ограничений</p>

        <div style={styles.stack}>
          {SUBSCRIPTION_BENEFITS.map((b) => (
            <div key={b.title} style={styles.proFeatureRow}>
              <div style={styles.proFeatureCheck}>
                <Check size={13} color={ACCENT} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{b.title}</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2, lineHeight: 1.4 }}>{b.detail}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={styles.proPriceBox}>
          <div style={styles.proPriceRow}>
            <span style={styles.proPriceOld}>399 ₽</span>
            <span style={styles.proPriceNew}>299 ₽</span>
            <span style={styles.proPricePeriod}>/ мес</span>
          </div>
          {!pendingPayment ? (
            <button onClick={handleSubscribe} style={{ ...styles.navBtnPrimary, width: "100%", justifyContent: "center", marginTop: 12 }}>
              Оформить подписку
            </button>
          ) : (
            <p style={{ ...styles.acctSectionHint, textAlign: "center", margin: "12px 0 0 0" }}>
              Оплата пока не подключена — совсем скоро здесь появится настоящая кнопка оплаты картой. Мы напишем, когда будет готово.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultView({ plan, storeId, storeName, budget, family, mealsCount, diet, allergies, onSwap, onOpenRecipe, onRetryPrices, retryingPrices, priceRetryFailed }) {
  const [orderState, setOrderState] = useState({ status: "idle" }); // idle | loading | error
  // Отделы списка покупок сворачиваемые — по умолчанию все раскрыты (старое
  // поведение не меняется для короткого списка), но для семьи с 3+ приёмами
  // пищи список может стать длинным, и без возможности свернуть "уже
  // понятный" отдел — просто длинная простыня без ориентиров.
  const [collapsedDepts, setCollapsedDepts] = useState(new Set());
  const toggleDept = (name) => {
    hapticSelect();
    setCollapsedDepts((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  // Реальный заказ пока подключён только для ВкусВилл — у них единственных
  // есть официальный MCP с генерацией ссылки на корзину (см.
  // src/lib/vkusvillMcp.js). У остальных сетей такого нет, кнопка для них
  // остаётся неактивной — не потому что забыли, а потому что нечем её
  // подкрепить по-настоящему.
  const canOrderForReal = storeId === "vv";

  // "Нет в наличии" — предложить замену конкретному товару из списка
  // покупок. subs: name -> выбранная замена (переживает несколько открытий
  // панели, копится по мере того, как отмечают несколько товаров).
  // activeItem/panelState — какая ИМЕННО панель сейчас раскрыта и что в ней
  // показывать, отдельно от subs, потому что открыта единовременно только
  // одна, а выбранных замен может быть много одновременно.
  const [subs, setSubs] = useState({});
  const [activeItem, setActiveItem] = useState(null);
  const [panelState, setPanelState] = useState({ status: "idle" }); // idle | loading | loaded | error

  const handleFindSubstitute = async (itemName) => {
    setActiveItem(itemName);
    setPanelState({ status: "loading" });
    try {
      const options = await getSubstituteOptions({ name: itemName, allergies, diet });
      setPanelState(options.length > 0 ? { status: "loaded", options } : { status: "error", message: "Не нашли подходящую замену под ваш рацион/аллергии" });
    } catch (err) {
      setPanelState({ status: "error", message: err.message });
    }
  };
  const chooseSubstitute = (itemName, option) => {
    hapticImpact("medium");
    trackEvent("substitute_used");
    setSubs((prev) => ({ ...prev, [itemName]: option }));
    setActiveItem(null);
  };
  const revertSubstitute = (itemName) => {
    hapticSelect();
    setSubs((prev) => {
      const next = { ...prev };
      delete next[itemName];
      return next;
    });
  };

  // name -> исходная позиция списка покупок (amount/unit/cost) — нужна и
  // для пересчёта итого при замене, и для сборки корзины выше.
  const itemsByName = useMemo(
    () => new Map(plan.grouped.flatMap((g) => g.items).map((it) => [it.name, it])),
    [plan]
  );

  // Сколько единиц товара-замены реально уйдёт в корзину — та же формула,
  // что использует buildCartFromShoppingList при заказе (toVkusvillQuantity),
  // поэтому строка "стоимость замены" здесь и сумма в корзине не расходятся.
  const substituteLineCost = (item, sub) => {
    const qty = toVkusvillQuantity(item.amount, item.unit, sub.productUnit);
    return Math.round(sub.price * qty);
  };

  // "Итого за продукты" из buildPlanView посчитано ДО всех замен — честно
  // пересчитываем здесь: вычитаем цену оригинальной позиции и добавляем
  // цену замены, только для тех строк, где замена реально выбрана. Без
  // итемизированных цен (plan.itemized===false — не-ВкусВилл или сбой
  // ВкусВилл) корректно посчитать дельту нечем, оставляем сумму как есть.
  const adjustedTotal = useMemo(() => {
    if (!plan.itemized) return plan.total;
    let delta = 0;
    for (const [name, sub] of Object.entries(subs)) {
      const item = itemsByName.get(name);
      if (!item) continue;
      delta += substituteLineCost(item, sub) - (item.cost || 0);
    }
    return plan.total + delta;
  }, [plan, subs, itemsByName]);
  const over = adjustedTotal > budget;

  const handleOrder = async () => {
    trackEvent("order_clicked", { store: storeId, substitutions_count: Object.keys(subs).length });
    setOrderState({ status: "loading" });
    try {
      // Товары с выбранной заменой идут в корзину СВОИМ xml_id/ценой
      // (уже знаем их из getSubstituteOptions) — без повторного поиска по
      // названию исходного ингредиента, см. комментарий в resolvePrices.
      const items = interleaveGroups(plan.grouped).map((it) => {
        const sub = subs[it.name];
        return sub
          ? { name: sub.name, amount: it.amount, unit: it.unit, xmlId: sub.xmlId, knownPrice: sub.price, knownUnit: sub.productUnit }
          : { name: it.name, amount: it.amount, unit: it.unit };
      });
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
      hapticNotify("success");
      if (unmatched.length > 0) console.warn("Не нашли в каталоге ВкусВилл:", unmatched);
    } catch (err) {
      setOrderState({ status: "error", message: err.message });
      hapticNotify("error");
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

      {plan.mostlyUnpriced && (
        <div style={styles.warningBox}>
          <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ minWidth: 0 }}>
            <span>
              Не удалось получить цены почти ни на один товар — похоже, у ВкусВилл сейчас перегружен сервис или
              временно превышен лимит запросов на нашей стороне. Сумма ниже недостоверна.
            </span>
            {/* Раньше единственный совет был "соберите план заново" — то есть
                заново пройти весь визард ради того, чтобы попробовать
                получить те же цены ещё раз. Рецепты уже выбраны, дублировать
                весь визард незачем — пробуем получить цены ещё раз на то же
                самое меню. */}
            {onRetryPrices && (
              <button
                onClick={onRetryPrices}
                disabled={retryingPrices}
                style={{ ...styles.retryPricesBtn, opacity: retryingPrices ? 0.6 : 1 }}
              >
                {retryingPrices ? <><Loader2 size={13} className="spin" /> Пробуем ещё раз…</> : "Повторить получение цен"}
              </button>
            )}
            {/* Явная обратная связь на неудачную попытку — раньше кнопка
                просто молча оставляла ту же самую надпись сверху, если
                ВкусВилл всё ещё не отвечал, и выглядело это так, будто
                нажатие вообще ни на что не повлияло. */}
            {priceRetryFailed && !retryingPrices && (
              <p style={{ fontSize: 11.5, marginTop: 6, opacity: 0.85 }}>
                Не получилось — ВкусВилл всё ещё ограничивает запросы. Попробуйте ещё раз через минуту-другую.
              </p>
            )}
          </div>
        </div>
      )}

      <div style={{ ...styles.totalBox, borderColor: over ? "rgba(255,59,48,0.35)" : "rgba(10,132,255,0.3)" }}>
        <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Итого за продукты</span>
        <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.01em", color: over ? DANGER : ACCENT }}>
          {adjustedTotal.toLocaleString("ru-RU")} ₽
        </span>
        <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>из {budget.toLocaleString("ru-RU")} ₽ бюджета</span>
        {plan.itemized && Object.keys(subs).length > 0 && (
          <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
            С учётом {Object.keys(subs).length} {Object.keys(subs).length === 1 ? "замены" : "замен"}
          </span>
        )}
        {plan.itemized && plan.anyUnpriced && !plan.mostlyUnpriced && (
          <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
            Цена не найдена для части товаров — не учтена в сумме
          </span>
        )}
        {!plan.itemized && plan.anyEstimated && (
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
                  {dm.recipe.photoUrl ? (
                    <img src={dm.recipe.photoUrl} alt="" style={styles.recipeThumb} />
                  ) : (
                    <span style={styles.recipeEmoji}>{dm.recipe.emoji}</span>
                  )}
                  <span className="recipe-name-text" style={styles.recipeName}>{dm.recipe.name}</span>
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
                  aria-label={dm.canSwap ? "Заменить блюдо" : "Нет других вариантов под ваши фильтры"}
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
      {canOrderForReal && (
        <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "-4px 0 10px 0" }}>
          Если товара не окажется в наличии на сайте ВкусВилл — нажмите <PackageSearch size={11} style={{ verticalAlign: -1 }} /> рядом с ним, подберём замену
        </p>
      )}
      {plan.grouped.map((g) => {
        const collapsed = collapsedDepts.has(g.name);
        return (
        <div key={g.name} style={{ marginBottom: 14 }}>
          <button onClick={() => toggleDept(g.name)} style={styles.deptLabelBtn}>
            <span style={styles.deptLabel}>{g.name} · {g.items.length}</span>
            <ChevronRight size={13} style={{ color: "var(--text-tertiary)", transform: collapsed ? "rotate(0deg)" : "rotate(90deg)", transition: "transform .15s ease" }} />
          </button>
          {!collapsed && (
          <div style={styles.listBox}>
            {g.items.map((it) => {
              const sub = subs[it.name];
              return (
                <div key={it.name}>
                  <div style={styles.listRow}>
                    <span style={{ minWidth: 0 }}>
                      {sub ? (
                        <>
                          <span style={{ textDecoration: "line-through", color: "var(--text-tertiary)" }}>{it.name}</span>
                          {" → "}{sub.name}
                        </>
                      ) : (
                        it.name
                      )}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      {sub ? (
                        <>
                          <span style={{ color: "var(--text-tertiary)" }}>{substituteLineCost(it, sub).toLocaleString("ru-RU")} ₽</span>
                          <button onClick={() => revertSubstitute(it.name)} title="Отменить замену" aria-label="Отменить замену" style={styles.subRevertBtn}>
                            <X size={13} />
                          </button>
                        </>
                      ) : (
                        <>
                          <span style={{ color: "var(--text-tertiary)" }}>
                            {it.amount} {it.unit}
                            {plan.itemized && it.cost != null && ` · ${it.cost.toLocaleString("ru-RU")} ₽`}
                          </span>
                          {canOrderForReal && (
                            <button onClick={() => handleFindSubstitute(it.name)} title="Нет в наличии — подобрать замену" aria-label="Нет в наличии — подобрать замену" style={styles.subFindBtn}>
                              <PackageSearch size={13} />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {activeItem === it.name && (
                    <div style={styles.subPanel}>
                      {panelState.status === "loading" && (
                        <span style={styles.subPanelHint}><Loader2 size={13} className="spin" /> Ищем замену…</span>
                      )}
                      {panelState.status === "error" && <span style={styles.subPanelHint}>{panelState.message}</span>}
                      {panelState.status === "loaded" && panelState.options.map((opt) => (
                        <button key={opt.xmlId} onClick={() => chooseSubstitute(it.name, opt)} style={styles.subOptionBtn}>
                          {opt.image ? <img src={opt.image} alt="" style={styles.subOptionThumb} /> : <span style={styles.subOptionThumbPlaceholder} />}
                          <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>{opt.name}</span>
                          <span style={{ flexShrink: 0, fontWeight: 600 }}>{opt.price} ₽</span>
                        </button>
                      ))}
                      <button onClick={() => setActiveItem(null)} style={styles.subCancelBtn}>Отмена</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          )}
        </div>
        );
      })}

      <button onClick={() => { trackEvent("share_clicked"); shareViaTelegram(buildShareText(plan, storeName, family), BOT_SHARE_URL); }} style={styles.shareBtn}>
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
        <>
          <button disabled style={{ ...styles.orderBtn, opacity: 0.4, cursor: "default" }} title="Реальный заказ пока подключён только для ВкусВилл">
            Заказать в {storeName} (скоро)
          </button>
          {/* Раньше объяснение "почему" было только в title — на тач-экране
              его никто не видит (нет hover). Пользователь в чате попросил
              видимый текст, но НЕ называть техническую причину ("у ВкусВилл
              есть открытый доступ к каталогу") — это подсказка, что цены
              можно посмотреть напрямую у ВкусВилл в обход приложения. Текст
              ниже называет только факт (какие сети уже поддержаны) без "почему". */}
          <p style={styles.orderNote}>
            Цены и список для {storeName} — ориентировочные. Точные цены и сборка корзины одним кликом пока доступны
            только для ВкусВилл — подключим другие сети по мере возможности.
          </p>
        </>
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
// Раньше собирали ссылку через URLSearchParams — он кодирует пробел как "+"
// (стандарт application/x-www-form-urlencoded), а страница t.me/share/url
// его обратно в пробел не разворачивает: в переданном тексте (там много
// пробелов — переносы строк, отступы у каждого блюда) плюсики вместо
// пробелов буквально появлялись в сообщении (баг из чата). encodeURIComponent
// кодирует пробел как %20 — это понимает любой корректный URL-декодер.
export function buildShareUrl(text, url) {
  let href = `https://t.me/share/url?text=${encodeURIComponent(text)}`;
  if (url) href += `&url=${encodeURIComponent(url)}`;
  return href;
}

function shareViaTelegram(text, url) {
  window.open(buildShareUrl(text, url), "_blank", "noopener,noreferrer");
}

function RecipeModal({ dm, family, onClose }) {
  const { recipe, cost, isRealPrice } = dm;
  return (
    <div style={styles.modalOverlay} className="modal-overlay-in" onClick={onClose}>
      <div style={styles.modalCard} className="modal-card-in" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} title="Закрыть" aria-label="Закрыть" style={styles.modalClose}>
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
  // will-change держит карточку на собственном GPU-слое постоянно (не
  // только в момент форсированного reflow из useEffect выше) — вторая,
  // более "фоновая" защита от той же WebView-проблемы с зависшим кадром.
  card: { width: "100%", maxWidth: 440, ...glass(0.55, 24), borderRadius: 28, border: "1px solid var(--hairline)", padding: 26, boxShadow: "var(--card-shadow)", willChange: "transform" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  brandRow: { display: "flex", alignItems: "center", gap: 9 },
  logoMark: {
    width: 32, height: 32, borderRadius: 9, flexShrink: 0, objectFit: "cover",
    boxShadow: "0 3px 10px rgba(0,0,0,0.25)",
  },
  brand: { fontSize: 19, fontWeight: 700, letterSpacing: "-0.015em" },
  // marginLeft = ширина логотипа (32) + gap строки с ним (9) — раньше
  // приветствие начиналось от самого края (x=0), то есть ровно под
  // логотипом, а с учётом тени логотипа (boxShadow у logoMark) визуально
  // наезжало на неё. Теперь строка начинается под названием "Съедим", а не
  // под иконкой — логотип и текст больше не соседствуют по вертикали.
  greeting: { fontSize: 12, color: "var(--text-tertiary)", marginTop: 2, marginLeft: 41 },
  // height: 32 — та же высота, что у круглой accountBtn (шестерёнки) рядом
  // в шапке: раньше разной высоты пилюля и кружок в одном ряду выглядели
  // рассинхронизированно, хотя обе уже были "стеклянными".
  resetBtn: { display: "flex", alignItems: "center", gap: 5, height: 32, ...glass(0.5, 8), border: "1px solid var(--hairline)", borderRadius: 999, padding: "0 13px", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", cursor: "pointer" },
  accountBtn: { display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, ...glass(0.5, 8), border: "1px solid var(--hairline)", borderRadius: "50%", color: "var(--text-secondary)", cursor: "pointer" },
  // Раньше marginTop:10 — визуально впритык к кнопкам "назад"/"Далее" сразу
  // над ним (у них свой отступ всего 22px сверху, но снизу ничего не было).
  // Увеличил и добавил чуть паддинга — рифмуется с остальными вертикальными
  // интервалами в карточке (18-22px), а не выбивается мелким зазором.
  quickHint: { fontSize: 12, color: "var(--text-tertiary)", textAlign: "center", marginTop: 24, paddingTop: 4, lineHeight: 1.4 },
  inlineLinkBtn: { background: "none", border: "none", padding: 0, color: ACCENT, fontWeight: 600, fontSize: 12, cursor: "pointer", textDecoration: "underline" },
  accountHeaderRow: { display: "flex", alignItems: "center", marginBottom: 2 },
  acctSection: { marginTop: 18 },
  acctSectionTitle: { fontSize: 15, fontWeight: 700, marginBottom: 4 },
  acctSectionHint: { fontSize: 12.5, color: "var(--text-tertiary)", lineHeight: 1.45, margin: "0 0 12px 0" },
  acctLabel: { fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.02em", marginBottom: 8 },
  acctDivider: { height: 1, background: "var(--hairline)", margin: "22px 0" },
  acctClearBtn: { width: "100%", background: "none", border: "none", color: "var(--danger)", fontSize: 12.5, fontWeight: 500, cursor: "pointer", padding: "10px 0 0 0" },
  acctWarnHint: { fontSize: 12, color: "var(--warning-text)", textAlign: "center", marginTop: 8 },
  homeScreenAddedRow: {
    display: "flex", alignItems: "center", gap: 10, padding: "13px 15px", borderRadius: 18,
    border: "1px solid var(--hairline)", ...glass(0.45, 12), fontSize: 13.5, fontWeight: 500, color: "var(--text-secondary)",
  },
  textInput: {
    width: "100%", padding: "12px 14px", borderRadius: 14, border: "1px solid var(--hairline)",
    ...glass(0.45, 10), color: "var(--text-primary)",
    // 16px, не 14 — Safari на iOS зумит страницу при фокусе на инпуте с
    // font-size < 16px, это его собственное поведение, не баг вёрстки; ниже
    // 16 здесь быть не должно, даже если по дизайну хочется мельче.
    fontSize: 16, fontFamily: "inherit",
  },
  mealTimeRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 15px",
    borderRadius: 18, border: "1px solid var(--hairline)", ...glass(0.45, 12), fontSize: 14, fontWeight: 500,
  },
  timeInputWrap: { position: "relative", display: "inline-flex", alignItems: "center" },
  timeInput: {
    border: "1px solid var(--hairline)", borderRadius: 10, padding: "6px 28px 6px 8px", color: "var(--text-primary)",
    background: "transparent", fontSize: 16, fontFamily: "inherit", // 16px — та же причина, что у textInput выше
  },
  // pointerEvents:"none" — иконка декоративная, клик должен пройти сквозь
  // неё на невидимый нативный picker-indicator под ней (см. CSS выше).
  timeInputIcon: { position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" },
  themeChip: (active) => ({
    flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "12px 6px", borderRadius: 16, cursor: "pointer",
    border: active ? "1.5px solid rgba(10,132,255,0.55)" : "1px solid var(--hairline)",
    ...glass(active ? 0.7 : 0.45, 12),
    boxShadow: active ? "0 4px 14px rgba(10,132,255,0.18)" : "none",
    color: active ? ACCENT : "var(--text-secondary)", fontSize: 11.5, fontWeight: 600,
  }),
  subCard: { border: "1px solid var(--hairline)", borderRadius: 20, padding: "16px 16px 18px", ...glass(0.5, 12) },
  freeBadge: { fontSize: 10.5, fontWeight: 700, color: "var(--text-tertiary)", background: "var(--track-bg)", padding: "2px 8px", borderRadius: 999, marginLeft: "auto" },
  proBadge: { fontSize: 10.5, fontWeight: 700, color: "#fff", background: ACCENT, padding: "2px 8px", borderRadius: 999, marginLeft: "auto" },
  historyDetail: { padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 },
  historyDay: { display: "flex", flexDirection: "column", gap: 2, fontSize: 12.5, color: "var(--text-secondary)" },
  historyDayLabel: { fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" },
  proHero: {
    width: 64, height: 64, borderRadius: 20, margin: "0 auto 14px auto", display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(10,132,255,0.12)",
  },
  proFeatureRow: { display: "flex", gap: 10, alignItems: "flex-start" },
  proFeatureCheck: {
    width: 22, height: 22, borderRadius: "50%", flexShrink: 0, marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(10,132,255,0.12)",
  },
  proPriceBox: { marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--hairline)" },
  proPriceRow: { display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8 },
  proPriceOld: { fontSize: 15, color: "var(--text-tertiary)", textDecoration: "line-through" },
  proPriceNew: { fontSize: 28, fontWeight: 700, letterSpacing: "-0.01em" },
  proPricePeriod: { fontSize: 13, color: "var(--text-tertiary)" },
  progressWrap: { marginBottom: 22 },
  progressSegments: { display: "flex", gap: 4 },
  progressSegment: (filled) => ({
    flex: 1, height: 5, borderRadius: 999,
    background: filled ? `linear-gradient(90deg, ${ACCENT}, var(--accent-2))` : "var(--track-bg)",
    transition: "background .25s ease",
  }),
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
  // Раньше — голый текст с иконкой, без фона и рамки: единственный элемент
  // интерфейса без стеклянного оформления, на фоне чипов/кнопок/бейджей
  // вокруг он выглядел "недоделанным". Теперь та же лёгкая стеклянная
  // пилюля, что у remainder кнопок — просто менее контрастная, чем
  // navBtnPrimary ("Далее"), чтобы порядок важности читался однозначно.
  // navBtn и navBtnPrimary раньше отличались не только цветом, но и
  // padding/fontSize/line-height — из-за этого "Назад" и "Далее" в одном и
  // том же ряду визуально были разного размера, хотя должны читаться как
  // пара равнозначных по геометрии кнопок с разным уровнем акцента. Теперь
  // геометрия (padding, fontSize, lineHeight, gap) у обеих идентична,
  // отличается только оформление (фон/рамка/тень) — так пара выглядит
  // единообразно. lineHeight: 1 — иконка (фиксированная высота SVG) и текст
  // (высота строки шрифта, обычно больше самого глифа) центровались по
  // alignItems:"center" каждый по СВОЕЙ высоте box'а, из-за чего текст
  // визуально "плавал" на пиксель-два относительно иконки; line-height:1
  // прижимает высоту текстового box'а к фактической высоте глифов.
  navBtn: {
    display: "flex", alignItems: "center", gap: 4, lineHeight: 1, ...glass(0.4, 8), border: "1px solid var(--hairline)",
    color: "var(--text-secondary)", fontSize: 13.5, fontWeight: 500, cursor: "pointer", padding: "11px 18px", borderRadius: 999,
  },
  navBtnPrimary: { display: "flex", alignItems: "center", gap: 4, lineHeight: 1, background: `linear-gradient(180deg, ${ACCENT}, #0066DB)`, border: "none", color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", padding: "11px 18px", borderRadius: 999, marginLeft: "auto", boxShadow: "0 6px 16px rgba(10,132,255,0.35)" },
  resultHeader: { marginBottom: 14 },
  warningBox: { display: "flex", gap: 8, alignItems: "flex-start", background: "var(--warning-soft)", border: "1px solid var(--warning-border)", borderRadius: 16, padding: "12px 14px", fontSize: 12.5, color: "var(--warning-text)", marginBottom: 14, lineHeight: 1.4 },
  // --warning-text (#8a5a1e, тёмно-коричневый) не переопределяется в тёмной
  // теме (см. :root) — то есть остаётся одним и тем же в обеих темах, поэтому
  // белый текст поверх него безопасен и там, и там, отдельного dark-варианта
  // не нужно.
  retryPricesBtn: {
    display: "flex", alignItems: "center", gap: 6, marginTop: 8, background: "var(--warning-text)", color: "#fff",
    border: "none", borderRadius: 999, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
  },
  totalBox: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "18px 0", border: "1px solid var(--hairline)", borderRadius: 20, marginBottom: 20, ...glass(0.55, 12) },
  sectionTitle: { fontSize: 13, fontWeight: 600, color: "var(--text-tertiary)", margin: "0 0 8px 0" },
  dayBlock: { paddingBottom: 8, marginBottom: 4, borderBottom: "1px solid var(--hairline)" },
  dayTag: { fontSize: 11, fontWeight: 700, color: ACCENT, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.02em" },
  recipeRow: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 14 },
  timeBadge: { display: "flex", alignItems: "center", gap: 3, color: "var(--text-tertiary)", fontSize: 11, flexShrink: 0 },
  swapBtn: (canSwap) => ({ display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", padding: 2, flexShrink: 0, color: ACCENT, cursor: canSwap ? "pointer" : "default", opacity: canSwap ? 0.8 : 0.25 }),
  deptLabelBtn: { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", padding: "4px 0", cursor: "pointer" },
  deptLabel: { fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.02em" },
  listBox: { display: "flex", flexDirection: "column" },
  listRow: { display: "flex", justifyContent: "space-between", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--hairline-2)", fontSize: 13.5 },
  subFindBtn: { display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", padding: 2, color: "var(--text-tertiary)", cursor: "pointer" },
  subRevertBtn: { display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", padding: 2, color: "var(--danger)", cursor: "pointer" },
  subPanel: { display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px 10px", marginBottom: 4, borderRadius: 14, ...glass(0.5, 10), border: "1px solid var(--hairline)" },
  subPanelHint: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-tertiary)" },
  subOptionBtn: { display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "none", border: "1px solid var(--hairline)", borderRadius: 10, padding: "8px 10px", fontSize: 12.5, color: "var(--text-primary)", cursor: "pointer" },
  subOptionThumb: { width: 28, height: 28, borderRadius: 7, objectFit: "cover", flexShrink: 0 },
  subOptionThumbPlaceholder: { width: 28, height: 28, borderRadius: 7, flexShrink: 0, background: "var(--track-bg)" },
  subCancelBtn: { alignSelf: "flex-end", background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 12, cursor: "pointer", padding: "2px 4px" },
  orderBtn: { width: "100%", padding: "14px 0", background: `linear-gradient(180deg, ${ACCENT}, #0066DB)`, border: "none", borderRadius: 18, color: "#fff", fontSize: 14.5, fontWeight: 600, cursor: "pointer", marginTop: 8, boxShadow: "0 8px 20px rgba(10,132,255,0.35)" },
  orderError: { fontSize: 12, color: "var(--danger)", textAlign: "center", marginTop: 8 },
  orderNote: { fontSize: 12, color: "var(--text-tertiary)", textAlign: "center", marginTop: 8, lineHeight: 1.4 },
  shareBtn: { width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "13px 0", ...glass(0.6, 10), border: "1px solid var(--hairline)", borderRadius: 18, color: "var(--text-primary)", fontSize: 14, fontWeight: 600, cursor: "pointer", marginTop: 8 },

  recipeRowBtn: { flex: 1, display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: "4px 2px", borderRadius: 10, textAlign: "left", cursor: "pointer", color: "var(--text-primary)", font: "inherit", minWidth: 0 },
  recipeEmoji: { fontSize: 17, flexShrink: 0, width: 20, textAlign: "center" },
  // Раньше длинные названия (особенно у ВкусВилл — "Тушёные куриные желудки"
  // и длиннее) в тесной строке (иконка + время + цена + кнопка замены на
  // одной линии) расползались на 3-4 строки — нечитаемо. line-clamp режет
  // ровно на 2 строки с многоточием, не трогая сам layout строки.
  recipeName: {
    fontWeight: 500, minWidth: 0,
    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
    overflow: "hidden", wordBreak: "break-word", lineHeight: 1.25,
  },
  recipeThumb: { width: 22, height: 22, borderRadius: 6, objectFit: "cover", flexShrink: 0 },

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
