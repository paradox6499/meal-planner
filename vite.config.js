import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Относительный base, а не жёстко прописанное имя репозитория — так сборка
  // работает и на GitHub Pages по адресу /<repo>/, и на кастомном домене, и
  // локально, без правки конфига под конкретное имя репо.
  base: "./",
  server: {
    host: true,
  },
  // node, не jsdom — все тесты сейчас на чистых функциях (planLogic.js,
  // data/recipes.js), без рендера React-компонентов и без DOM. Понадобится
  // jsdom — добавить отдельно, когда появятся тесты на сами компоненты.
  test: {
    environment: "node",
    // По умолчанию Vitest ищет **/*.test.js по всему репозиторию — без
    // явного exclude подхватывал и server/ (отдельный деплоящийся проект,
    // свой package.json/node_modules, требует Node 22+ ради node:sqlite).
    // CI фронтенда собирается на Node 20 — подхват серверных тестов здесь
    // ломал сборку (node:sqlite не существует на Node 20), хотя сами
    // серверные тесты у себя в server/ проходят нормально (см. server/README.md
    // и server/package.json — npm test запускается там отдельно).
    exclude: ["**/node_modules/**", "**/server/**"],
  },
});
