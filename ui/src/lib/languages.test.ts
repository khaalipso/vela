import { describe, expect, it } from "vitest";
import { languageOf, loadLanguage, type Lang } from "./languages";

describe("languages", () => {
  it("names the language from the file name, then the extension", () => {
    const cases: [string, Lang][] = [
      ["api/src/main.py", "python"],
      ["web/App.vue", "vue"],
      ["web/App.svelte", "svelte"],
      ["web/index.html", "html"],
      ["web/style.scss", "scss"],
      ["web/a.css", "css"],
      ["web/x.tsx", "tsx"],
      ["package.json", "json"],
      ["ci.yml", "yaml"],
      ["Cargo.toml", "toml"],
      ["Dockerfile", "dockerfile"],
      ["deploy/api.Dockerfile", "dockerfile"],
      ["Makefile", "shell"],
      ["scripts/run.sh", "shell"],
      [".env.local", "ini"],
      ["main.go", "go"],
      ["App.kt", "kotlin"],
      ["README", "plain"],
    ];
    for (const [p, l] of cases) expect(languageOf(p), p).toBe(l);
  });

  it("loads a support for each family, once", async () => {
    for (const l of ["python", "yaml", "html", "css", "json", "vue", "toml", "shell", "dockerfile", "go"] as Lang[]) {
      const ext = await loadLanguage(l);
      expect(Array.isArray(ext) ? ext.length : 1, l).toBeGreaterThan(0);
    }
    expect(loadLanguage("python")).toBe(loadLanguage("python"));
    expect(await loadLanguage("plain")).toEqual([]);
  });
});
