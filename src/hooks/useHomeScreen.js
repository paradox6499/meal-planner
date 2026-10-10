// Статус «Добавить на экран» (Bot API 8.0+).
import { useState, useEffect } from "react";
import { checkHomeScreenStatus, onHomeScreenAdded } from "../lib/homeScreen.js";
import { trackEvent } from "../lib/analytics.js";

// "Добавить на экран" (Bot API 8.0+, см. lib/homeScreen.js) — статус
// проверяем один раз при монтировании, а не при каждом открытии Аккаунта:
// он не меняется сам по себе, кроме момента, когда пользователь реально
// подтвердит добавление (тогда прилетит событие homeScreenAdded).
/** @returns {string} "unsupported" | "unknown" | "missed" | "added" — см. lib/homeScreen.js */
export function useHomeScreen() {
  const [homeScreenStatus, setHomeScreenStatus] = useState("unsupported");
  useEffect(() => {
    checkHomeScreenStatus().then(setHomeScreenStatus);
    return onHomeScreenAdded(() => {
      setHomeScreenStatus("added");
      trackEvent("home_screen_added");
    });
  }, []);
  return homeScreenStatus;
}
