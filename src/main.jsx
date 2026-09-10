import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MealPlanner from "./App.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";
import { trackEvent } from "./lib/analytics.js";

// ErrorBoundary (см. componentDidCatch там) ловит только ошибки РЕНДЕРА.
// Ошибка в обработчике клика, в асинхронном коде (упавший fetch, отклонённый
// промис) — не рендер, ErrorBoundary их не увидит вообще, а экран внешне
// останется рабочим при реально сломанной функциональности. Эти два
// глобальных листенера — единственный способ поймать и такие тоже.
window.addEventListener("error", (event) => {
  trackEvent("app_error", { message: String(event.error?.message || event.message || "").slice(0, 300), source: "window.onerror" });
});
window.addEventListener("unhandledrejection", (event) => {
  trackEvent("app_error", { message: String(event.reason?.message || event.reason || "").slice(0, 300), source: "unhandledrejection" });
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary>
      <MealPlanner />
    </ErrorBoundary>
  </StrictMode>
);
