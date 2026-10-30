import { describe, expect, it } from "vitest";

import { oldestToDrop as _old, tabLabels as _labels } from "./tabs";
describe("tab labels", () => {
  it("shows the file name, and the folder only when names collide", () => {
    const l = _labels(["api/src/a/index.ts", "api/src/b/index.ts", "api/src/main.ts"]);
    expect(l.get("api/src/main.ts")).toBe("main.ts");
    expect(l.get("api/src/a/index.ts")).toBe("a/index.ts");
    expect(l.get("api/src/b/index.ts")).toBe("b/index.ts");
  });
  it("drops the oldest tab that is not the current one", () => {
    const t = [{ key: "r/a", pinned: true }, { key: "r/b", pinned: true }];
    expect(_old(t, "r/a")).toBe("r/b");
    expect(_old(t, "r/b")).toBe("r/a");
  });
});
