// Ответы визарда, которые сохраняются как профиль (семья, приёмы пищи, рацион,
// аллергии, кухня, техника, время готовки, имя, время приёмов пищи).
import { useState } from "react";
import { loadProfile } from "../lib/profile.js";
import { hapticSelect } from "../lib/haptics.js";
import { DEFAULT_DIET, ALL_DEVICE_IDS, DEFAULT_MEAL_TIMES } from "../constants.js";

/**
 * Состояние и сеттеры под теми же именами, что были в MealPlanner, плюс:
 * profileSnapshot() — объект для saveProfile; resetAnswersToDefaults() — сброс
 * ответов на значения по умолчанию ("Новый план" без сохранённого профиля);
 * toggleSimple/toggleCuisine — переключатели чипов в визарде и Аккаунте.
 */
export function useWizardProfile() {
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

  const [family, setFamily] = useState(savedProfile?.family ?? 2);
  // Необязательные точечные переопределения "Семьи" по приёмам пищи (см.
  // комментарий у buildInitialPlan в planLogic.js) — например, пара, где
  // один ест дома только завтрак и ужин, а второй ещё и обед. Пустой объект
  // (по умолчанию) означает "одинаково для всех приёмов пищи", т.е. прежнее
  // поведение — настройка сознательно "спрятана" в Аккаунте, а не в визарде
  // (см. AccountView), чтобы не усложнять сборку плана тем, кому это не нужно.
  const [familyByMeal, setFamilyByMeal] = useState(savedProfile?.familyByMeal ?? {});
  const [meals, setMeals] = useState(savedProfile?.meals ?? ["lunch", "dinner"]);
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
  const [displayName, setDisplayName] = useState(savedProfile?.displayName ?? "");
  const [mealTimes, setMealTimes] = useState(savedProfile?.mealTimes ?? DEFAULT_MEAL_TIMES);

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

  const profileSnapshot = () => ({ family, familyByMeal, meals, diet, allergies, cuisines, devices, displayName, mealTimes, maxCookTime });
  const resetAnswersToDefaults = () => {
    setFamily(2); setFamilyByMeal({}); setMeals(["lunch", "dinner"]); setDiet(DEFAULT_DIET);
    setAllergies([]); setAllergiesAnswered(false); setCuisines([]); setDevices(ALL_DEVICE_IDS); setMaxCookTime(null);
  };

  return {
    hasProfile, setHasProfile,
    family, setFamily, familyByMeal, setFamilyByMeal, meals, setMeals, diet, setDiet,
    allergies, setAllergies, allergiesAnswered, setAllergiesAnswered, cuisines, setCuisines,
    devices, setDevices, maxCookTime, setMaxCookTime, displayName, setDisplayName, mealTimes, setMealTimes,
    toggleSimple, toggleCuisine, profileSnapshot, resetAnswersToDefaults,
  };
}
