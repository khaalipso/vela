import { describe, expect, it } from "vitest";
import { inlineAssets, isHtml, localPath } from "./htmlpreview";

describe("htmlpreview", () => {
  it("knows html files", () => {
    expect(isHtml("r/a/index.html")).toBe(true);
    expect(isHtml("r/a.css")).toBe(false);
  });
  it("resolves local links only", () => {
    expect(localPath("web/", "css/a.css?v=1")).toBe("web/css/a.css");
    expect(localPath("web/", "../x.js")).toBe("x.js");
    expect(localPath("web/", "/x.js")).toBe("x.js");
    expect(localPath("web/", "https://cdn/x.js")).toBeNull();
    expect(localPath("web/", "//cdn/x.js")).toBeNull();
  });
  it("inlines linked css and js, leaves the rest", async () => {
    const files: Record<string, string> = { "web/a.css": "p{color:red}", "web/m.js": "go()" };
    const out = await inlineAssets(
      `<link rel="stylesheet" href="a.css"><link rel="icon" href="i.png"><script src="m.js" defer></script><script src="https://x/y.js"></script><link rel=stylesheet href="gone.css">`,
      "web/index.html",
      async (p) => files[p] ?? null,
    );
    expect(out).toContain("<style>p{color:red}</style>");
    expect(out).toContain("<script defer>go()</script>");
    expect(out).toContain('<link rel="icon" href="i.png">');
    expect(out).toContain('<script src="https://x/y.js"></script>');
    expect(out).toContain('<link rel=stylesheet href="gone.css">');
  });
});
