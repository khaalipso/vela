import { describe, expect, it } from "vitest";
import { buildPaletteItems, filterPalette, type PaletteSource } from "./palette";

const src: PaletteSource = {
  upNextTitle: "Review 3 proposals",
  spaces: [
    {
      name: "Stripe v2 billing",
      branch: "feat/stripe-v2",
      color: "#E8A14A",
      files: [
        { id: "api/src/billing/webhook.ts", repo: "api", path: "src/billing/webhook.ts" },
        { id: "web/lib/stripe.ts", repo: "web", path: "lib/stripe.ts" },
      ],
    },
    {
      name: "Postgres 17",
      branch: "chore/pg17",
      color: "#7DB8F5",
      files: [{ id: "infra/compose.yml", repo: "infra", path: "compose.yml" }],
    },
  ],
};
const items = buildPaletteItems(src);
const titles = (q: string) => filterPalette(items, q).map((i) => i.title);

describe("command bar", () => {
  it("lists actions, then spaces, then files", () => {
    expect(items.map((i) => i.sec)).toEqual([
      ...Array(11).fill("Actions"),
      "Spaces",
      "Spaces",
      "Files",
      "Files",
      "Files",
    ]);
    expect(items[0].title).toBe("Up next: Review 3 proposals");
    expect(items[0].action).toEqual({ type: "up-next" });
  });

  it("gives spaces their Alt number", () => {
    const sp = items.filter((i) => i.sec === "Spaces");
    expect(sp.map((s) => s.key)).toEqual(["Alt 1", "Alt 2"]);
    expect(sp[1].action).toEqual({ type: "space-jump", index: 1 });
  });

  it("empty query keeps everything", () => {
    expect(filterPalette(items, "").length).toBe(items.length);
    expect(filterPalette(items, "   ").length).toBe(items.length);
  });

  it("matches case-insensitively on a substring", () => {
    expect(titles("COMMIT")).toEqual(["Commit and push"]);
  });

  it("matches the subtitle too", () => {
    expect(titles("chore/pg17")).toEqual(["Postgres 17"]);
    expect(titles("infra")).toEqual(["compose.yml"]);
  });

  it("every word must match, in any order", () => {
    expect(titles("billing stripe")).toEqual(["Stripe v2 billing", "src/billing/webhook.ts", "lib/stripe.ts"]);
    expect(titles("webhook infra")).toEqual([]);
    expect(titles("own window")).toEqual(["Open this space in its own window"]);
  });

  it("returns nothing for no match", () => {
    expect(titles("zzz")).toEqual([]);
  });

  it("file items open the file in their space", () => {
    const f = filterPalette(items, "compose")[0];
    expect(f.action).toEqual({ type: "open-file", space: 1, file: "infra/compose.yml" });
  });
});
