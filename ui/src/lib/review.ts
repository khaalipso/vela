// Pure logic of the Review view: the three file sections, the selection and the hunk cursor.
// The store (app.svelte.ts) applies these; components only render.

import type { ChangeKind, FileChange, Hunk } from "./types";

export type Section = "staged" | "unstaged" | "proposed";
export const SECTIONS: Section[] = ["staged", "unstaged", "proposed"];
export const SECTION_TITLES: Record<Section, string> = {
  staged: "Staged",
  unstaged: "Not staged",
  proposed: "Proposed by agents",
};

export interface FileRow {
  /** `section:repo/path`, unique in the list. */
  id: string;
  section: Section;
  repo: string;
  path: string;
  /** Status letter: A, M, D, R, U, C, or P for a proposal. */
  letter: string;
  add: number;
  del: number;
  hunks: number;
}

export interface RepoGroup {
  repo: string;
  files: FileRow[];
}

export interface Sections {
  staged: RepoGroup[];
  unstaged: RepoGroup[];
  proposed: RepoGroup[];
  counts: Record<Section, number>;
  /** Lines added and removed by the staged set. */
  total: { add: number; del: number };
}

const LETTER: Record<ChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
};

export const rowId = (section: Section, repo: string, path: string) => `${section}:${repo}/${path}`;

function sizeOf(h: Hunk): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of h.lines) {
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { add, del };
}

function group(rows: FileRow[]): RepoGroup[] {
  const repos: string[] = [];
  for (const r of rows) if (!repos.includes(r.repo)) repos.push(r.repo);
  return repos.map((repo) => ({
    repo,
    files: rows.filter((r) => r.repo === repo).sort((a, b) => a.path.localeCompare(b.path)),
  }));
}

/**
 * Staged files come from the index, "Not staged" from your edits in the worktree,
 * "Proposed" from pending agent hunks. Sizes are counted from the hunks of that side.
 */
