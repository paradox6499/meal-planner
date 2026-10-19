// Экран готового плана и переключатель слотов планов.

import { useState, useEffect, useMemo } from "react";
import { X, Plus, TriangleAlert, Loader2, ChevronRight, Repeat, Home, PackageSearch, Share2, Info } from "lucide-react";
import { toVkusvillQuantity, buildCartFromShoppingList } from "../lib/vkusvillMcp.js";
import { getSubstituteOptions } from "../lib/vkusvillRecipes.js";
import { findTodayDayIndex, describePlanDay } from "../lib/planDays.js";
import { DayStrip, dayBlockId } from "./DayStrip.jsx";
import { NUTRITION_DIETS, isNutritionDiet, countDietMismatches } from "../lib/nutrition.js";
import { interleaveGroups } from "../lib/planLogic.js";
import { loadPantryStaples, savePantryStaples } from "../lib/pantry.js";
import { trackEvent } from "../lib/analytics.js";
import { hapticSelect, hapticImpact, hapticNotify } from "../lib/haptics.js";
import { styles, DANGER, ACCENT } from "../styles.js";
import { STORES } from "../constants.js";
import { mealsPerDayLabel } from "../lib/format.js";
import { shareViaTelegram, buildShareText, BOT_SHARE_URL } from "../lib/share.js";

// Живой вывод из ревью Pro-плюшек (чат): "Несколько планов одновременно" —
// раньше активен был ровно один план, "заново" стирал предыдущий безвозвратно.
// Строка переключения планов над списком покупок — по одному чипу на слот
// (магазин + бюджет, чтобы отличать план от плана без открытия каждого),
// крестик убирает слот, "+ Ещё план" виден только Pro и только пока слотов
// меньше MAX_PRO_SLOTS. Ничего не показываем, если план всего один и
// добавить ещё нельзя — не нагружаем экран лишним UI ради unlikely случая.
export function PlanSlotsBar({ slots, activeId, onSwitch, onRemove, onAdd, canAdd }) {
  if (slots.length <= 1 && !canAdd) return null;
  return (
    <div style={styles.planSlotsBar}>
      {slots.map((s) => (
        <button key={s.id} className="chip" onClick={() => onSwitch(s.id)} style={styles.planSlotChip(s.id === activeId)}>
          <span>
            {STORES.find((st) => st.id === s.store)?.name || "План"}
            {s.budget > 0 ? ` · ${Number(s.budget).toLocaleString("ru-RU")} ₽` : ""}
          </span>
          {slots.length > 1 && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Удалить этот план"
              onClick={(e) => { e.stopPropagation(); onRemove(s.id); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onRemove(s.id); } }}
              style={styles.planSlotRemove}
            >
              <X size={11} />
            </span>
          )}
        </button>
      ))}
      {canAdd && (
        <button className="chip" onClick={onAdd} style={styles.planSlotAddChip}>
          <Plus size={13} /> Ещё план
        </button>
      )}
    </div>
  );
}

