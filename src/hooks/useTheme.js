// Тема оформления, выбранная вручную в Аккаунте.
import { useState, useEffect } from "react";
import { loadTheme, saveTheme } from "../lib/profile.js";

// "system" | "light" | "dark" — управляется вручную из Аккаунта, поверх
// системной темы по умолчанию (см. data-theme в <style> в App.jsx и useEffect
// ниже, который проставляет атрибут на <html>).
/** @returns {[string, (theme: string) => void]} */
export function useTheme() {
  const [theme, setTheme] = useState(loadTheme);
  useEffect(() => {
    saveTheme(theme);
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return [theme, setTheme];
}
