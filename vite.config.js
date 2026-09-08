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
});
