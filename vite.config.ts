import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: resolve(__dirname, "src/web/frontend"),
  build: {
    outDir: resolve(__dirname, "dist/web/frontend"),
    emptyOutDir: true,
  },
});
