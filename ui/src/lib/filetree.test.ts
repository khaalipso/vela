import { describe, expect, it } from "vitest";
import {
  allContainerIds,
  buildTree,
  defaultExpanded,
  dirMark,
  fileId,
  filterView,
  flatten,
  highlightRuns,
  marks,
  matchesChip,
  naturalCompare,
  navigate,
  repoId,
  scrollToRow,
  windowRange,
  type FileEntry,
  type RepoInput,
  type TNode,
} from "./filetree";
import { FileIndex } from "./fuzzy";
import { closeTab, openTab, pushRecent } from "./tabs";

const e = (path: string, staged: FileEntry["staged"] = null, unstaged: FileEntry["unstaged"] = null, repo = "api"): FileEntry => ({
  repo,
  path,
  staged,
  unstaged,
});
const entries = [
  e("README.md"),
  e("src/billing/stripe/client.ts", null, "modified"),
  e("src/billing/stripe/webhook.ts", "modified"),
  e("src/util.ts"),
  e("src/app10.ts"),
  e("src/app2.ts"),
  e("docs/a.md"),
];
const repos: RepoInput[] = [{ repo: "api", branch: "main", entries }];
const names = (n: TNode[]) => n.map((x) => x.name);

describe("tree", () => {
  const [root] = buildTree(repos);

  it("puts folders first and sorts naturally", () => {
    expect(names(root.children)).toEqual(["docs", "src", "README.md"]);
    const src = root.children[1];
    expect(names(src.children)).toEqual(["billing/stripe", "app2.ts", "app10.ts", "util.ts"]);
    expect(naturalCompare("a2", "a10")).toBeLessThan(0);
    expect(naturalCompare("B", "a")).toBeGreaterThan(0);
  });

  it("compacts single-child folder chains on one row", () => {
    const chain = root.children[1].children[0];
    expect(chain.name).toBe("billing/stripe");
    expect(chain.path).toBe("src/billing/stripe");
    expect(chain.id).toBe("d:api/src/billing/stripe");
  });

  it("aggregates the status on folders", () => {
    expect(root.changed).toBe(2);
    expect(root.staged).toBe(1);
    expect(root.unstaged).toBe(1);
    const chain = root.children[1].children[0];
    expect(dirMark(chain)).toEqual({ count: 2, tone: "unstaged" });
    expect(dirMark(root.children[0])).toBeNull();
  });

  it("shows letters: staged add color, unstaged warn color, both when mixed", () => {
    expect(marks(e("a", "added"))).toEqual([{ letter: "A", tone: "staged" }]);
    expect(marks(e("a", "modified", "modified"))).toEqual([
      { letter: "M", tone: "staged" },
      { letter: "M", tone: "unstaged" },
    ]);
    expect(marks(e("a", null, "untracked"))[0].letter).toBe("U");
    expect(marks(e("a", null, "conflicted"))).toEqual([{ letter: "C", tone: "conflict" }]);
    expect(marks(e("a", "deleted"))[0].letter).toBe("D");
    expect(marks(e("a", "renamed"))[0].letter).toBe("R");
  });

  it("opens folders with changes and the open file, collapses the rest", () => {
    const open = defaultExpanded([root], null);
    expect(open.has(repoId("api"))).toBe(true);
    expect(open.has("d:api/src")).toBe(true);
    expect(open.has("d:api/src/billing/stripe")).toBe(true);
    expect(open.has("d:api/docs")).toBe(false);
    const rows = flatten([root], open);
    expect(rows.map((r) => r.node.name)).toContain("client.ts");
    expect(rows.map((r) => r.node.name)).not.toContain("a.md");
    expect(defaultExpanded([root], { repo: "api", path: "docs/a.md" }).has("d:api/docs")).toBe(true);
  });
});

describe("chips and filter view", () => {
  it("chips select changed and staged files", () => {
    expect(entries.filter((x) => matchesChip(x, "all"))).toHaveLength(entries.length);
    expect(entries.filter((x) => matchesChip(x, "changed"))).toHaveLength(2);
    expect(entries.filter((x) => matchesChip(x, "staged")).map((x) => x.path)).toEqual(["src/billing/stripe/webhook.ts"]);
  });

  it("shows matches with their ancestors, all expanded, and the highlighted positions", () => {
    const idx = new FileIndex(entries.map((x) => x.path));
    const hits = idx.search("webhook");
    const v = filterView(repos, entries, hits);
    expect(v.count).toBe(1);
    expect(v.top).toBe(fileId("api", "src/billing/stripe/webhook.ts"));
    const rows = flatten(v.roots, "all");
    expect(rows.map((r) => r.node.name)).toEqual(["api", "src/billing/stripe", "webhook.ts"]);
    expect(v.positions.get(v.top!)!.length).toBe(7);
    expect(allContainerIds(v.roots).size).toBe(2);
  });

  it("hides repos without matches", () => {
    const two: RepoInput[] = [...repos, { repo: "web", branch: "main", entries: [e("x.ts", null, null, "web")] }];
    const all = [...entries, e("x.ts", null, null, "web")];
    const v = filterView(two, all, new FileIndex(all.map((x) => x.path)).search("util"));
    expect(names(v.roots)).toEqual(["api"]);
  });

  it("highlights runs of matched characters", () => {
    expect(highlightRuns("webhook.ts", [0, 1, 4], 0)).toEqual([
      { text: "we", hit: true },
      { text: "bh", hit: false },
      { text: "o", hit: true },
      { text: "ok.ts", hit: false },
    ]);
    expect(highlightRuns("hook.ts", [4, 5], 3)).toEqual([
      { text: "h", hit: false },
      { text: "oo", hit: true },
      { text: "k.ts", hit: false },
    ]);
  });
});

