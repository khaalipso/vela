import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
  // Svelte components must resolve to their client build under Vitest.
  resolve: mode === "test" ? { conditions: ["browser"] } : undefined,
  test: { environment: "node", include: ["src/**/*.test.ts"] },
}));
