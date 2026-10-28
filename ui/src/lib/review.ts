// Pure logic of the Review view: the three file sections, the selection and the hunk cursor.
// The store (app.svelte.ts) applies these; components only render.

import { naturalCompare } from "./filetree";
import type { ChangeKind, FileChange, Hunk } from "./types";

/**
 * One entry per changed file. "To review" holds every file with something waiting for you
 * (an agent proposal, or an edit of yours not staged yet); "Accepted" the files whose every
 * change is staged and will go in the commit. A file is never in both.
 */
export type Section = "review" | "done";
export const SECTIONS: Section[] = ["review", "done"];
export const SECTION_TITLES: Record<Section, string> = {
  review: "To review",
  done: "Accepted",
};

export interface FileRow {
  /** `repo/path`: the same row whether the file waits or is accepted. */
  id: string;
  section: Section;
  repo: string;
  path: string;
  /** Status letter: A, M, D, R, U, C. */
  letter: string;
  /** Lines added and removed by every change of the file (accepted or not). */
  add: number;
  del: number;
  hunks: number;
  /** Hunks still waiting. */
  pending: number;
  /** Agents whose proposals wait in this file. */
  agents: string[];
  /** The file holds edits of yours not staged yet. */
  mine: boolean;
}

export interface RepoGroup {
  repo: string;
  files: FileRow[];
}

export interface Sections {
  review: RepoGroup[];
  done: RepoGroup[];
  counts: Record<Section, number>;
  /** Lines added and removed by the accepted files. */
  total: { add: number; del: number };
}

const LETTER: Record<ChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "A",
  conflicted: "C",
};

export const rowId = (repo: string, path: string) => `${repo}/${path}`;

function sizeOf(h: Hunk): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of h.lines) {
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { add, del };
}

/**
 * The order of the file tree: repos by name, then in each folder the subfolders before the
 * files, names in natural order. J and K walk the rows in this order.
 */
export function treeCompare(a: { repo: string; path: string }, b: { repo: string; path: string }): number {
  if (a.repo !== b.repo) return naturalCompare(a.repo, b.repo);
  const x = a.path.split("/");
  const y = b.path.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const xDir = i < x.length - 1;
    const yDir = i < y.length - 1;
    if (xDir !== yDir) return xDir ? -1 : 1;
    const c = naturalCompare(x[i], y[i]);
    if (c) return c;
  }
  return x.length - y.length;
}

function group(rows: FileRow[]): RepoGroup[] {
  const sorted = [...rows].sort(treeCompare);
  const repos: string[] = [];
  for (const r of sorted) if (!repos.includes(r.repo)) repos.push(r.repo);
  return repos.map((repo) => ({ repo, files: sorted.filter((r) => r.repo === repo) }));
}

/** The files of the space with what waits in each, from git status and the hunks. */
export function buildSections(status: FileChange[], hunks: Hunk[]): Sections {
  const keys: { repo: string; path: string }[] = [];
  const seen = new Set<string>();
  const add = (repo: string, path: string) => {
    const k = rowId(repo, path);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push({ repo, path });
    }
  };
  for (const c of status) if (c.staged || c.unstaged) add(c.repo, c.path);
  for (const h of hunks) if (h.origin.type === "agent" && h.state === "pending") add(h.repo, h.path);

  const rows: FileRow[] = keys.map(({ repo, path }) => {
    const c = status.find((x) => x.repo === repo && x.path === path);
    const hs = hunks.filter((h) => h.repo === repo && h.path === path && h.state !== "rejected");
    const waiting = hs.filter((h) => h.state === "pending");
    let a = 0;
    let d = 0;
    for (const h of hs) {
      const z = sizeOf(h);
      a += z.add;
      d += z.del;
    }
    const agents = [...new Set(waiting.flatMap((h) => (h.origin.type === "agent" ? [h.origin.agent] : [])))];
    const mine = !!c?.unstaged;
    const kind = c?.unstaged ?? c?.staged ?? null;
    const created = !c && hs.some((h) => h.oldStart === 0 && h.oldLines === 0);
    return {
      id: rowId(repo, path),
      section: waiting.length || mine ? "review" : "done",
      repo,
      path,
      letter: kind ? LETTER[kind] : created ? "A" : "M",
      add: a,
      del: d,
      hunks: hs.length,
      pending: waiting.length,
      agents,
      mine,
    };
  });
  const review = rows.filter((r) => r.section === "review");
  const done = rows.filter((r) => r.section === "done");
  const total = done.reduce((t, r) => ({ add: t.add + r.add, del: t.del + r.del }), { add: 0, del: 0 });
  return {
    review: group(review),
    done: group(done),
    counts: { review: review.length, done: done.length },
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
  collapsed: { review: false, done: false },
  focus: "files",
  hunk: 0,
  check: null,
  open: null,
});

/** Rows in screen order (one tree, files to review and accepted ones mixed), leaving out the collapsed sections. */
export function visibleRows(s: Sections, collapsed: Record<Section, boolean>): FileRow[] {
  return SECTIONS.flatMap((sec) => (collapsed[sec] ? [] : s[sec].flatMap((g) => g.files))).sort(treeCompare);
}

export function allRows(s: Sections): FileRow[] {
  return visibleRows(s, { review: false, done: false });
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
