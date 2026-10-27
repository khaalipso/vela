import { describe, expect, it } from "vitest";
import {
  allRows,
  buildSections,
  splitRows,
  clampHunk,
  fileHunks,
  initialRv,
  moveHunk,
  moveSelection,
  reconcile,
  toggleSection,
  visibleRows,
} from "./review";
import type { FileChange, Hunk } from "./types";

const hunk = (
  id: string,
  repo: string,
  path: string,
  state: Hunk["state"],
  origin: Hunk["origin"],
  add = 1,
  del = 0,
  at = 1,
): Hunk => ({
  id,
  repo,
  path,
  oldStart: at,
  oldLines: del,
  newStart: at,
  newLines: add,
  section: "",
  lines: [
    ...Array.from({ length: del }, (_, i) => ({ kind: "del" as const, text: "x", old: at + i, new: null })),
    ...Array.from({ length: add }, (_, i) => ({ kind: "add" as const, text: "y", old: null, new: at + i })),
  ],
  origin,
  state,
});
const you = { type: "you" } as const;
const agent = { type: "agent", agent: "a1" } as const;
const fc = (repo: string, path: string, staged: FileChange["staged"], unstaged: FileChange["unstaged"]): FileChange => ({
  repo,
  path,
  staged,
  unstaged,
});

const status = [
  fc("api", "src/b.ts", "modified", null),
  fc("api", "src/a.ts", "added", "modified"),
  fc("web", "x.tsx", null, "untracked"),
  fc("web", "gone.ts", "deleted", null),
];
const hunks = [
  hunk("h1", "api", "src/b.ts", "staged", you, 3, 1),
  hunk("h2", "api", "src/a.ts", "staged", agent, 2, 0),
  hunk("h3", "api", "src/a.ts", "pending", you, 5, 2, 40),
  hunk("h4", "web", "x.tsx", "pending", you, 7, 0),
  hunk("h5", "web", "p.ts", "pending", agent, 1, 1),
  hunk("h6", "web", "p.ts", "pending", agent, 2, 0, 30),
  hunk("h7", "web", "r.ts", "rejected", agent),
];

describe("sections", () => {
  const s = buildSections(status, hunks);

  it("lists each file once: to review when something waits in it, else accepted", () => {
    expect(s.counts).toEqual({ review: 3, done: 2 });
    expect(s.review.map((g) => [g.repo, g.files.map((f) => f.path)])).toEqual([
      ["api", ["src/a.ts"]],
      ["web", ["p.ts", "x.tsx"]],
    ]);
    expect(s.done.map((g) => [g.repo, g.files.map((f) => f.path)])).toEqual([
      ["api", ["src/b.ts"]],
      ["web", ["gone.ts"]],
    ]);
  });

  it("says who the waiting changes come from and counts every line of the file", () => {
    const [a] = s.review[0].files;
    expect(a).toMatchObject({ id: "api/src/a.ts", letter: "M", add: 7, del: 2, hunks: 2, pending: 1, mine: true, agents: [] });
    const [p, x] = s.review[1].files;
    expect(p).toMatchObject({ letter: "M", add: 3, del: 1, hunks: 2, pending: 2, mine: false, agents: ["a1"] });
    expect(x).toMatchObject({ letter: "A", mine: true });
    expect(s.done[1].files[0]).toMatchObject({ letter: "D", section: "done" });
    expect(s.total).toEqual({ add: 3, del: 1 });
  });

  it("gives every file one id and leaves rejected proposals out", () => {
    const ids = allRows(s).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("web/r.ts");
  });

  it("a new file proposed by an agent shows as added", () => {
    const n = { ...hunk("n1", "api", "new.ts", "pending", agent, 3, 0), oldStart: 0, oldLines: 0 };
    expect(buildSections([], [n]).review[0].files[0]).toMatchObject({ letter: "A", agents: ["a1"] });
  });

  it("is empty without data", () => {
    expect(buildSections([], []).counts).toEqual({ review: 0, done: 0 });
  });

  it("lists a file's hunks in file order with their states", () => {
    expect(fileHunks(hunks, "api", "src/a.ts").map((h) => [h.id, h.state])).toEqual([
      ["h2", "staged"],
      ["h3", "pending"],
    ]);
    expect(fileHunks(hunks, "web", "r.ts")).toEqual([]);
  });
});