export function ResultView({ plan, planStartISO, onRebuild, generationPending, catalogReason, storeId, storeName, budget, family, mealsCount, diet, allergies, onSwap, onOpenRecipe, onRetryPrices, retryingPrices, priceRetryFailed, autoPriceRetryPending, familyPaused, familyPantryNames, onToggleFamilyPantry }) {
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
  // Каталог ВкусВилл не ответил при сборке плана -> handleFinish тихо
  // откатился на статические рецепты (их id без префикса "vv-"). Раньше
  // пользователь этого не видел: плашка винила только цены, итог показывал
  // "0 ₽", а "Заказать" оставалась активной (UX-аудит 29.09.2026).
  const fallbackRecipes = canOrderForReal && plan.days.some((d) => d.dayMeals.some((dm) => !String(dm.recipe.id).startsWith("vv-")));
  // Без настоящих цен корзину во ВкусВилл не собрать — кнопка заказа ждёт их.
  const noRealPrices = plan.mostlyUnpriced || (fallbackRecipes && !plan.itemized);
  const orderBlocked = canOrderForReal && noRealPrices;

  // Открыли план на 3-й день — сразу прокручиваем к сегодняшнему дню, а не к
  // началу (UX-аудит 29.09.2026: "день 1..7" без подсветки сегодняшнего).
  // Один раз при монтировании; для свежесобранного плана (сегодня = день 1)
  // не трогаем прокрутку.
  useEffect(() => {
    if (findTodayDayIndex(planStartISO, plan.days) > 0) {
      document.getElementById(dayBlockId(plan.days[findTodayDayIndex(planStartISO, plan.days)].day))?.scrollIntoView({ block: "start" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при первом показе экрана плана
  }, []);

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

  // "Уже есть дома" (см. lib/pantry.js) — единый набор названий, ПЕРЕЖИВАЕТ
  // переход на следующую неделю (в отличие от subs/substitutions выше,
  // которые относятся только к ЭТОМУ плану). Читаем один раз при монтировании
  // ResultView — если ингредиент из набора снова попал в список покупок этой
  // недели, он будет отмечен сразу; отметить/снять можно прямо в списке.
  const [pantryStaples, setPantryStaples] = useState(loadPantryStaples);
  useEffect(() => {
    savePantryStaples(pantryStaples);
  }, [pantryStaples]);

  // "Общий список на семью" — живой вывод из ревью в чате: раньше
  // рекламировался, а по факту не было ни общего списка, ни синхронизации
  // между аккаунтами вообще. familyPantryNames — общий набор с сервера (см.
  // App.jsx: familyStatus.pantryNames), null — не состоит в семье, тогда
  // ничего не подмешиваем, поведение как раньше. Сервер — источник истины
  // для ОБЩИХ позиций: то, что отметил кто-то из семьи, подмешивается в
  // локальный набор (не заменяет его целиком — свои личные "уже есть дома"
  // до вступления в семью не должны пропасть).
  useEffect(() => {
    if (!familyPantryNames) return;
    setPantryStaples((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const name of familyPantryNames) {
        if (!next.has(name)) { next.add(name); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [familyPantryNames]);

  const toggleHaveAlready = (itemName) => {
    hapticSelect();
    const nowPresent = !pantryStaples.has(itemName);
    setPantryStaples((prev) => {
      const next = new Set(prev);
      if (nowPresent) next.add(itemName);
      else next.delete(itemName);
      return next;
    });
    // Пуш в общий список семьи (best-effort, см. App.jsx:handleToggleFamilyPantry) —
    // ТОЛЬКО когда реально состоим в семье (проп передаётся null иначе,
    // см. App.jsx), локальное поведение вне семьи не меняется ни на йоту.
    onToggleFamilyPantry?.(itemName, nowPresent);
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
    // Цены почти не получены: итемизированная сумма близка к нулю и вводит в
    // заблуждение ("0 ₽" читается как "бесплатно") — показываем оценку по
    // рецептам с пометкой "≈" (см. total ниже).
    if (plan.mostlyUnpriced) return plan.estimatedTotal;
    if (!plan.itemized) return plan.total;
    let delta = 0;
    for (const [name, sub] of Object.entries(subs)) {
      const item = itemsByName.get(name);
      if (!item) continue;
      delta += substituteLineCost(item, sub) - (item.cost || 0);
    }
    // "Уже есть дома" — эту позицию не нужно покупать, вычитаем её цену из
    // итого. Замена и "уже есть" взаимоисключающие в UI (см. рендер списка
    // ниже) — но на случай рассинхрона (например отметили "уже есть", пока
    // была открыта панель замены) не даём вычесть дважды за одну и ту же строку.
    for (const it of itemsByName.values()) {
      if (pantryStaples.has(it.name) && !subs[it.name]) delta -= it.cost || 0;
    }
    return plan.total + delta;
  }, [plan, subs, itemsByName, pantryStaples]);
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
      const { links, matchedCount, totalCount, unmatched } = await buildCartFromShoppingList(items);
      // Первая ссылка открывается сразу этим же кликом — открыть её ПОЗЖЕ
      // отдельным вызовом window.open() без прямого пользовательского жеста
      // почти наверняка заблокирует браузер как всплывающее окно. Остальные
      // (если список длиннее 20 позиций — см. CART_LINK_LIMIT в vkusvillMcp.js)
      // пользователь открывает сам по очереди кнопками ниже — по той же причине:
      // несколько window.open() подряд в цикле блокируются почти везде,
      // кроме самого первого.
      window.open(links[0], "_blank", "noopener,noreferrer");
      // Раньше при неполном совпадении это уходило только в console.warn —
      // пользователь открывал корзину и молча недосчитывался части товаров,
      // не понимая почему.
      const note = matchedCount < totalCount ? `В корзину добавлено ${matchedCount} из ${totalCount} товаров. Часть не нашлась в каталоге — докупите её отдельно.` : null;
      setOrderState({ status: "idle", note, links });
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
        <p style={styles.stepSub}>{mealsCount} {mealsPerDayLabel(mealsCount)} · {storeName} · на {family} {family === 1 ? "человека" : "человек"}</p>
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

      {/* ОДНА плашка про сбой каталога (перепроверка UX-аудита 04.10.2026: две жёлтые
          плашки подряд, вторая на техническом языке и с кнопкой, лечащей не то).
          Что делать: "Собрать заново" — рецепты из каталога; "Повторить получение
          цен" — только если рецепты уже настоящие, а цен нет. */}
      {fallbackRecipes && (
        <div style={styles.warningBox}>
          <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ minWidth: 0 }}>
            <span>
              {plan.itemized && !plan.mostlyUnpriced
                ? "Каталог ВкусВилл не отвечал при сборке — показан базовый набор рецептов. Цены на продукты уже настоящие."
                : "ВкусВилл сейчас не отвечает — показали базовые рецепты с примерной ценой. Заказ во ВкусВилл откроется, когда каталог заработает."}
            </span>
            {generationPending && (
              <p style={{ fontSize: 13, margin: "6px 0 0 0", opacity: 0.9 }}>Бесплатный план при этом не тратится.</p>
            )}
            {onRebuild && (
              <button onClick={onRebuild} style={styles.retryPricesBtn}>
                Собрать заново с каталогом ВкусВилл
              </button>
            )}
            {priceRetryFailed && !retryingPrices && (
              <p style={{ fontSize: 13, marginTop: 6, opacity: 0.85 }}>
                Не получилось — каталог всё ещё недоступен. Попробуйте ещё раз через минуту-другую.
              </p>
            )}
          </div>
        </div>
      )}

      {plan.mostlyUnpriced && !fallbackRecipes && (
        <div style={styles.warningBox}>
          <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ minWidth: 0 }}>
            <span>
              {autoPriceRetryPending
                ? "Цены на товары ещё загружаются — это может занять до пары минут, повторим сами; можно и не ждать. Сумма ниже пока — оценка по рецептам."
                : "Не удалось получить цены на товары — ВкусВилл сейчас не отвечает. Сумма ниже — оценка по рецептам, заказ откроется, когда цены появятся."}
            </span>
            {generationPending && (
              <p style={{ fontSize: 13, margin: "6px 0 0 0", opacity: 0.9 }}>Бесплатный план при этом не тратится.</p>
            )}
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
              <p style={{ fontSize: 13, marginTop: 6, opacity: 0.85 }}>
                Не получилось — ВкусВилл всё ещё ограничивает запросы. Попробуйте ещё раз через минуту-другую.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Не путать с mostlyUnpriced выше — та про "почти всё не нашлось",
          эта про отдельные блюда: у части рецептов не набралось достаточно
          совпадений по ингредиентам в каталоге, чтобы доверять их цене
          (см. attachRealCosts в vkusvillRecipes.js). У таких блюд ниже стоит
          "—" вместо цены — раньше вместо этого молча показывался 0 ₽,
          выглядевший как "блюдо бесплатное" (жалоба в чате: "все блюда и
          итог по нулям"). Не дублируем предупреждение, если mostlyUnpriced
          уже объяснил ситуацию целиком. */}
      {plan.anyDishUnpriced && !plan.mostlyUnpriced && (
        <div style={styles.warningBox}>
          <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            У части блюд не нашлась цена в каталоге ВкусВилл — отмечены «—» вместо стоимости. Остальная сумма и список покупок посчитаны как обычно.
          </span>
        </div>
      )}

      <div style={{ ...styles.totalBox, borderColor: over ? "rgba(255,59,48,0.35)" : "rgba(10,132,255,0.3)" }}>
        <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Итого за продукты{noRealPrices ? " (оценка)" : ""}</span>
        <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.01em", color: over ? DANGER : ACCENT }}>
          {noRealPrices ? "≈ " : ""}{adjustedTotal.toLocaleString("ru-RU")} ₽
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
        {/* Та же подпись, что на шаге "Бюджет" визарда, но здесь уместнее —
            когда цифра реально красная, а не заранее на всякий случай. Кто-то
            видит этот экран, вообще пропустив шаг бюджета (вернувшийся
            пользователь с сохранённым профилем — короткий визард). */}
        {over && (
          <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4, textAlign: "center" }}>
            Уложиться точно в бюджет не вышло — среди рецептов под ваши фильтры не нашлось достаточно дешёвых вариантов
          </span>
        )}
      </div>

      {/* Диета по КБЖУ считается только по каталогу ВкусВилл и только там, где подходящих рецептов хватило: честно
          говорим, если часть блюд ей не соответствует (или магазин вообще не ВкусВилл). */}
      {isNutritionDiet(diet) && !fallbackRecipes && (() => {
        const { mismatched, total } = countDietMismatches(plan.days, diet);
        if (mismatched === 0) return null;
        const name = NUTRITION_DIETS[diet].label;
        const text = storeId !== "vv"
          ? `Диета «${name}» считается по КБЖУ каталога ВкусВилл, поэтому для этого магазина подобран обычный набор блюд.`
          : mismatched === total
            ? `Рецептов, подходящих под диету «${name}», не нашлось — показали обычные блюда.`
            : `${mismatched} из ${total} блюд не подходят под диету «${name}» по КБЖУ: подходящих рецептов в каталоге оказалось мало (чаще всего это завтраки и перекусы).`;
        return (
          <div style={styles.warningBox}>
            <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{text}</span>
          </div>
        );
      })()}

      <h3 style={styles.sectionTitle}>Рецепты на неделю</h3>
      <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "-4px 0 10px 0" }}>
        Нажмите на блюдо, чтобы посмотреть рецепт
      </p>
      {/* Секция целиком (полоса + дни): липкая полоса держится только пока видны рецепты, не наезжает на список покупок. */}
      <div>
      <DayStrip days={plan.days} planStartISO={planStartISO} />
      <div style={styles.stack}>
        {plan.days.map(({ day, dayMeals }, dayIndex) => {
          const info = describePlanDay(planStartISO, day);
          return (
          <div
            key={day}
            id={dayBlockId(day)}
            data-day={day}
            style={{ ...styles.dayBlock, scrollMarginTop: 86, opacity: info?.isPast ? 0.6 : 1 }}
          >
            <div style={{ ...styles.dayTag, ...(info?.isToday ? styles.dayTagToday : null) }}>{info ? info.label : `День ${day}`}</div>
            {dayMeals.map((dm, i) => (
              <div key={i} style={styles.recipeRow}>
                {/* Название блюда — своей строкой на всю ширину, время и цена
                    под ним (UX-аудит 29.09.2026: в одной строке с приёмом
                    пищи, временем, ценой и кнопкой замены названия резались
                    до ~10 символов). */}
                <button onClick={() => onOpenRecipe(dm)} title="Открыть рецепт" className="recipe-row-btn" style={styles.recipeRowBtn}>
                  {dm.recipe.photoUrl ? (
                    <img src={dm.recipe.photoUrl} alt="" style={styles.recipeThumb} />
                  ) : (
                    <span style={styles.recipeEmoji}>{dm.recipe.emoji}</span>
                  )}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="recipe-name-text" style={styles.recipeName}>{dm.recipe.name}</span>
                    {/* cost===null — ВкусВилл не нашёл в каталоге достаточно
                        ингредиентов блюда, чтобы доверять цене (см.
                        attachRealCosts в vkusvillRecipes.js) — честное "—",
                        а не 0 ₽, которое выглядело бы как "блюдо бесплатное". */}
                    <span style={styles.recipeMeta}>
                      {dm.mealLabel} · {dm.recipe.time} мин · {dm.cost == null ? "—" : `${(dm.cost * (dm.family ?? family)).toLocaleString("ru-RU")} ₽`}
                    </span>
                  </span>
                  <ChevronRight size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                </button>
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
          );
        })}
      </div>
      </div>

      <h3 style={styles.sectionTitle}>Список покупок</h3>
      {/* Жалоба в чате: "где отмечать оставшиеся продукты со второй недели" —
          сама кнопка (иконка Home у каждой позиции) уже была, но ничего не
          подсказывало, что она вообще есть — просто мелкая иконка без
          подписи, тултип на тач-экране не всплывает никогда. Один и тот же
          принцип, что и с подсказкой про замену ниже: подсказка не про
          КОНКРЕТНЫЙ товар, а про то, что делает иконка в принципе — поэтому
          над списком, а не у каждой строки. */}
      <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "-4px 0 6px 0" }}>
        Что-то уже есть дома с прошлой недели — нажмите <Home size={11} style={{ verticalAlign: -1 }} /> рядом с товаром, вычтем из списка и запомним на следующий раз
      </p>
      {familyPaused && (
        <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "0 0 6px 0" }}>
          Общий список на паузе — отметки «уже есть дома» видны только вам.
        </p>
      )}
      {canOrderForReal && (
        <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "0 0 10px 0" }}>
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
            {g.items.map((it, itIdx) => {
              const sub = subs[it.name];
              const already = pantryStaples.has(it.name);
              return (
                <div key={`${it.name}-${itIdx}`}>
                  <div style={styles.listRow}>
                    <span style={{ minWidth: 0 }}>
                      {sub ? (
                        <>
                          <span style={{ textDecoration: "line-through", color: "var(--text-tertiary)" }}>{it.name}</span>
                          {" → "}{sub.name}
                        </>
                      ) : already ? (
                        <span style={{ textDecoration: "line-through", color: "var(--text-tertiary)" }}>{it.name}</span>
                      ) : (
                        <>
                          {it.name}
                          {/* Запрос в чате: "форель на 7-й день — не пропадёт
                              ли за неделю". Честно предупреждаем про
                              скоропортящееся мясо/рыбу, нужное только ближе к
                              концу недели, вместо того чтобы молча звать
                              купить всё сразу в день 0 — см. buyLater в
                              planLogic.js (buildPlanView). */}
                          {it.buyLater && (
                            <span style={styles.buyLaterBadge} title="Понадобится ближе к концу недели: если заказываете сразу, уберите в морозилку — так мясо и рыба не испортятся">
                              {" "}❄️ можно заморозить
                            </span>
                          )}
                        </>
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
                      ) : already ? (
                        <>
                          <span style={{ color: "var(--text-tertiary)" }}>не нужно покупать</span>
                          <button onClick={() => toggleHaveAlready(it.name)} title="Убрать отметку «уже есть»" aria-label="Убрать отметку «уже есть»" style={styles.pantryBtnActive}>
                            <Home size={13} />
                          </button>
                        </>
                      ) : (
                        <>
                          <span style={{ color: "var(--text-tertiary)" }}>
                            {it.amount} {it.unit}
                            {plan.itemized && it.cost != null && ` · ${it.cost.toLocaleString("ru-RU")} ₽`}
                          </span>
                          <button onClick={() => toggleHaveAlready(it.name)} title="Уже есть дома — не покупать в этот раз" aria-label="Уже есть дома — не покупать в этот раз" style={styles.pantryBtn}>
                            <Home size={13} />
                          </button>
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
          <button
            onClick={handleOrder}
            disabled={orderState.status === "loading" || orderBlocked}
            style={{ ...styles.orderBtn, ...(orderBlocked ? null : styles.orderBtnSticky), opacity: orderState.status === "loading" ? 0.6 : orderBlocked ? 0.45 : 1, cursor: orderBlocked ? "default" : "pointer" }}
          >
            {orderState.status === "loading" ? "Собираем корзину…" : orderBlocked ? `Заказать в ${storeName} — когда получим цены` : `Заказать в ${storeName}`}
          </button>
          {orderState.status === "error" && (
            <p style={styles.orderError}>Не получилось собрать корзину: {orderState.message}. Попробуйте ещё раз.</p>
          )}
          {orderState.status === "idle" && orderState.note && (
            <p style={styles.orderNote}>{orderState.note}</p>
          )}
          {/* ВкусВилл принимает максимум 20 позиций в одной ссылке "поделились
              товарами" — при более длинном списке покупок (обычное дело на
              неделю) buildCartFromShoppingList возвращает несколько ссылок.
              Первая уже открылась сама тем же кликом — остальные открываем
              по одной явным нажатием (иначе блокировщик всплывающих окон
              не пропустит window.open() без собственного жеста пользователя).
              Открыть и подтвердить каждую по очереди — они добавляются в
              ОДНУ и ту же корзину на сайте ВкусВилл, а не заменяют друг друга. */}
          {orderState.status === "idle" && orderState.links?.length > 1 && (
            <div style={styles.orderPartsWrap}>
              <p style={styles.orderNote}>
                Список покупок длиннее, чем принимает ВкусВилл за раз — открылась только первая часть. Откройте и подтвердите остальные по очереди, они добавятся в ту же корзину:
              </p>
              {orderState.links.slice(1).map((link, i) => (
                <button
                  key={i}
                  onClick={() => window.open(link, "_blank", "noopener,noreferrer")}
                  style={styles.orderPartBtn}
                >
                  Открыть часть {i + 2} из {orderState.links.length}
                </button>
              ))}
            </div>
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