export function buildSections(status: FileChange[], hunks: Hunk[]): Sections {
  const rows: Record<Section, FileRow[]> = { staged: [], unstaged: [], proposed: [] };
  const of = (repo: string, path: string, pick: (h: Hunk) => boolean) => {
    let add = 0;
    let del = 0;
    let n = 0;
    for (const h of hunks) {
      if (h.repo !== repo || h.path !== path || !pick(h)) continue;
      const s = sizeOf(h);
      add += s.add;
      del += s.del;
      n++;
    }
    return { add, del, hunks: n };
  };
  for (const c of status) {
    if (c.staged) {
      rows.staged.push({
        id: rowId("staged", c.repo, c.path),
        section: "staged",
        repo: c.repo,
        path: c.path,
        letter: LETTER[c.staged],
        ...of(c.repo, c.path, (h) => h.state === "staged"),
      });
    }
    if (c.unstaged) {
      rows.unstaged.push({
        id: rowId("unstaged", c.repo, c.path),
        section: "unstaged",
        repo: c.repo,
        path: c.path,
        letter: LETTER[c.unstaged],
        ...of(c.repo, c.path, (h) => h.state === "pending" && h.origin.type === "you"),
      });
    }
  }
  const seen = new Set<string>();
  for (const h of hunks) {
    if (h.origin.type !== "agent" || h.state !== "pending") continue;
    const k = `${h.repo}/${h.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.proposed.push({
      id: rowId("proposed", h.repo, h.path),
      section: "proposed",
      repo: h.repo,
      path: h.path,
      letter: "P",
      ...of(h.repo, h.path, (x) => x.state === "pending" && x.origin.type === "agent"),
    });
  }
  const total = rows.staged.reduce((t, r) => ({ add: t.add + r.add, del: t.del + r.del }), { add: 0, del: 0 });
  return {
    staged: group(rows.staged),
    unstaged: group(rows.unstaged),
    proposed: group(rows.proposed),
    counts: { staged: rows.staged.length, unstaged: rows.unstaged.length, proposed: rows.proposed.length },
    total,
  };
}

// ---------------------------------------------------------------------------
// Selection and cursor
// ---------------------------------------------------------------------------

export type Focus = "files" | "diff" | "checks";

export interface RvState {
  /** Id of the selected row. */
  sel: string | null;
  collapsed: Record<Section, boolean>;
  focus: Focus;
  /** Index of the hunk under the cursor in the diff. */
  hunk: number;
  /** `repo/id` of the focused check. */
  check: string | null;
  /** Check whose log is open. */
  open: string | null;
}

export const initialRv = (): RvState => ({
  sel: null,
  collapsed: { staged: false, unstaged: false, proposed: false },
  focus: "files",
  hunk: 0,
  check: null,
  open: null,
});

/** Rows in screen order, leaving out the collapsed sections. */
export function visibleRows(s: Sections, collapsed: Record<Section, boolean>): FileRow[] {
  return SECTIONS.flatMap((sec) => (collapsed[sec] ? [] : s[sec].flatMap((g) => g.files)));
}

export function allRows(s: Sections): FileRow[] {
  return visibleRows(s, { staged: false, unstaged: false, proposed: false });
}

/** J and K: move the selection, stopping at both ends. */
export function moveSelection(st: RvState, rows: FileRow[], delta: 1 | -1): RvState {
  if (!rows.length) return { ...st, sel: null, hunk: 0 };
  const cur = rows.findIndex((r) => r.id === st.sel);
  const next = cur < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, cur + delta));
  return rows[next].id === st.sel ? st : { ...st, sel: rows[next].id, hunk: 0 };
}

/**
 * Keep the selection valid after the lists changed. A row that vanished (staged, unstaged)
 * is replaced by the row now at its old position, so repeated Space walks down the list.
 */
export function reconcile(st: RvState, rows: FileRow[], prevIndex: number): RvState {
  if (!rows.length) return st.sel === null ? st : { ...st, sel: null, hunk: 0 };
  if (st.sel && rows.some((r) => r.id === st.sel)) return st;
  const i = Math.max(0, Math.min(rows.length - 1, prevIndex));
  return { ...st, sel: rows[i].id, hunk: 0 };
}

export function toggleSection(st: RvState, sec: Section): RvState {
  return { ...st, collapsed: { ...st.collapsed, [sec]: !st.collapsed[sec] } };
}

/** Tab and Shift Tab: next / previous hunk, wrapping around. */
export function moveHunk(st: RvState, count: number, delta: 1 | -1): RvState {
  if (count <= 0) return st.hunk === 0 ? st : { ...st, hunk: 0 };
  return { ...st, hunk: (st.hunk + delta + count) % count };
}

export function clampHunk(st: RvState, count: number): RvState {
  const h = count <= 0 ? 0 : Math.min(st.hunk, count - 1);
  return h === st.hunk ? st : { ...st, hunk: h };
}

/** The hunks of one file in file order, rejected ones left out. */
export function fileHunks(hunks: Hunk[], repo: string, path: string): Hunk[] {
  return hunks
    .filter((h) => h.repo === repo && h.path === path && h.state !== "rejected")
    .sort((a, b) => a.newStart - b.newStart);
}

/** One side of a row of the side by side diff. */
export interface SideCell {
  n: number | null;
  text: string;
  kind: "ctx" | "add" | "del";
}

/** One row of the side by side diff: before on the left, after on the right. */
export interface SplitRow {
  left: SideCell | null;
  right: SideCell | null;
}

/**
 * Before and after, side by side: context lines on both sides, each run of removed lines
 * paired with the run of added lines that follows it (the longer run leaves blanks).
 */
export function splitRows(h: Pick<Hunk, "lines">): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: SideCell[] = [];
  let adds: SideCell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of h.lines) {
    if (l.kind === "del") {
      if (adds.length) flush();
      dels.push({ n: l.old ?? null, text: l.text, kind: "del" });
    } else if (l.kind === "add") {
      adds.push({ n: l.new ?? null, text: l.text, kind: "add" });
    } else {
      flush();
      out.push({ left: { n: l.old ?? null, text: l.text, kind: "ctx" }, right: { n: l.new ?? null, text: l.text, kind: "ctx" } });
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Optimistic updates: the lists move at once, the backend catches up behind.
// ---------------------------------------------------------------------------

export interface FileKeyed {
  repo: string;
  path: string;
}

const same = (a: FileKeyed, b: FileKeyed) => a.repo === b.repo && a.path === b.path;

/** What staging whole files does to the status and the hunks, before git answers. */
export function stageLocally(status: FileChange[], hunks: Hunk[], files: FileKeyed[]): { status: FileChange[]; hunks: Hunk[] } {
  const hit = (f: FileKeyed) => files.some((x) => same(x, f));
  return {
    status: status.map((c) =>
      hit(c) && c.unstaged
        ? {
            ...c,
            staged: c.staged ?? (c.unstaged === "untracked" ? "added" : c.unstaged),
            unstaged: null,
          }
        : c,
    ),
    hunks: hunks.map((h) => (hit(h) && h.state === "pending" && h.origin.type === "you" ? { ...h, state: "staged" } : h)),
  };
}

/** What unstaging whole files does, before git answers. */
export function unstageLocally(status: FileChange[], hunks: Hunk[], files: FileKeyed[]): { status: FileChange[]; hunks: Hunk[] } {
  const hit = (f: FileKeyed) => files.some((x) => same(x, f));
  return {
    status: status.map((c) =>
      hit(c) && c.staged
        ? {
            ...c,
            unstaged: c.unstaged ?? (c.staged === "added" ? "untracked" : c.staged),
            staged: null,
          }
        : c,
    ),
    hunks: hunks.map((h) => (hit(h) && h.state === "staged" ? { ...h, state: "pending", origin: { type: "you" } } : h)),
  };
}

/** What accepting hunks does: they turn staged, and their files show in the staged list. */
export function acceptLocally(status: FileChange[], hunks: Hunk[], ids: string[]): { status: FileChange[]; hunks: Hunk[] } {
  const picked = hunks.filter((h) => ids.includes(h.id));
  const out = [...status];
  for (const h of picked) {
    const i = out.findIndex((c) => same(c, h));
    if (i < 0)
      out.push({
        repo: h.repo,
        path: h.path,
        staged: "modified",
        unstaged: null,
      });
    else if (!out[i].staged)
      out[i] = {
        ...out[i],
        staged: out[i].unstaged === "untracked" ? "added" : (out[i].unstaged ?? "modified"),
      };
  }
  // A file of yours whose every pending hunk is accepted leaves the "Not staged" list.
  const left = (c: FileChange) => hunks.some((h) => same(h, c) && h.state === "pending" && h.origin.type === "you" && !ids.includes(h.id));
  return {
    status: out.map((c) => (c.unstaged && picked.some((h) => same(h, c)) && !left(c) ? { ...c, unstaged: null } : c)),
    hunks: hunks.map((h) => (ids.includes(h.id) ? { ...h, state: "staged" } : h)),
  };
}
