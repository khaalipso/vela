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

  it("groups staged, not staged and proposed with counts", () => {
    expect(s.counts).toEqual({ staged: 3, unstaged: 2, proposed: 1 });
    expect(s.staged.map((g) => g.repo)).toEqual(["api", "web"]);
    expect(s.staged[0].files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(s.unstaged.map((g) => g.files.map((f) => f.path))).toEqual([["src/a.ts"], ["x.tsx"]]);
    expect(s.proposed[0].files[0]).toMatchObject({ repo: "web", path: "p.ts", letter: "P", hunks: 2, add: 3, del: 1 });
  });

  it("counts lines of the right side only and totals the staged ones", () => {
    const a = s.staged[0].files[0];
    expect(a).toMatchObject({ letter: "A", add: 2, del: 0, section: "staged" });
    const aUn = s.unstaged[0].files[0];
    expect(aUn).toMatchObject({ letter: "M", add: 5, del: 2 });
    expect(s.total).toEqual({ add: 5, del: 1 });
    expect(s.staged[1].files[0]).toMatchObject({ letter: "D", add: 0, del: 0 });
    expect(s.unstaged[1].files[0].letter).toBe("U");
  });

  it("gives every row a unique id and leaves rejected proposals out", () => {
    const ids = allRows(s).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("proposed:web/r.ts");
  });

  it("is empty without data", () => {
    expect(buildSections([], []).counts).toEqual({ staged: 0, unstaged: 0, proposed: 0 });
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
    const st = toggleSection(initialRv(), "staged");
    const vis = visibleRows(s, st.collapsed);
    expect(vis.every((r) => r.section !== "staged")).toBe(true);
    expect(vis.length).toBe(3);
    expect(toggleSection(st, "staged").collapsed.staged).toBe(false);
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
