import { describe, expect, it } from "vitest";
import { buildPaletteItems, filterPalette, type PaletteSource } from "./palette";
import type { Link } from "./types";

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
      ...Array(24).fill("Actions"),
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

describe("links in the command bar", () => {
  const link = (o: Partial<Link>): Link => ({
    id: "l1",
    kind: "issue",
    provider: "jira",
    url: "https://acme.atlassian.net/browse/PAY-412",
    title: "PAY-412",
    key: "PAY-412",
    source: "branch",
    ...o,
  });
  const withLinks = buildPaletteItems({
    ...src,
    links: [
      link({}),
      link({ id: "l2", kind: "environment", provider: "url", url: "https://staging.acme.dev/x", title: "Staging acme.dev", key: null }),
      link({ id: "l3", url: "", title: "ENG-1 (no tracker URL configured)", key: "ENG-1" }),
      link({ id: "l4", kind: "pullRequest", provider: "github", url: "https://github.com/a/b/pull/3", title: "Add refunds", key: "a/b#3" }),
    ],
  });

  it("lists the links with a URL between the actions and the spaces", () => {
    const sec = withLinks.map((i) => i.sec);
    expect(sec.indexOf("Links")).toBe(24);
    expect(sec.lastIndexOf("Links")).toBe(26);
    const l = withLinks.filter((i) => i.sec === "Links");
    expect(l.map((x) => x.title)).toEqual(["Open PAY-412", "Open Staging acme.dev", "Open Add refunds"]);
    expect(l[0].action).toEqual({ type: "open-link", id: "l1" });
    expect(l[2].sub).toBe("a/b#3");
  });

  it("finds a link by key, by word or by its kind of place", () => {
    expect(filterPalette(withLinks, "PAY-412").map((i) => i.title)).toEqual(["Open PAY-412"]);
    expect(filterPalette(withLinks, "staging").map((i) => i.title)).toEqual(["Open Staging acme.dev"]);
    expect(filterPalette(withLinks, "links")[0].action).toEqual({ type: "open-links" });
  });

  it("has no links section without links", () => {
    expect(items.some((i) => i.sec === "Links")).toBe(false);
  });
});
