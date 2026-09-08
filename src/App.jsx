import { useState, useMemo } from "react";
import { ShoppingBasket, Check, ChevronLeft, ChevronRight, Store, Users, Wallet, Salad, ChefHat, Flame, RotateCcw, UtensilsCrossed, Clock, Repeat, Ban, TriangleAlert, X, Loader2, Share2 } from "lucide-react";
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

const STEP_LABELS = ["Магазин", "Семья", "Приёмы пищи", "Бюджет", "Рацион", "Аллергии", "Кухня", "Техника"];

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
function buildInitialPlan(pools, selectedMeals) {
  const idx = { breakfast: 0, main: 0, snack: 0 };
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
      const r = pool[idx[m.category] % pool.length];
      idx[m.category]++;
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

  const ingredMap = {};
  let total = 0;

  let anyEstimated = false;

  const days = planState.days.map((d) => {
    const dayMeals = d.dayMeals.map((slot) => {
      const recipe = RECIPES_BY_ID.get(slot.recipeId);
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
  const [step, setStep] = useState(0);
  const [store, setStore] = useState(null);
  const [family, setFamily] = useState(2);
  const [meals, setMeals] = useState(["lunch", "dinner"]);
  const [budget, setBudget] = useState(4000);
  const [diet, setDiet] = useState(null);
  const [allergies, setAllergies] = useState([]);
  const [cuisines, setCuisines] = useState([]);
  const [devices, setDevices] = useState([]);
  const [done, setDone] = useState(false);
  const [assembling, setAssembling] = useState(false);
  const [planState, setPlanState] = useState(null);
  const [openRecipe, setOpenRecipe] = useState(null);

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

  const canNext = [
    !!store,
    family > 0,
    meals.length > 0,
    budget >= 500,
    !!diet,
    true, // аллергии необязательны — их отсутствие тоже осознанный ответ
    true, // кухня необязательна
    devices.length > 0,
  ];

  // пулы рецептов зависят от рациона/кухни/техники/аллергий — пересчитываются по ходу
  // визарда, а не только один раз при завершении, поэтому «Заменить блюдо» всегда
  // предлагает актуальный и безопасный набор вариантов
  const pools = useMemo(() => buildPools(diet, cuisines, devices, allergies), [diet, cuisines, devices, allergies]);

  // planState хранит только id рецептов по дням — так swapMeal меняет один слот,
  // не трогая остальную неделю и не требуя пересборки с нуля
  const planView = useMemo(() => buildPlanView(planState, pools, family), [planState, pools, family]);

  const handleFinish = () => {
    const selectedMeals = MEALS.filter((m) => meals.includes(m.id));
    const plan = buildInitialPlan(pools, selectedMeals);
    // Небольшая искусственная задержка + skeleton вместо мгновенного скачка —
    // сейчас подбор чисто локальный (мгновенный), но в реальном приложении
    // здесь будет поход за актуальными ценами в магазине, так что честнее
    // сразу приучать интерфейс к "идёт сборка", а не подменять его позже.
    setAssembling(true);
    window.setTimeout(() => {
      setPlanState(plan);
      setDone(true);
      setAssembling(false);
    }, 650);
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

  const reset = () => {
    setStep(0); setStore(null); setFamily(2); setMeals(["lunch", "dinner"]); setBudget(4000);
    setDiet(null); setAllergies([]); setCuisines([]); setDevices([]); setDone(false); setPlanState(null);
    setOpenRecipe(null); setAssembling(false);
  };

  return (
    <div style={styles.page}>
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
        @media (prefers-color-scheme: dark) {
          :root {
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
        * { box-sizing: border-box; }
        .chip { transition: background-color .15s ease, border-color .15s ease, transform .18s cubic-bezier(0.34, 1.56, 0.64, 1); -webkit-tap-highlight-color: transparent; }
        .chip:hover { filter: brightness(1.03); }
        .chip:active { transform: scale(0.97); }
        button { font-family: inherit; }
        .recipe-row-btn:hover .recipe-name-text { text-decoration: underline; text-decoration-color: rgba(10,132,255,0.4); }
        .fade-in-up { animation: fadeInUp .32s cubic-bezier(0.22, 1, 0.36, 1) both; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .modal-overlay-in { animation: overlayIn .2s ease both; }
        @keyframes overlayIn { from { opacity: 0; } to { opacity: 1; } }
        .modal-card-in { animation: modalIn .28s cubic-bezier(0.22, 1, 0.36, 1) both; }
        @keyframes modalIn { from { opacity: 0; transform: scale(0.94) translateY(12px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        .skeleton-bar { border-radius: 12px; background: linear-gradient(90deg, var(--skeleton-base) 25%, var(--skeleton-shine) 37%, var(--skeleton-base) 63%); background-size: 400% 100%; animation: shimmer 1.4s ease infinite; }
        @keyframes shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        input[type="range"] { -webkit-appearance: none; height: 4px; border-radius: 2px; background: var(--track-bg); }
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.04); cursor: pointer; }
      `}</style>

      <div style={styles.card}>
        <div style={styles.header}>
          <div>
            <div style={styles.brandRow}>
              <ShoppingBasket size={22} color={ACCENT} strokeWidth={1.75} />
              <span style={styles.brand}>Список на неделю</span>
            </div>
            {tgFirstName && <div style={styles.greeting}>Привет, {tgFirstName} 👋</div>}
          </div>
          {done && (
            <button onClick={reset} style={styles.resetBtn}>
              <RotateCcw size={14} /> заново
            </button>
          )}
        </div>

        {!done && !assembling && (
          <div style={styles.progressWrap}>
            <div style={styles.progressTrack}>
              <div style={{ ...styles.progressFill, width: `${((step + 1) / STEP_LABELS.length) * 100}%` }} />
            </div>
            <div style={styles.progressLabel}>
              Шаг {step + 1} из {STEP_LABELS.length} · {STEP_LABELS[step]}
            </div>
          </div>
        )}

        {assembling && <SkeletonView />}

        {!done && !assembling && (
          <div style={styles.stepBody}>
            {step === 0 && (
              <StepShell icon={<Store size={20} />} title="Где вам удобно заказывать?" sub="Выберите магазин с доставкой в вашем районе">
                <div style={styles.grid2}>
                  {STORES.map((s) => (
                    <button key={s.id} className="chip" onClick={() => setStore(s.id)} style={styles.storeChip(store === s.id)}>
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      <div style={styles.chipHint}>{s.note}</div>
                    </button>
                  ))}
                </div>
              </StepShell>
            )}

            {step === 1 && (
              <StepShell icon={<Users size={20} />} title="Сколько человек в семье?" sub="Это определит объём продуктов и порции">
                <div style={styles.counterRow}>
                  <button style={styles.counterBtn} onClick={() => setFamily((f) => Math.max(1, f - 1))}>−</button>
                  <div style={styles.counterVal}>{family}</div>
                  <button style={styles.counterBtn} onClick={() => setFamily((f) => Math.min(8, f + 1))}>+</button>
                </div>
                <div style={styles.counterCaption}>{family === 1 ? "человек" : family < 5 ? "человека" : "человек"}</div>
              </StepShell>
            )}

            {step === 2 && (
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

            {step === 3 && (
              <StepShell icon={<Wallet size={20} />} title="Бюджет на неделю" sub={`Сколько готовы потратить на продукты на ${meals.length || 0} ${meals.length === 1 ? "приём пищи в день" : "приёма/приёмов пищи в день"}`}>
                <div style={styles.budgetVal}>{budget.toLocaleString("ru-RU")} ₽</div>
                <input type="range" min={1500} max={15000} step={250} value={budget} onChange={(e) => setBudget(Number(e.target.value))} style={styles.slider} />
                <div style={styles.sliderLabels}><span>1 500 ₽</span><span>15 000 ₽</span></div>
              </StepShell>
            )}

            {step === 4 && (
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

            {step === 5 && (
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

            {step === 6 && (
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

            {step === 7 && (
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

            <div style={styles.navRow}>
              <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} style={{ ...styles.navBtn, visibility: step === 0 ? "hidden" : "visible" }}>
                <ChevronLeft size={16} /> назад
              </button>
              <button
                onClick={() => (step === 7 ? handleFinish() : setStep((s) => s + 1))}
                disabled={!canNext[step]}
                style={{ ...styles.navBtnPrimary, opacity: canNext[step] ? 1 : 0.4 }}
              >
                {step === 7 ? "Собрать список" : "Далее"} <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {done && planView && (
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
    <div style={styles.stepBody} className="fade-in-up">
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
      setOrderState({ status: "idle" });
      if (matchedCount < totalCount) {
        // мягкое уведомление, а не блокирующий alert — корзина всё равно открылась
        console.warn("Не нашли в каталоге ВкусВилл:", unmatched);
      }
    } catch (err) {
      setOrderState({ status: "error", message: err.message });
    }
  };

  return (
    <div style={styles.stepBody} className="fade-in-up">
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

        <div style={styles.modalHero}>{recipe.emoji}</div>

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
    minHeight: "100vh", width: "100%", display: "flex", justifyContent: "center", alignItems: "flex-start",
    background: "var(--page-bg)",
    padding: "40px 16px", fontFamily: FONT, color: "var(--text-primary)",
  },
  card: { width: "100%", maxWidth: 440, ...glass(0.55, 24), borderRadius: 28, border: "1px solid var(--hairline)", padding: 26, boxShadow: "var(--card-shadow)" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  brandRow: { display: "flex", alignItems: "center", gap: 8 },
  brand: { fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em" },
  greeting: { fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 },
  resetBtn: { display: "flex", alignItems: "center", gap: 5, ...glass(0.5, 8), border: "1px solid var(--hairline)", borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", cursor: "pointer" },
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
  shareBtn: { width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "13px 0", ...glass(0.6, 10), border: "1px solid var(--hairline)", borderRadius: 18, color: "var(--text-primary)", fontSize: 14, fontWeight: 600, cursor: "pointer", marginTop: 8 },

  recipeRowBtn: { flex: 1, display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: "4px 2px", borderRadius: 10, textAlign: "left", cursor: "pointer", color: "var(--text-primary)", font: "inherit", minWidth: 0 },
  recipeEmoji: { fontSize: 17, flexShrink: 0, width: 20, textAlign: "center" },

  modalOverlay: { position: "fixed", inset: 0, background: "var(--modal-backdrop)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 },
  modalCard: { width: "100%", maxWidth: 420, maxHeight: "85vh", overflowY: "auto", ...glass(0.9, 30), borderRadius: 28, border: "1px solid var(--hairline)", padding: 26, boxShadow: "var(--modal-shadow)", position: "relative" },
  modalClose: { position: "absolute", top: 16, right: 16, width: 32, height: 32, borderRadius: "50%", border: "1px solid var(--hairline)", background: "rgba(120,120,128,0.16)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--text-primary)" },
  modalHero: { width: "100%", height: 120, borderRadius: 20, background: "linear-gradient(135deg, rgba(10,132,255,0.14), rgba(100,210,255,0.14))", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 56, marginBottom: 16 },
  modalMeta: { display: "flex", gap: 14, fontSize: 13, color: "var(--text-tertiary)", marginBottom: 18, flexWrap: "wrap" },
  stepsList: { margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 8, fontSize: 13.5, lineHeight: 1.5, color: "var(--text-primary)" },
  stepItem: { paddingLeft: 4 },

  skeletonBar: (h, w) => ({ height: h, width: w || "100%", marginBottom: 10 }),
  assemblingCaption: { display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "var(--text-secondary)", marginBottom: 20 },
};
