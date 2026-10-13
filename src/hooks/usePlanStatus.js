// Тариф и бесплатный лимит: статус с бэкенда, экран лимита, экран «ваш последний план».
import { useState, useEffect } from "react";
import { checkPlanStatus, fetchPlanHistory } from "../lib/backend.js";

/**
 * @param {{ showAccount: boolean, hasLocalPlanAtMount: boolean }} opts
 *   showAccount — при открытии Аккаунта статус и история перезапрашиваются;
 *   hasLocalPlanAtMount — при запуске уже был план в localStorage (тогда экран
 *   «ваш последний план» не нужен).
 * @returns {{
 *   planStatus: null | object, setPlanStatus: (s: object) => void,
 *   planHistory: null | object[],
 *   limitBlocked: null | { nextResetHint: string | null }, setLimitBlocked: (v: null | { nextResetHint: string | null }) => void,
 *   lastPlanGate: null | { latest: object, status: object }, setLastPlanGate: (v: null | object) => void,
 * }}
 */
export function usePlanStatus({ showAccount, hasLocalPlanAtMount }) {
  // Тариф и история — реальные данные с бэкенда (null = ещё не спрашивали
  // или нечем спросить, см. lib/backend.js). planHistory —
  // только при открытии Аккаунта (единственное место, где она видна).
  // planStatus (isPro) нужен ещё и в ResultView — переключатель слотов плана
  // ("Ещё один план") должен знать про тариф ДО того, как пользователь
  // вообще откроет Аккаунт, поэтому спрашивается сразу при монтировании (и
  // ещё раз — при открытии Аккаунта, на случай если тариф поменялся,
  // например только что оплатили Pro).
  const [planStatus, setPlanStatus] = useState(null);
  const [planHistory, setPlanHistory] = useState(null);
  // Статус при запуске спрашивается в эффекте lastPlanGate ниже — одним запросом
  // на оба дела (каждый /api/plan-status на сервере сверяет незавершённые
  // платежи с ЮKassa, два одинаковых запроса при запуске были лишними).
  useEffect(() => {
    if (!showAccount) return;
    checkPlanStatus().then(setPlanStatus);
    fetchPlanHistory().then(setPlanHistory);
  }, [showAccount]);

  // Блокировка "бесплатный лимит исчерпан" — раньше узнавали об этом только
  // после ответа бэкенда на попытку "Собрать список" (см. handleFinish),
  // поэтому отдельное состояние, а не часть planStatus выше (тот обновляется
  // только пока открыт Аккаунт). Теперь может выставиться и раньше — см.
  // эффект lastPlanGate ниже, для случая "локального плана нет, а
  // бесплатный лимит уже исчерпан".
  const [limitBlocked, setLimitBlocked] = useState(null); // null | { nextResetHint }

  // Просьба в чате: "когда пользователь составил свой 1 бесплатный план, ему
  // не открывался визард заново с шагами, а показывался план при входе" —
  // initialActiveSlot (localStorage) уже решает это для обычного случая, но
  // Telegram WebView иногда сам чистит localStorage (или человек открыл с
  // другого устройства) — тогда локального плана нет, и до этой правки
  // человек каждый раз проходил ВЕСЬ визард заново, чтобы узнать только в
  // самом конце (см. handleFinish), что бесплатный лимит уже исчерпан. Здесь
  // та же проверка выполняется СРАЗУ при входе, не дожидаясь конца визарда:
  // если план на эту неделю уже есть в истории на бэкенде — показываем его
  // (см. LastPlanGateView), а не форму заново; если истории почему-то нет
  // (savePlanToHistory — best-effort, могла не сохраниться) — сразу
  // существующий экран limitBlocked, а не после десятка вопросов визарда.
  const [lastPlanGate, setLastPlanGate] = useState(null); // null | { latest, status }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await checkPlanStatus();
      if (cancelled) return;
      setPlanStatus(status);
      // Локальный план уже есть — обычный путь через ResultView, экран «ваш
      // последний план» не нужен.
      if (hasLocalPlanAtMount || !status || status.canGenerate !== false) return;
      const history = await fetchPlanHistory();
      if (cancelled) return;
      const latest = history && history.length > 0 ? history[0] : null;
      if (latest) setLastPlanGate({ latest, status });
      else setLimitBlocked({ nextResetHint: status.nextResetHint });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- один раз на монтировании
  }, []);

  // После оплаты человек возвращается из браузера в тот же Mini App, а экран
  // лимита в нём так и остаётся "исчерпан" (UX-аудит 29.09.2026: "после
  // оплаты тишина"). Возвращаясь в приложение, тихо перепроверяем статус — и
  // если платёж уже прошёл (canGenerate), убираем экран лимита сами.
  // visibilitychange — обычный браузер/часть клиентов; activated — событие
  // Telegram Mini Apps (Bot API 8.0+), срабатывает при возврате в приложение.
  useEffect(() => {
    if (!limitBlocked && !lastPlanGate) return;
    let cancelled = false;
    const recheck = async () => {
      const status = await checkPlanStatus();
      if (cancelled || !status?.canGenerate) return;
      setPlanStatus(status);
      setLimitBlocked(null);
      setLastPlanGate(null);
    };
    const onVisible = () => { if (document.visibilityState === "visible") recheck(); };
    document.addEventListener("visibilitychange", onVisible);
    const tg = window.Telegram?.WebApp;
    tg?.onEvent?.("activated", recheck);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      tg?.offEvent?.("activated", recheck);
    };
  }, [limitBlocked, lastPlanGate]);

  return { planStatus, setPlanStatus, planHistory, setPlanHistory, limitBlocked, setLimitBlocked, lastPlanGate, setLastPlanGate };
}
