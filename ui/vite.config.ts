import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // The main chunk holds CodeMirror with its search; xterm.js and the Markdown renderer load on demand.
  build: { target: "es2022", chunkSizeWarningLimit: 1000 },
  // Svelte components must resolve to their client build under Vitest.
  resolve: mode === "test" ? { conditions: ["browser"] } : undefined,
  test: { environment: "node", include: ["src/**/*.test.ts"] },
}));
