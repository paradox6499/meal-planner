// «Общий список на семью»: статус семьи, вступление по ссылке, действия из Аккаунта.
import { useState, useEffect } from "react";
import { createFamily, joinFamily, leaveFamily, fetchFamilyStatus, toggleFamilyPantryItem } from "../lib/backend.js";
import { hapticImpact } from "../lib/haptics.js";
import { trackEvent } from "../lib/analytics.js";

/**
 * @param {{ showAccount: boolean }} opts — при открытии Аккаунта статус перезапрашивается
 * @returns {{
 *   familyStatus: null | { inFamily: boolean, isOwner?: boolean, familyId?: number, members?: object[], pantryNames?: string[], active?: boolean },
 *   familyJoinedNote: boolean, setFamilyJoinedNote: (v: boolean) => void,
 *   familyJoinError: null | string, setFamilyJoinError: (v: null | string) => void,
 *   familyActionState: { status: "idle" | "loading" | "error", message?: string },
 *   handleCreateFamily: () => Promise<void>, handleLeaveFamily: () => Promise<void>,
 *   handleToggleFamilyPantry: (name: string, present: boolean) => Promise<void>,
 * }}
 */
export const FAMILY_POLL_MS = 15000;

export function useFamily({ showAccount }) {
  // familyStatus — null (ещё не спрашивали/нечем спросить) | {inFamily:false}
  // | {inFamily:true, isOwner, familyId, members, pantryNames}. Нужен на
  // мониторинге сразу, не только при открытии Аккаунта — ResultView
  // подмешивает pantryNames в локальный "уже есть дома" (см. ниже), это
  // должно случиться независимо от того, открывал ли человек Аккаунт в этой
  // сессии вообще.
  const [familyStatus, setFamilyStatus] = useState(null);
  useEffect(() => {
    fetchFamilyStatus().then((r) => { if (r?.ok) setFamilyStatus(r.status); });
  }, []);
  useEffect(() => {
    if (!showAccount) return undefined;
    const refresh = () => fetchFamilyStatus().then((r) => { if (r?.ok) setFamilyStatus(r.status); });
    refresh();
    // Пока Аккаунт открыт, состав семьи подтягивается сам: владелец отправил приглашение, ждёт на этом
    // экране — и новый участник появляется без перезахода (раньше статус спрашивали только при открытии).
    const timer = setInterval(refresh, FAMILY_POLL_MS);
    return () => clearInterval(timer);
  }, [showAccount]);
  // Приложение долго живёт свёрнутым в Telegram: пока человек пересылал ссылку, статус устаревал и
  // новый участник не показывался. Возвращаясь в приложение, спрашиваем заново.
  useEffect(() => {
    const refresh = () => fetchFamilyStatus().then((r) => { if (r?.ok) setFamilyStatus(r.status); });
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    const tg = window.Telegram?.WebApp;
    tg?.onEvent?.("activated", refresh);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      tg?.offEvent?.("activated", refresh);
    };
  }, []);

  // "Общий список на семью" — вступление по ссылке
  // t.me/s_edim_bot?startapp=fam_<inviteCode> (см. AccountView: FamilySection,
  // "Пригласить"), та же startapp-схема, что уже работает у рефералов (см.
  // эффект claimReferral в useReferral). Код приглашения, не id семьи — живая жалоба
  // в чате: короткий id легко перебираем (см. genInviteCode в
  // server/src/db.js). Best-effort, один раз при монтировании — сервер сам
  // решает, принять ли (лимит участников, уже состоит в другой семье и т.п.,
  // см. server/src/family.js).
  useEffect(() => {
    const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
    const match = /^fam_([A-Za-z0-9_-]+)$/.exec(startParam || "");
    if (match) {
      joinFamily(match[1]).then((r) => {
        if (!r?.ok) {
          // Раньше отказ (уже состоите в семье, у владельца кончился Pro, семья полна) проходил молча:
          // человек переходил по ссылке, видел обычный визард и не понимал, что не вступил.
          trackEvent("family_join_failed");
          setFamilyJoinError(r?.error || "Не удалось вступить в семью. Попробуйте открыть ссылку ещё раз.");
          return;
        }
        trackEvent("family_joined");
        setFamilyStatus(r.status);
        // Раньше вступление было молчаливым: первый экран — обычный визард, о
        // семье ни слова (перепроверка UX-аудита 04.10.2026).
        setFamilyJoinedNote(true);
      });
    }
  }, []);
  const [familyJoinedNote, setFamilyJoinedNote] = useState(false);
  const [familyJoinError, setFamilyJoinError] = useState(null);

  const handleCreateFamily = async () => {
    hapticImpact("light");
    setFamilyActionState({ status: "loading" });
    const result = await createFamily();
    if (result?.ok) {
      setFamilyStatus(result.status);
      setFamilyActionState({ status: "idle" });
      trackEvent("family_created");
    } else {
      setFamilyActionState({ status: "error", message: result?.error || "Не удалось создать семью" });
    }
  };
  const handleLeaveFamily = async () => {
    hapticImpact("light");
    setFamilyActionState({ status: "loading" });
    const result = await leaveFamily();
    if (result?.ok) {
      setFamilyStatus({ inFamily: false });
      setFamilyActionState({ status: "idle" });
      trackEvent("family_left");
    } else {
      setFamilyActionState({ status: "error", message: result?.error || "Не удалось покинуть семью" });
    }
  };
  const [familyActionState, setFamilyActionState] = useState({ status: "idle" }); // idle | loading | error

  // "Отметил купленное один член семьи — увидят все" — пуш серверу best-effort
  // при каждом клике по "уже есть дома" в ResultView (см. проп onToggleFamilyPantry
  // в App.jsx), сервер отвечает актуальным полным набором сразу же — не нужно
  // отдельно перезапрашивать весь статус семьи ради одного изменения.
  const handleToggleFamilyPantry = async (name, present) => {
    const result = await toggleFamilyPantryItem(name, present);
    if (result?.ok) setFamilyStatus((prev) => (prev?.inFamily ? { ...prev, pantryNames: result.pantryNames } : prev));
  };

  return { familyStatus, familyJoinedNote, setFamilyJoinedNote, familyJoinError, setFamilyJoinError, familyActionState, handleCreateFamily, handleLeaveFamily, handleToggleFamilyPantry };
}