describe("keyboard navigation", () => {
  const [root] = buildTree(repos);
  const exp = new Set([repoId("api"), "d:api/src"]);
  const rows = flatten([root], exp);
  const id = (i: number) => rows[i].node.id;

  it("moves with down and up and stays in range", () => {
    expect(navigate(rows, id(0), exp, "down").cursor).toBe(id(1));
    expect(navigate(rows, id(0), exp, "up").cursor).toBe(id(0));
    expect(navigate(rows, id(rows.length - 1), exp, "down").cursor).toBe(id(rows.length - 1));
    expect(navigate(rows, null, exp, "down").cursor).toBe(id(0));
  });

  it("left collapses an open folder, else goes to the parent", () => {
    const src = rows.findIndex((r) => r.node.id === "d:api/src");
    const r1 = navigate(rows, id(src), exp, "left");
    expect(r1.expanded.has("d:api/src")).toBe(false);
    expect(r1.cursor).toBe("d:api/src");
    const child = src + 1;
    expect(navigate(rows, id(child), exp, "left").cursor).toBe("d:api/src");
  });

  it("right expands, then enters, then opens a file", () => {
    const docs = rows.findIndex((r) => r.node.id === "d:api/docs");
    const r = navigate(rows, id(docs), exp, "right");
    expect(r.expanded.has("d:api/docs")).toBe(true);
    const src = rows.findIndex((x) => x.node.id === "d:api/src");
    expect(navigate(rows, id(src), exp, "right").cursor).toBe(id(src + 1));
    const util = rows.findIndex((x) => x.node.name === "util.ts");
    expect(navigate(rows, id(util), exp, "right").open?.path).toBe("src/util.ts");
  });

  it("enter opens a file and asks for the editor focus; on a folder it toggles", () => {
    const util = rows.findIndex((x) => x.node.name === "util.ts");
    const r = navigate(rows, id(util), exp, "enter");
    expect(r.open?.path).toBe("src/util.ts");
    expect(r.focusEditor).toBe(true);
    const src = rows.findIndex((x) => x.node.id === "d:api/src");
    expect(navigate(rows, id(src), exp, "enter").expanded.has("d:api/src")).toBe(false);
  });

  it("collapse all keeps the repo under the cursor", () => {
    const util = rows.findIndex((x) => x.node.name === "util.ts");
    const r = navigate(rows, id(util), exp, "collapse-all");
    expect(r.expanded.size).toBe(0);
    expect(r.cursor).toBe(repoId("api"));
  });
});

describe("virtual list", () => {
  it("renders the visible rows plus overscan", () => {
    const w = windowRange(1000, 280, 280, 28, 5);
    expect(w).toEqual({ start: 5, end: 26, offset: 140, height: 28000 });
  });

  it("clamps at both ends and for short lists", () => {
    expect(windowRange(1000, 0, 280, 28, 5).start).toBe(0);
    expect(windowRange(1000, 27900, 280, 28, 5).end).toBe(1000);
    expect(windowRange(3, 0, 280)).toMatchObject({ start: 0, end: 3, height: 84 });
    expect(windowRange(0, 0, 280).end).toBe(0);
  });

  it("scrolls the least to show a row", () => {
    expect(scrollToRow(5, 0, 280)).toBe(0);
    expect(scrollToRow(20, 0, 280)).toBe(20 * 28 + 28 - 280);
    expect(scrollToRow(1, 280, 280)).toBe(28);
  });
});

describe("tabs and recent files", () => {
  it("a preview tab is replaced by the next one, a pinned tab stays", () => {
    let t = openTab([], "api/a", false);
    t = openTab(t, "api/b", false);
    expect(t.map((x) => x.key)).toEqual(["api/b"]);
    t = openTab(t, "api/b", true);
    t = openTab(t, "api/c", false);
    expect(t).toEqual([
      { key: "api/b", pinned: true },
      { key: "api/c", pinned: false },
    ]);
  });

  it("closing the current tab shows its neighbour", () => {
    const t = [{ key: "a", pinned: true }, { key: "b", pinned: true }];
    expect(closeTab(t, "b", "b").current).toBe("a");
    expect(closeTab(t, "a", "b").current).toBe("b");
  });

  it("recent files keep the last opened first, without duplicates", () => {
    expect(pushRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(pushRecent(["a"], "z", 1)).toEqual(["z"]);
  });
});
