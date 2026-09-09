import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MealPlanner from "./App.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary>
      <MealPlanner />
    </ErrorBoundary>
  </StrictMode>
);
