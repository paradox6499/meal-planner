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
  },
});
