import { useState, useEffect, useMemo, useRef } from "react";
import { RotateCcw, Settings } from "lucide-react";
import { clearMcpCache } from "./lib/vkusvillMcp.js";
import { attachRealCosts, fetchVkusvillPools } from "./lib/vkusvillRecipes.js";
import { loadProfile, saveProfile, clearProfile } from "./lib/profile.js";
import { loadActivePlanSlots, MAX_PRO_SLOTS, saveActivePlanSlot, setActiveSlotId, genSlotId, removeActivePlanSlot, clearAllActivePlans } from "./lib/activePlan.js";
import { buildPlanView, buildPools, buildInitialPlan } from "./lib/planLogic.js";
import { checkPlanStatus, savePlanToHistory, reportPlanGenerated, submitPlanToBackend, updateMealTimes } from "./lib/backend.js";
import { trackEvent } from "./lib/analytics.js";
import logoUrl from "./assets/logo.svg";
import { hapticImpact, hapticSelect, hapticNotify } from "./lib/haptics.js";
import { promptAddToHomeScreen } from "./lib/homeScreen.js";
import { styles } from "./styles.js";
import { GLOBAL_CSS } from "./globalCss.js";
import { DEFAULT_STORE, DEFAULT_DIET, ALL_DEVICE_IDS, DEFAULT_MEAL_TIMES, STEP_META, QUICK_STEP_KEYS, STORES, MEALS } from "./constants.js";
import { confirmAction } from "./lib/confirmAction.js";
import { isCatalogPlan, assessPlanBuild, canCompletePendingBuild, toHistoryPlan } from "./lib/planBuild.js";
import { DismissibleNote, SkeletonView } from "./components/common.jsx";
import { RecipeModal } from "./components/RecipeModal.jsx";
import { ProModal, ExtraPlanModal } from "./components/ProModals.jsx";
import { LastPlanGateView } from "./components/LastPlanGateView.jsx";
import { LimitBlockedView } from "./components/LimitBlockedView.jsx";
import { WizardView } from "./components/WizardView.jsx";
import { PlanSlotsBar, ResultView } from "./components/ResultView.jsx";
import { AccountView } from "./components/account/AccountView.jsx";
import { usePlanStatus } from "./hooks/usePlanStatus.js";
import { useFamily } from "./hooks/useFamily.js";
import { useHomeScreen } from "./hooks/useHomeScreen.js";
import { useReferral } from "./hooks/useReferral.js";
import { useTheme } from "./hooks/useTheme.js";

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
  // State, а не производное от savedProfile: профиль теперь автосохраняется в
  // конце ПЕРВОЙ успешной сборки (handleFinish) — hasProfile должен стать true
  // сразу, в этой же сессии, иначе reset() ("Новый план") в ней же снова
  // сбросил бы ответы на дефолты и заставил проходить все шаги заново.
  const [hasProfile, setHasProfile] = useState(!!savedProfile);

  // Раньше собранный план жил только в React-состоянии — исчезал при каждом
  // перемонтировании (вышли из Telegram и зашли снова, перезапуск WebView),
  // и единственным способом снова его увидеть было пройти сборку заново
  // (жалоба в чате: "как посмотреть старый план, который я уже собрал").
  // Читаем один раз при монтировании, как и savedProfile выше — если план
  // есть, сразу открываем ResultView, минуя визард целиком; "Заново"
  // (см. reset ниже) явно стирает запись.
  //
  // Живой вывод из ревью Pro-плюшек (чат): "Несколько планов одновременно"
  // рекламировалось как Pro-бонус, а по факту хранился ровно один план —
  // planSlots хранит НАБОР слотов (см. lib/activePlan.js), planSlotId — id
  // слота, который сейчас редактируется/показывается (не обязательно
  // совпадает с activeSlotId в planSlots — тот персистентный указатель, этот
  // локальный "текущий" на время сессии, синхронизируются в паре мест ниже).
  const [planSlots, setPlanSlots] = useState(loadActivePlanSlots); // {slots, activeSlotId}
  const initialActiveSlot = planSlots.slots.find((s) => s.id === planSlots.activeSlotId) ?? null;
  const [planSlotId, setPlanSlotId] = useState(initialActiveSlot?.id ?? null);

  const [step, setStep] = useState(0);
  const [store, setStore] = useState(initialActiveSlot?.store ?? DEFAULT_STORE);
  const [showOtherStores, setShowOtherStores] = useState(false);
  // Когда план собран — нужно для подписей дней ("Сегодня · пт, 2 окт."), см.
  // lib/planDays.js. null у плана, сохранённого до появления этого поля.
  const [planCreatedAt, setPlanCreatedAt] = useState(initialActiveSlot?.createdAt ?? null);
  const [family, setFamily] = useState(savedProfile?.family ?? 2);
  // Необязательные точечные переопределения "Семьи" по приёмам пищи (см.
  // комментарий у buildInitialPlan в planLogic.js) — например, пара, где
  // один ест дома только завтрак и ужин, а второй ещё и обед. Пустой объект
  // (по умолчанию) означает "одинаково для всех приёмов пищи", т.е. прежнее
  // поведение — настройка сознательно "спрятана" в Аккаунте, а не в визарде
  // (см. AccountView), чтобы не усложнять сборку плана тем, кому это не нужно.
  const [familyByMeal, setFamilyByMeal] = useState(savedProfile?.familyByMeal ?? {});
  const [meals, setMeals] = useState(savedProfile?.meals ?? ["lunch", "dinner"]);
  const [budget, setBudget] = useState(initialActiveSlot?.budget ?? 4000);
  const [diet, setDiet] = useState(savedProfile?.diet ?? DEFAULT_DIET);
  const [allergies, setAllergies] = useState(savedProfile?.allergies ?? []);
  // Аллергии — единственный вопрос, где ответ по умолчанию небезопасен (перепроверка
  // UX-аудита 04.10.2026: «Нет, ем всё подряд» было выбрано заранее, человек с
  // аллергией, нажимавший «Далее», получал план без её учёта, и этот ответ сам
  // запоминался в профиль навсегда). Поэтому "ответил или нет" — отдельный флаг:
  // у новичка шаг не пройти, пока он явно не выберет "Аллергий нет" или аллерген.
  const [allergiesAnswered, setAllergiesAnswered] = useState(!!savedProfile);
  const [cuisines, setCuisines] = useState(savedProfile?.cuisines ?? []);
  const [devices, setDevices] = useState(savedProfile?.devices ?? ALL_DEVICE_IDS);
  const [maxCookTime, setMaxCookTime] = useState(savedProfile?.maxCookTime ?? null);
  const [done, setDone] = useState(!!initialActiveSlot);
  const [assembling, setAssembling] = useState(false);
  const [planState, setPlanState] = useState(initialActiveSlot?.planState ?? null);
  const [openRecipe, setOpenRecipe] = useState(null);
  const [showProModal, setShowProModal] = useState(false);
  // "Ещё один план на этой неделе" — разовая дешёвая покупка, ступенька перед
  // полной подпиской (живой вывод из ревью в чате). Отдельный modal, не режим
  // ProModal — цена/текст/сама механика оплаты (product: "extra_plan")
  // достаточно разные, чтобы не городить условную логику внутри одного
  // большого компонента.
  const [showExtraPlanModal, setShowExtraPlanModal] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [displayName, setDisplayName] = useState(savedProfile?.displayName ?? "");
  const [mealTimes, setMealTimes] = useState(savedProfile?.mealTimes ?? DEFAULT_MEAL_TIMES);

  // Тариф и лимит, семья — в хуках (src/hooks/*). Порядок вызовов хуков = порядок
  // их эффектов при запуске: заявка реферала (useReferral ниже) должна уйти
  // раньше синхронизации плана (эффект submitPlanToBackend) — та создаёт строку
  // пользователя на сервере. Проверяется тестом в App.flows.test.jsx.
  const { planStatus, planHistory, limitBlocked, setLimitBlocked, lastPlanGate } =
    usePlanStatus({ showAccount, hasLocalPlanAtMount: !!initialActiveSlot });
  const { familyStatus, familyJoinedNote, setFamilyJoinedNote, familyActionState, handleCreateFamily, handleLeaveFamily, handleToggleFamilyPantry } =
    useFamily({ showAccount });

  const homeScreenStatus = useHomeScreen();

  // "Открыли приложение" — раз за сессию, не при каждом ререндере.
  useEffect(() => {
    trackEvent("app_opened", { has_profile: hasProfile });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { referralStatus, referralNote, setReferralNote } = useReferral({ showAccount });
  // Строка «Запомнили: …» под первым планом — один раз, пока человек её не закроет.
  const [profileNote, setProfileNote] = useState(null);

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

  const [theme, setTheme] = useTheme();

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
    allergies: allergiesAnswered || allergies.length > 0, // нужен ЯВНЫЙ ответ (см. allergiesAnswered)
  };

  // Раньше пересчитывалось на каждое изменение фильтра (useMemo) — теперь
  // пулы для ВкусВилл тянутся живьём из MCP, это асинхронно, поэтому
  // считаются один раз, в момент "Собрать список" (handleFinish), а не
  // реактивно по ходу визарда. До первого нажатия — null, и это ок:
  // planView ниже явно проверяет planState на null раньше, чем тронуть pools.
  const [pools, setPools] = useState(initialActiveSlot?.pools ?? null);
  // Карта ингредиент->цена товара (ВкусВилл) — null для остальных сетей или
  // если реальные рецепты не подтянулись (см. комментарий у buildPlanView).
  const [priceByName, setPriceByName] = useState(initialActiveSlot?.priceByName ?? null);
  const [retryingPrices, setRetryingPrices] = useState(false);
  // План собран "вырожденным" (каталог ВкусВилл не ответил — базовые рецепты
  // и/или нет цен) и НЕ засчитан в бесплатный лимит (04.10.2026: раньше такая
  // сборка сжигала бесплатный план, а у человека на руках был план без цен).
  // Засчитывается только когда получим полноценный (см. handleRetryPrices /
  // повторную сборку). catalogReason — почему каталог не ответил (для экрана и
  // скриншота в поддержку).
  const [generationPending, setGenerationPending] = useState(false);
  const [catalogReason, setCatalogReason] = useState(null);
  // Та же отметка «ждёт засчитывания», но в ref: handleRetryPrices читает её
  // ПОСЛЕ await, когда generationPending из замыкания может быть устаревшим —
  // два повтора цен подряд засчитали бы одну сборку дважды (лишний кредит).
  // Меняется только в markGenerationPending/completeGeneration ниже.
  const generationPendingRef = useRef(false);
  const [priceRetryFailed, setPriceRetryFailed] = useState(false);

  // Снимок СОБРАННОГО плана в историю на сервере (Аккаунт -> «История планов»).
  // Только для полноценных планов: вырожденный (без каталога/цен) в историю не
  // кладём — иначе там оседал "план на 0 ₽ из 4 000 ₽", а серия "недель в
  // бюджете" и "сэкономлено" считали бы его удачей (скриншот пользователя
  // 04.10.2026). view — planView ровно этого плана (см. runFinish).
  const saveCompletedPlanToHistory = (view) => {
    savePlanToHistory({
      storeId: store,
      storeName: STORES.find((s) => s.id === store)?.name || store,
      budget,
      family,
      totalCost: view.total,
      plan: toHistoryPlan(view),
    });
  };

  // Единственные два места, где меняется «засчитана ли сборка». Засчитывание
  // (reportPlanGenerated — списание бесплатного лимита или кредита на сервере)
  // и запись в историю — только через completeGeneration, ровно один раз на
  // сборку: из runFinish для полноценной сборки или из handleRetryPrices, когда
  // вырожденная стала полноценной.
  const markGenerationPending = (reason) => {
    generationPendingRef.current = true;
    setGenerationPending(true);
    setCatalogReason(reason);
  };
  const completeGeneration = (view) => {
    generationPendingRef.current = false;
    setGenerationPending(false);
    setCatalogReason(null);
    reportPlanGenerated();
    saveCompletedPlanToHistory(view);
  };

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
      // Вырожденный план (не засчитан в лимит) стал полноценным: рецепты из
      // каталога ВкусВилл и цены получены — теперь это обычный собранный план,
      // засчитываем его РОВНО ОДИН РАЗ и кладём в историю.
      if (generationPendingRef.current && fresh.size > 0) {
        const view = buildPlanView(planState, pools, family, fresh, familyByMeal);
        if (canCompletePendingBuild({ pools, view })) completeGeneration(view);
      }
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
  const planView = useMemo(() => buildPlanView(planState, pools, family, priceByName, familyByMeal), [planState, pools, family, priceByName, familyByMeal]);

  // Холодный кэш цен на сервере: первая сборка не успевает получить все цены за
  // отведённое время (у ВкусВилла лимит запросов, см. server/src/warmup.js), а
  // сервер при этом продолжает их добирать в фоне (за один круг успевает порядка
  // 15-20 названий, всего их 80-160). Рецепты уже из каталога — а значит, надо
  // просто чуть подождать: повторяем получение цен сами, не заставляя человека
  // нажимать кнопку. Не больше AUTO_PRICE_RETRIES раз за план (около двух минут).
  const AUTO_PRICE_RETRIES = 10;
  const AUTO_PRICE_RETRY_DELAY_MS = 12_000;
  const [autoPriceRetriesUsed, setAutoPriceRetriesUsed] = useState(0);
  const recipesFromCatalogNow = isCatalogPlan(pools);
  const autoPriceRetryPending = done && !!planView?.mostlyUnpriced && recipesFromCatalogNow && autoPriceRetriesUsed < AUTO_PRICE_RETRIES;
  useEffect(() => { setAutoPriceRetriesUsed(0); }, [planSlotId]);
  useEffect(() => {
    if (!autoPriceRetryPending || retryingPrices) return undefined;
    const timer = setTimeout(() => {
      if (document.hidden) return; // в фоне не гоняем, вернётся — следующий круг
      setAutoPriceRetriesUsed((n) => n + 1);
      handleRetryPrices();
    }, AUTO_PRICE_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
    // handleRetryPrices замыкает pools/planState — берём свежую версию на каждый круг
  }, [autoPriceRetryPending, retryingPrices, autoPriceRetriesUsed]); // eslint-disable-line react-hooks/exhaustive-deps


  // "Несколько планов одновременно" — Pro-бонус (см. planSlots выше): можно
  // добавить ещё один слот, пока их меньше MAX_PRO_SLOTS. planStatus===null
  // (бэкенд ещё не ответил/недоступен) — canAddPlanSlot честно false, как и
  // везде в этом файле для "бэкенд опционален".
  const canAddPlanSlot = !!planStatus?.isPro && planSlots.slots.length < MAX_PRO_SLOTS;

  // Best-effort отправка плана на сервер напоминаний — см. lib/backend.js,
  // там же и все причины, по которым это может тихо ничего не сделать
  // (бэкенд не задеплоен, приложение открыто не в Telegram). Срабатывает
  // и повторно при "Заменить блюдо" (planView меняется) — это правильно:
  // сервер должен напоминать про АКТУАЛЬНОЕ блюдо, а не про то, что было
  // до замены.
  useEffect(() => {
    if (done && planView) submitPlanToBackend(planView, mealTimes);
  }, [done, planView, mealTimes]);

  // Локальное сохранение ТЕКУЩЕГО слота плана (см. lib/activePlan.js) —
  // отдельно от бэкенда выше: это не про напоминания, а про то, чтобы при
  // следующем открытии приложения (вышли из Telegram и зашли снова) сразу
  // увидеть свой план, а не визард "собрать новый" (жалоба в чате).
  // Срабатывает на каждое изменение плана — в том числе "Заменить блюдо" и
  // повтор получения цен, чтобы восстановленный план был тем же, что видели
  // последним, а не тем, что было в момент самой первой сборки. planSlotId
  // отсутствует, только пока визард ещё ни разу не финишировал (см.
  // handleFinish/startNewPlanSlot — оба выставляют его одновременно с done).
  useEffect(() => {
    if (done && planState && planSlotId) {
      saveActivePlanSlot({ id: planSlotId, store, budget, planState, pools, priceByName, createdAt: planCreatedAt });
      setActiveSlotId(planSlotId);
      setPlanSlots((prev) => {
        const idx = prev.slots.findIndex((s) => s.id === planSlotId);
        const slot = { id: planSlotId, store, budget, planState, pools, priceByName, createdAt: planCreatedAt };
        const slots = idx >= 0 ? prev.slots.map((s, i) => (i === idx ? slot : s)) : [...prev.slots, slot];
        return { slots, activeSlotId: planSlotId };
      });
    }
  }, [done, planState, pools, priceByName, store, budget, planSlotId, planCreatedAt]);

  // Оболочка над runFinish (аудит 29.09.2026): раньше экран "собираем" включался
  // только ПОСЛЕ ответа checkPlanStatus (без таймаута) — на слабой сети кнопка
  // "Собрать список" молчала, а повторный тап запускал сборку второй раз. Теперь
  // скелетон виден сразу (кнопки уже нет), второй вызов игнорируется, а любая
  // непойманная ошибка не оставляет приложение на вечной загрузке.
  const handleFinish = async () => {
    if (assembling) return;
    setAssembling(true);
    try {
      await runFinish();
    } catch (err) {
      console.error("Сборка плана не удалась:", err);
      hapticNotify("error");
      setAssembling(false);
      trackEvent("app_error", { message: String(err?.message || err).slice(0, 300), source: "handleFinish" });
    }
  };

  const runFinish = async () => {
    // Бесплатный лимит — только если есть у кого спросить (бэкенд задеплоен
    // и мы в Telegram); без него checkPlanStatus() вернёт null и мы честно
    // ничего не блокируем — тот же принцип "бэкенд опционален", что и везде.
    const status = await checkPlanStatus();
    if (status && status.canGenerate === false) {
      hapticNotify("error");
      setAssembling(false);
      setLimitBlocked({ nextResetHint: status.nextResetHint });
      return;
    }
    setLimitBlocked(null);

    const selectedMeals = MEALS.filter((m) => meals.includes(m.id));
    // Защита от пустого плана: у вернувшегося пользователя шаг "Приёмы пищи"
    // в визарде пропускается (см. QUICK_STEP_KEYS) — meals берётся из
    // состояния как есть. Кнопка "Сохранить как профиль" в Аккаунте теперь не
    // даёт СОХРАНИТЬ meals: [], но само состояние meals общее на весь
    // компонент и меняется сразу по клику на чекбоксы — если открыть Аккаунт,
    // снять все галочки и закрыть БЕЗ сохранения (Назад), в live-состоянии
    // meals всё равно останется [] до перезагрузки страницы. Без этой
    // проверки buildInitialPlan тихо собрал бы "план" из 7 пустых дней (цикл
    // по selectedMeals просто ни разу не выполнится, а warnings при этом
    // остаются пустыми — сравните с реальной пустотой пула, которая warnings
    // заполняет) — план выглядел бы "успешным", просто без единого блюда.
    // Найдено при аудите комбинаций, не из жалобы в чате.
    if (selectedMeals.length === 0) {
      hapticNotify("error");
      setAssembling(false);
      setShowAccount(true);
      return;
    }
    const neededCategories = [...new Set(selectedMeals.map((m) => m.category))];

    let resolvedPools;
    let resolvedPriceByName = null;
    let catalogError = null; // почему каталог ВкусВилл не ответил (если не ответил)
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
        catalogError = String(err?.message || err).slice(0, 160);
        resolvedPools = buildPools(diet, cuisines, devices, allergies, maxCookTime);
      }
    } else {
      resolvedPools = buildPools(diet, cuisines, devices, allergies, maxCookTime);
    }

    const newPlanState = buildInitialPlan(resolvedPools, selectedMeals, budget, family, familyByMeal);
    const freshPlanView = buildPlanView(newPlanState, resolvedPools, family, resolvedPriceByName, familyByMeal);
    // Вырожденную сборку не засчитываем и не кладём в историю — см. assessPlanBuild.
    const { degraded, reason } = assessPlanBuild({ store, catalogError, view: freshPlanView });
    setPools(resolvedPools);
    setPriceByName(resolvedPriceByName);
    setPlanState(newPlanState);
    setDone(true);
    setPlanCreatedAt(new Date().toISOString());
    // Самый первый план вообще (ни "Заново", ни "Ещё один план" не заводили
    // planSlotId заранее) — заводим id прямо здесь, иначе автосохранение
    // (эффект выше) не сработает: он ждёт planSlotId вместе с done/planState.
    if (!planSlotId) setPlanSlotId(genSlotId());
    setAssembling(false);
    hapticNotify("success");
    // Именно ЗДЕСЬ, а не в useEffect на submitPlanToBackend ниже — тот
    // срабатывает на КАЖДОЕ изменение planView (открытие с сохранённым
    // планом, замена блюда), а не только на реальную сборку. Раньше учёт
    // лимита был завязан на тот эффект и списывал лимит/кредит от одного
    // открытия приложения (найдено техническим и UX-аудитом 29.09.2026).
    // reportPlanGenerated вызывается РОВНО ОДИН РАЗ за эту сборку.
    if (degraded) {
      markGenerationPending(reason);
      // Причина — в аналитику (сводка админу), чтобы такие случаи не оставались
      // невидимыми: раньше сбой каталога замечали только по жалобам.
      trackEvent("catalog_fallback", { reason: reason.slice(0, 160), store });
    } else {
      completeGeneration(freshPlanView);
    }

    // UX-аудит 29.09.2026: профиль сохранялся ТОЛЬКО кнопкой "Сохранить как
    // профиль" в самом низу Аккаунта — почти никто её не находил, и каждый
    // "Заново" превращался в те же 9 шагов и 12 тапов вместо 4. Теперь первая
    // успешная сборка сохраняет ответы сама (только если профиля ещё нет —
    // чужой уже сохранённый не перезаписываем). diet и meals — те же условия,
    // что у ручной кнопки: без них профиль бесполезен.
    if (!hasProfile && diet && meals.length > 0) {
      saveProfile({ family, familyByMeal, meals, diet, allergies, cuisines, devices, displayName, mealTimes, maxCookTime });
      setHasProfile(true);
      setProfileNote(
        `${family} ${family === 1 ? "человек" : family < 5 ? "человека" : "человек"} · ${meals.length} ${meals.length === 1 ? "приём" : "приёма"} пищи в день · ${allergies.length > 0 ? `аллергии: ${allergies.length}` : "аллергий нет"}`
      );
      trackEvent("profile_auto_saved");
    }

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

  // "Заново" — начать новый план ВЗАМЕН текущего (тот же слот, planSlotId не
  // меняется — если визард будет заброшен на середине, старый план слота
  // никуда не денется: перезапишется, только когда handleFinish реально
  // досчитает новый, не раньше). Если есть сохранённый профиль, семья/приёмы
  // пищи/рацион/аллергии/кухня/техника НЕ сбрасываются на дефолт — они и
  // так уже верные (в этом весь смысл профиля), сбрасывается только то, что
  // специфично для конкретной прошлой сборки: магазин, бюджет и сам план.
  const reset = () => {
    hapticImpact("light");
    setStep(0); setStore(DEFAULT_STORE); setBudget(4000); setDone(false); setPlanState(null);
    setOpenRecipe(null); setAssembling(false); setPools(null); setPriceByName(null); setPlanCreatedAt(null);
    if (!hasProfile) {
      setFamily(2); setFamilyByMeal({}); setMeals(["lunch", "dinner"]); setDiet(DEFAULT_DIET);
      setAllergies([]); setAllergiesAnswered(false); setCuisines([]); setDevices(ALL_DEVICE_IDS); setMaxCookTime(null);
    }
  };

  // UX-аудит 29.09.2026: лимит проверялся только в самом конце визарда —
  // человек нажимал "Заново", проходил все шаги и лишь потом узнавал, что
  // новый план недоступен (а старый к тому времени уже стёрт с экрана).
  // Теперь спрашиваем сервер ДО сброса: если нельзя — показываем экран
  // лимита, план остаётся на месте, "Назад" возвращает к нему.
  const handleNewPlan = async () => {
    hapticImpact("light");
    const status = await checkPlanStatus();
    if (status && status.canGenerate === false) {
      hapticNotify("error");
      setLimitBlocked({ nextResetHint: status.nextResetHint });
      return;
    }
    // Pro: "Новый план" ЗАМЕНЯЕТ текущий слот — предупреждаем и подсказываем
    // "Ещё план", который добавляет рядом, не стирая (UX-аудит 29.09.2026).
    if (planStatus?.isPro && planSlotId) {
      const hint = canAddPlanSlot ? " Чтобы сохранить текущий, нажмите «Ещё план» — он добавится отдельно." : "";
      if (!(await confirmAction(`Текущий план будет заменён новым.${hint} Заменить?`))) return;
    }
    reset();
  };

  // Живой вывод из ревью Pro-плюшек: "Несколько планов одновременно" — Pro
  // может держать до MAX_PRO_SLOTS планов и переключаться между ними, не
  // теряя ни один (в отличие от "Заново" выше, которое всегда заменяет
  // ОДИН и тот же слот). applySlotToState — общая часть switchToSlot и
  // removeSlot (переключение на другой слот после удаления текущего).
  function applySlotToState(slot) {
    setPlanSlotId(slot?.id ?? null);
    setStore(slot?.store ?? DEFAULT_STORE);
    setPlanCreatedAt(slot?.createdAt ?? null);
    setBudget(slot?.budget ?? 4000);
    setPlanState(slot?.planState ?? null);
    setPools(slot?.pools ?? null);
    setPriceByName(slot?.priceByName ?? null);
    setDone(!!slot);
    setStep(0); setAssembling(false); setOpenRecipe(null);
  }

  const switchToSlot = (id) => {
    const slot = planSlots.slots.find((s) => s.id === id);
    if (!slot || id === planSlotId) return;
    hapticSelect();
    applySlotToState(slot);
    setActiveSlotId(id);
    setPlanSlots((prev) => ({ ...prev, activeSlotId: id }));
    trackEvent("plan_slot_switched");
  };

  const removeSlot = (id) => {
    hapticImpact("light");
    removeActivePlanSlot(id);
    const slots = planSlots.slots.filter((s) => s.id !== id);
    const activeSlotId = planSlots.activeSlotId === id ? (slots[0]?.id ?? null) : planSlots.activeSlotId;
    setPlanSlots({ slots, activeSlotId });
    if (planSlotId === id) {
      applySlotToState(slots.find((s) => s.id === activeSlotId) ?? null);
    }
    trackEvent("plan_slot_removed");
  };

  // "Ещё один план" — в отличие от "Заново", НЕ трогает текущий слот, а
  // заводит новый id заранее (до первой сборки) — handleFinish просто
  // сохраняет результат под ним, ничего не зная про "новый это слот или
  // пересборка старого". Доступность (canAddPlanSlot) проверяется в JSX —
  // здесь предполагается, что кнопку уже не показали бы, если нельзя.
  const startNewPlanSlot = () => {
    hapticImpact("light");
    setPlanSlotId(genSlotId());
    setStep(0); setStore(DEFAULT_STORE); setBudget(4000); setDone(false); setPlanState(null);
    setOpenRecipe(null); setAssembling(false); setPools(null); setPriceByName(null); setPlanCreatedAt(null);
    trackEvent("plan_slot_add_started");
  };

  // UX-аудит 29.09.2026: из визарда назад к своему плану было не вернуться
  // ("Назад" на первом шаге скрыт) — только перезапуском приложения. Сохранённый
  // слот при "Новом плане" никуда не девается, так что просто открываем его
  // снова: тот же слот (замена плана) или активный (если начали "Ещё план").
  const planToReturnTo = planSlots.slots.find((s) => s.id === planSlotId) ?? planSlots.slots.find((s) => s.id === planSlots.activeSlotId) ?? null;
  const handleBackToPlan = () => {
    if (!planToReturnTo) return;
    hapticImpact("light");
    applySlotToState(planToReturnTo);
    setActiveSlotId(planToReturnTo.id);
    setPlanSlots((prev) => ({ ...prev, activeSlotId: planToReturnTo.id }));
  };

  const handleSaveProfile = () => {
    hapticNotify("success");
    saveProfile({ family, familyByMeal, meals, diet, allergies, cuisines, devices, displayName, mealTimes, maxCookTime });
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
    // Все слоты плана тоже завязаны на профиль (техника/аллергии/рацион, под
    // которые они собирались) — оставлять их при полном сбросе профиля
    // значило бы после сброса всё равно увидеть старые планы, будто ничего
    // не изменилось. Полный сброс (не "Заново" — тот трогает только один
    // слот, см. reset()).
    clearAllActivePlans();
    // после сброса про профиль приложение узнает заново только при перезагрузке
    // (hasProfile вычислен один раз при монтировании) — это ок, простое и
    // предсказуемое поведение, не тянет за собой сложную ре-синхронизацию стейта
    window.location.reload();
  };

  return (
    <div style={styles.page} className="mp-page">
      <style>{GLOBAL_CSS}</style>

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
              <button onClick={handleNewPlan} style={styles.resetBtn}>
                <RotateCcw size={14} /> Новый план
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

        {referralNote && !showAccount && (
          <DismissibleNote onClose={() => setReferralNote(false)}>
            Бонус за приглашение действует только для тех, кто открывает «Съедим» впервые, — вы уже пользовались приложением.
          </DismissibleNote>
        )}

        {familyJoinedNote && !showAccount && (
          <DismissibleNote onClose={() => setFamilyJoinedNote(false)}>
            Вы вступили в семью: отметки «уже есть дома» в списке покупок теперь общие. Состав семьи — в{" "}
            <button onClick={() => { setFamilyJoinedNote(false); setShowAccount(true); }} style={styles.inlineLinkBtn}>Аккаунте</button>.
          </DismissibleNote>
        )}

        {showAccount && (
          <AccountView
            displayName={displayName} setDisplayName={setDisplayName}
            theme={theme} setTheme={setTheme}
            family={family} setFamily={setFamily}
            familyByMeal={familyByMeal} setFamilyByMeal={setFamilyByMeal}
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
            referralStatus={referralStatus}
            familyStatus={familyStatus}
            familyActionState={familyActionState}
            onCreateFamily={handleCreateFamily}
            onLeaveFamily={handleLeaveFamily}
          />
        )}

        {!showAccount && limitBlocked && (
          <LimitBlockedView
            nextResetHint={limitBlocked.nextResetHint}
            done={done}
            onOpenExtraPlan={() => setShowExtraPlanModal(true)}
            onOpenPro={() => setShowProModal(true)}
            onBack={() => setLimitBlocked(null)}
          />
        )}

        {!showAccount && !limitBlocked && !done && lastPlanGate && (
          <LastPlanGateView
            latest={lastPlanGate.latest}
            nextResetHint={lastPlanGate.status?.nextResetHint}
            onOpenPro={() => { hapticImpact("light"); trackEvent("pro_modal_opened", { source: "last_plan_gate" }); setShowProModal(true); }}
            onOpenExtraPlan={() => { hapticImpact("light"); trackEvent("extra_plan_modal_opened", { source: "last_plan_gate" }); setShowExtraPlanModal(true); }}
          />
        )}

        {!showAccount && !limitBlocked && !lastPlanGate && !done && !assembling && (
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

        {!showAccount && !limitBlocked && !lastPlanGate && assembling && <SkeletonView />}

        {!showAccount && !limitBlocked && !lastPlanGate && !done && !assembling && (
          <WizardView
            currentStepKey={currentStepKey}
            hasProfile={hasProfile}
            showOtherStores={showOtherStores}
            store={store}
            setStore={setStore}
            setShowOtherStores={setShowOtherStores}
            setFamily={setFamily}
            family={family}
            toggleSimple={toggleSimple}
            meals={meals}
            setMeals={setMeals}
            budget={budget}
            setBudget={setBudget}
            setDiet={setDiet}
            diet={diet}
            setAllergies={setAllergies}
            setAllergiesAnswered={setAllergiesAnswered}
            allergiesAnswered={allergiesAnswered}
            allergies={allergies}
            step={step}
            planToReturnTo={planToReturnTo}
            handleBackToPlan={handleBackToPlan}
            setStep={setStep}
            activeSteps={activeSteps}
            handleFinish={handleFinish}
            canNextByKey={canNextByKey}
            setShowAccount={setShowAccount}
          />
        )}

        {!showAccount && !limitBlocked && !assembling && done && planView && (
          <PlanSlotsBar
            slots={planSlots.slots}
            activeId={planSlotId}
            onSwitch={switchToSlot}
            onRemove={removeSlot}
            onAdd={startNewPlanSlot}
            canAdd={canAddPlanSlot}
          />
        )}

        {profileNote && !showAccount && !limitBlocked && !assembling && done && planView && (
          <DismissibleNote onClose={() => setProfileNote(null)}>
            Запомнили: {profileNote}. В следующий раз спросим только магазин и бюджет. Изменить — в{" "}
            <button onClick={() => setShowAccount(true)} style={styles.inlineLinkBtn}>Аккаунте</button>.
          </DismissibleNote>
        )}

        {!showAccount && !limitBlocked && !assembling && done && planView && (
          <ResultView
            plan={planView}
            onRebuild={handleFinish}
            generationPending={generationPending}
            catalogReason={catalogReason}
            planStartISO={planCreatedAt}
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
            autoPriceRetryPending={autoPriceRetryPending}
            familyPaused={!!familyStatus?.inFamily && familyStatus.active === false}
            familyPantryNames={familyStatus?.inFamily && familyStatus.active !== false ? familyStatus.pantryNames : null}
            onToggleFamilyPantry={familyStatus?.inFamily && familyStatus.active !== false ? handleToggleFamilyPantry : null}
          />
        )}
      </div>

      {openRecipe && (
        <RecipeModal dm={openRecipe} family={openRecipe.family ?? family} onClose={() => setOpenRecipe(null)} />
      )}
      {showProModal && <ProModal onClose={() => setShowProModal(false)} />}
      {showExtraPlanModal && (
        <ExtraPlanModal
          onClose={() => setShowExtraPlanModal(false)}
          onOpenPro={() => { setShowExtraPlanModal(false); trackEvent("pro_modal_opened", { source: "extra_plan_modal" }); setShowProModal(true); }}
        />
      )}
    </div>
  );
}

// Публичный экспорт сохранён: его импортирует src/App.share.test.js.
export { buildShareUrl } from "./lib/share.js";