describe("selection", () => {
  const s = buildSections(status, hunks);
  const rows = allRows(s);

  it("J and K walk the visible rows and stop at the ends", () => {
    let st = initialRv();
    st = moveSelection(st, rows, 1);
    expect(st.sel).toBe(rows[0].id);
    st = moveSelection(st, rows, 1);
    expect(st.sel).toBe(rows[1].id);
    st = moveSelection(st, rows, -1);
    st = moveSelection(st, rows, -1);
    expect(st.sel).toBe(rows[0].id);
    for (let i = 0; i < 20; i++) st = moveSelection(st, rows, 1);
    expect(st.sel).toBe(rows.at(-1)!.id);
  });

  it("moving resets the hunk cursor; nothing to select clears it", () => {
    const st = moveSelection({ ...initialRv(), sel: rows[0].id, hunk: 3 }, rows, 1);
    expect(st.hunk).toBe(0);
    expect(moveSelection({ ...initialRv(), sel: "x" }, [], 1).sel).toBeNull();
  });

  it("collapsed sections are skipped", () => {
    const st = toggleSection(initialRv(), "done");
    const vis = visibleRows(s, st.collapsed);
    expect(vis.every((r) => r.section !== "done")).toBe(true);
    expect(vis.length).toBe(3);
    expect(toggleSection(st, "done").collapsed.done).toBe(false);
  });

  it("after a row vanishes, the selection takes the row now at its place", () => {
    const sel = rows[1];
    const without = rows.filter((r) => r.id !== sel.id);
    expect(reconcile({ ...initialRv(), sel: sel.id }, without, 1).sel).toBe(without[1].id);
    expect(reconcile({ ...initialRv(), sel: rows.at(-1)!.id }, rows.slice(0, 2), 99).sel).toBe(rows[1].id);
    expect(reconcile({ ...initialRv(), sel: rows[0].id }, rows, 0).sel).toBe(rows[0].id);
    expect(reconcile({ ...initialRv(), sel: rows[0].id }, [], 0).sel).toBeNull();
  });
});

describe("hunk cursor", () => {
  it("Tab wraps forward, Shift Tab backward", () => {
    let st = initialRv();
    st = moveHunk(st, 3, 1);
    st = moveHunk(st, 3, 1);
    expect(st.hunk).toBe(2);
    expect(moveHunk(st, 3, 1).hunk).toBe(0);
    expect(moveHunk({ ...st, hunk: 0 }, 3, -1).hunk).toBe(2);
    expect(moveHunk({ ...st, hunk: 2 }, 0, 1).hunk).toBe(0);
  });

  it("is clamped when hunks disappear", () => {
    expect(clampHunk({ ...initialRv(), hunk: 4 }, 2).hunk).toBe(1);
    expect(clampHunk({ ...initialRv(), hunk: 4 }, 0).hunk).toBe(0);
  });
});

describe("splitRows", () => {
  it("pairs removed and added runs, context on both sides", () => {
    const rows = splitRows({
      lines: [
        { kind: "ctx", old: 1, new: 1, text: "a" },
        { kind: "del", old: 2, text: "b" },
        { kind: "del", old: 3, text: "c" },
        { kind: "add", new: 2, text: "B" },
        { kind: "ctx", old: 4, new: 3, text: "d" },
        { kind: "add", new: 4, text: "e" },
      ],
    } as never);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["a", "a"],
      ["b", "B"],
      ["c", null],
      ["d", "d"],
      [null, "e"],
    ]);
    expect(rows[1].left).toEqual({ n: 2, text: "b", kind: "del" });
    expect(rows[1].right).toEqual({ n: 2, text: "B", kind: "add" });
  });
});
