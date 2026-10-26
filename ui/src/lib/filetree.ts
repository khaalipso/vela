// The file tree as plain data: building it from flat paths, compacting single-child folders,
// git status on rows and folders, filter views, keyboard navigation and the math of the
// virtual list. No Svelte in here, so all of it is tested headless.

import type { Hit } from "./fuzzy";
import type { ChangeKind, RepoFiles } from "./types";

/** Height of every row of the tree and of the quick open list. */
export const ROW_HEIGHT = 28;

// ---------------------------------------------------------------------------
// Entries and status
// ---------------------------------------------------------------------------

export interface FileEntry {
  repo: string;
  path: string;
  staged: ChangeKind | null;
  unstaged: ChangeKind | null;
}

export type Chip = "all" | "changed" | "staged";

export const CHIPS: { id: Chip; label: string; key: string }[] = [
  { id: "all", label: "All", key: "A" },
  { id: "changed", label: "Changed", key: "C" },
  { id: "staged", label: "Staged", key: "S" },
];

export const LETTER: Record<ChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
};

export interface Mark {
  letter: string;
  /** Staged letters use the add color, unstaged ones the warn color, conflicts the del color. */
  tone: "staged" | "unstaged" | "conflict";
}

/** The letters of a file row: the staged side, then the unstaged side. */
export function marks(e: Pick<FileEntry, "staged" | "unstaged">): Mark[] {
  const out: Mark[] = [];
  if (e.staged) out.push({ letter: LETTER[e.staged], tone: e.staged === "conflicted" ? "conflict" : "staged" });
  if (e.unstaged) out.push({ letter: LETTER[e.unstaged], tone: e.unstaged === "conflicted" ? "conflict" : "unstaged" });
  return out;
}

export const isChanged = (e: Pick<FileEntry, "staged" | "unstaged">): boolean => !!(e.staged || e.unstaged);

export function matchesChip(e: Pick<FileEntry, "staged" | "unstaged">, chip: Chip): boolean {
  return chip === "all" ? true : chip === "staged" ? !!e.staged : isChanged(e);
}

export function entriesOf(repos: RepoFiles[]): FileEntry[] {
  const out: FileEntry[] = [];
  for (const r of repos) for (const f of r.files) out.push({ repo: r.repo, path: f.path, staged: f.staged, unstaged: f.unstaged });
  return out;
}

/** What a folder row shows: how many changed files it holds, and in which color. */
export function dirMark(n: Pick<TNode, "changed" | "unstaged">): { count: number; tone: "staged" | "unstaged" } | null {
  return n.changed ? { count: n.changed, tone: n.unstaged ? "unstaged" : "staged" } : null;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export const repoId = (repo: string) => `r:${repo}`;
export const dirId = (repo: string, path: string) => `d:${repo}/${path}`;
export const fileId = (repo: string, path: string) => `f:${repo}/${path}`;

export interface TNode {
  id: string;
  kind: "repo" | "dir" | "file";
  /** Label: the file name, or `src/billing/stripe` for a compacted chain of folders. */
  name: string;
  repo: string;
  /** Full path of the folder (its deepest one when compacted) or file; empty for a repo. */
  path: string;
  children: TNode[];
  /** Files below (or this file) with staged changes, with unstaged changes, with any change. */
  staged: number;
  unstaged: number;
  changed: number;
  file?: FileEntry;
  info?: { branch: string; ahead: number | null; behind: number | null };
}

export interface RepoInput {
  repo: string;
  branch: string;
  ahead?: number | null;
  behind?: number | null;
  entries: FileEntry[];
}

export function repoInputs(repos: RepoFiles[]): RepoInput[] {
  return repos.map((r) => ({
    repo: r.repo,
    branch: r.branch,
    ahead: r.ahead,
    behind: r.behind,
    entries: r.files.map((f) => ({ repo: r.repo, path: f.path, staged: f.staged, unstaged: f.unstaged })),
  }));
}

const isDigit = (c: number) => c >= 48 && c <= 57;

/** Case-insensitive comparison where digit runs compare as numbers (`a2` before `a10`). */
export function naturalCompare(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  let i = 0;
  let j = 0;
  while (i < la && j < lb) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(j);
    if (isDigit(ca) && isDigit(cb)) {
      let si = i;
      let sj = j;
      while (si < la && a.charCodeAt(si) === 48) si++;
      while (sj < lb && b.charCodeAt(sj) === 48) sj++;
      let ei = si;
      let ej = sj;
      while (ei < la && isDigit(a.charCodeAt(ei))) ei++;
      while (ej < lb && isDigit(b.charCodeAt(ej))) ej++;
      if (ei - si !== ej - sj) return ei - si - (ej - sj);
      for (let k = 0; k < ei - si; k++) {
        const d = a.charCodeAt(si + k) - b.charCodeAt(sj + k);
        if (d) return d;
      }
      i = ei;
      j = ej;
      continue;
    }
    if (ca !== cb) {
      const xa = ca >= 65 && ca <= 90 ? ca + 32 : ca;
      const xb = cb >= 65 && cb <= 90 ? cb + 32 : cb;
      if (xa !== xb) return xa - xb;
    }
    i++;
    j++;
  }
  return la - i - (lb - j) || (a < b ? -1 : a > b ? 1 : 0);
}

const byKindThenName = (a: TNode, b: TNode) =>
  a.kind === b.kind ? naturalCompare(a.name, b.name) : a.kind === "dir" ? -1 : 1;

function sortAndCompact(dir: TNode, isRoot: boolean) {
  dir.children.sort(byKindThenName);
  for (const c of dir.children) if (c.kind === "dir") sortAndCompact(c, false);
  // `src` holding only `billing` holding only `stripe` becomes one row `src/billing/stripe`.
  if (!isRoot) {
    while (dir.children.length === 1 && dir.children[0].kind === "dir") {
      const only = dir.children[0];
      dir.name = `${dir.name}/${only.name}`;
      dir.path = only.path;
      dir.id = only.id;
      dir.children = only.children;
    }
  }
}

function aggregate(n: TNode) {
  if (n.kind === "file") {
    n.staged = n.file?.staged ? 1 : 0;
    n.unstaged = n.file?.unstaged ? 1 : 0;
    n.changed = n.file && isChanged(n.file) ? 1 : 0;
    return;
  }
  let s = 0;
  let u = 0;
  let c = 0;
  for (const ch of n.children) {
    aggregate(ch);
    s += ch.staged;
    u += ch.unstaged;
    c += ch.changed;
  }
  n.staged = s;
  n.unstaged = u;
  n.changed = c;
}

/** One root per repo; folders first, natural order, single-child folder chains compacted. */
export function buildTree(repos: RepoInput[], opts: { hideEmpty?: boolean } = {}): TNode[] {
  const roots: TNode[] = [];
  for (const r of repos) {
    if (opts.hideEmpty && !r.entries.length) continue;
    const root: TNode = {
      id: repoId(r.repo),
      kind: "repo",
      name: r.repo,
      repo: r.repo,
      path: "",
      children: [],
      staged: 0,
      unstaged: 0,
      changed: 0,
      info: { branch: r.branch, ahead: r.ahead ?? null, behind: r.behind ?? null },
    };
    const dirs = new Map<string, TNode>([["", root]]);
    const dirOf = (path: string): TNode => {
      let d = dirs.get(path);
      if (d) return d;
      const cut = path.lastIndexOf("/");
      const parent = dirOf(cut < 0 ? "" : path.slice(0, cut));
      d = {
        id: dirId(r.repo, path),
        kind: "dir",
        name: path.slice(cut + 1),
        repo: r.repo,
        path,
        children: [],
        staged: 0,
        unstaged: 0,
        changed: 0,
      };
      parent.children.push(d);
      dirs.set(path, d);
      return d;
    };
    for (const e of r.entries) {
      const cut = e.path.lastIndexOf("/");
      const parent = dirOf(cut < 0 ? "" : e.path.slice(0, cut));
      parent.children.push({
        id: fileId(r.repo, e.path),
        kind: "file",
        name: e.path.slice(cut + 1),
        repo: r.repo,
        path: e.path,
        children: [],
        staged: 0,
        unstaged: 0,
        changed: 0,
        file: e,
      });
    }
    sortAndCompact(root, true);
    aggregate(root);
    roots.push(root);
  }
  return roots;
}

export interface Row {
  node: TNode;
  depth: number;
}

/** The visible rows: a node's children follow it when its id is in `expanded` (or always for "all"). */
export function flatten(roots: TNode[], expanded: ReadonlySet<string> | "all"): Row[] {
  const out: Row[] = [];
  const walk = (n: TNode, depth: number) => {
    out.push({ node: n, depth });
    if (n.kind !== "file" && (expanded === "all" || expanded.has(n.id))) for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** Id of the row where a new file or folder is being named. */
export const EDIT_ID = "__edit__";

/** Put the row that names a new entry first among the children of `dir` ("" is the repo itself). */
export function withNewRow(rows: Row[], repo: string, dir: string): Row[] {
  const at = rows.findIndex((r) => r.node.repo === repo && (dir ? r.node.kind === "dir" && r.node.path === dir : r.node.kind === "repo"));
  if (at < 0) return rows;
  const host = rows[at];
  const node: TNode = { id: EDIT_ID, kind: "file", name: "", repo, path: dir, children: [], staged: 0, unstaged: 0, changed: 0 };
  return [...rows.slice(0, at + 1), { node, depth: host.depth + 1 }, ...rows.slice(at + 1)];
}

/** Ids of every folder and repo node (to expand everything). */
export function allContainerIds(roots: TNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (n: TNode) => {
    if (n.kind === "file") return;
    ids.add(n.id);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return ids;
}

/** The nodes from the repo down to the file at `path` (inclusive when the file is in the tree). */
export function chainTo(roots: TNode[], repo: string, path: string): TNode[] {
  const root = roots.find((r) => r.repo === repo);
  if (!root) return [];
  const chain = [root];
  let cur = root;
  for (;;) {
    const next = cur.children.find((c) => (c.kind === "file" ? c.path === path : path.startsWith(`${c.path}/`)));
    if (!next) break;
    chain.push(next);
    if (next.kind === "file") break;
    cur = next;
  }
  return chain;
}

/** Ids to expand so that the file is visible. */
export function revealIds(roots: TNode[], repo: string, path: string): string[] {
  return chainTo(roots, repo, path)
    .filter((n) => n.kind !== "file")
    .map((n) => n.id);
}

/**
 * What is open when the drawer is first shown: repos and folders that hold changed files, the
 * parents of the open file, and the only repo when there is just one. Everything else is collapsed.
 */
export function defaultExpanded(roots: TNode[], open?: { repo: string; path: string } | null): Set<string> {
  const ids = new Set<string>();
  const walk = (n: TNode) => {
    if (n.kind === "file" || !n.changed) return;
    ids.add(n.id);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  if (open) for (const id of revealIds(roots, open.repo, open.path)) ids.add(id);
  if (roots.length === 1) ids.add(roots[0].id);
  return ids;
}

// ---------------------------------------------------------------------------
// Filter view
// ---------------------------------------------------------------------------

export interface FilterView {
  roots: TNode[];
  /** Matched character positions by file id (in the relative path). */
  positions: Map<string, number[]>;
  /** Matched positions inside the label of a folder row, by folder id. */
  dirPositions: Map<string, Set<number>>;
  /** Id of the best match. */
  top: string | null;
  /** Files in the view. */
  count: number;
}

/** Cap on the files shown as a tree while filtering. */
export const MAX_SHOWN = 2000;

/**
 * Files matched by the search, as a tree whose folders are all open. `hits` index into `entries`;
 * `hits` come best first. Without hits (a chip alone) pass the entries and no positions.
 */
export function filterView(repos: RepoInput[], entries: FileEntry[], hits: Hit[] | null): FilterView {
  const pick = hits ? hits.slice(0, MAX_SHOWN) : entries.slice(0, MAX_SHOWN).map((_, index) => ({ index, score: 0, positions: [] as number[] }));
  const byRepo = new Map<string, FileEntry[]>();
  const positions = new Map<string, number[]>();
  for (const h of pick) {
    const e = entries[h.index];
    let l = byRepo.get(e.repo);
    if (!l) byRepo.set(e.repo, (l = []));
    l.push(e);
    if (h.positions.length) positions.set(fileId(e.repo, e.path), h.positions);
  }
  const roots = buildTree(
    repos.map((r) => ({ ...r, entries: byRepo.get(r.repo) ?? [] })),
    { hideEmpty: true },
  );
  const dirPositions = new Map<string, Set<number>>();
  for (const [id, pos] of positions) {
    const rest = id.slice(2);
    const slash = rest.indexOf("/");
    const repo = rest.slice(0, slash);
    const path = rest.slice(slash + 1);
    for (const n of chainTo(roots, repo, path)) {
      if (n.kind !== "dir") continue;
      const start = n.path.length - n.name.length;
      let set = dirPositions.get(n.id);
      for (const p of pos)
        if (p >= start && p < n.path.length) {
          if (!set) dirPositions.set(n.id, (set = new Set()));
          set.add(p - start);
        }
    }
  }
  // Only a search has a best match; a chip alone leaves the cursor to the tree order.
  const first = hits ? pick[0] : undefined;
  const top = first ? fileId(entries[first.index].repo, entries[first.index].path) : null;
  return { roots, positions, dirPositions, top, count: hits ? hits.length : entries.length };
}

/** Cut `text` into runs of matched / unmatched characters. `positions` are indices in the full string, `offset` where `text` starts. */
export function highlightRuns(text: string, positions: Iterable<number> | undefined, offset = 0): { text: string; hit: boolean }[] {
  if (!positions) return [{ text, hit: false }];
  const set = positions instanceof Set ? positions : new Set(positions);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i + offset);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return runs.length ? runs : [{ text, hit: false }];
}

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

export type NavCmd = "down" | "up" | "left" | "right" | "enter" | "first" | "last" | "collapse-all";

export interface NavResult {
  cursor: string | null;
  expanded: Set<string>;
  /** A file to open (Enter, or Right on a file). */
  open: FileEntry | null;
  /** Move the focus into the editor after opening. */
  focusEditor: boolean;
}

/** One key press in the tree: where the cursor goes, what opens or closes. Pure. */
export function navigate(rows: Row[], cursor: string | null, expanded: ReadonlySet<string>, cmd: NavCmd): NavResult {
  const next = new Set(expanded);
  const res = (c: string | null, open: FileEntry | null = null, focusEditor = false): NavResult => ({
    cursor: c,
    expanded: next,
    open,
    focusEditor,
  });
  if (!rows.length) return res(null);
  const at = rows.findIndex((r) => r.node.id === cursor);
  if (cmd === "first") return res(rows[0].node.id);
  if (cmd === "last") return res(rows[rows.length - 1].node.id);
  if (at < 0) return res(rows[0].node.id);
  const row = rows[at];
  const n = row.node;
  switch (cmd) {
    case "down":
      return res(rows[Math.min(rows.length - 1, at + 1)].node.id);
    case "up":
      return res(rows[Math.max(0, at - 1)].node.id);
    case "left": {
      if (n.kind !== "file" && next.has(n.id)) {
        next.delete(n.id);
        return res(n.id);
      }
      for (let i = at - 1; i >= 0; i--) if (rows[i].depth < row.depth) return res(rows[i].node.id);
      return res(n.id);
    }
    case "right": {
      if (n.kind === "file") return res(n.id, n.file ?? null);
      if (!next.has(n.id)) {
        next.add(n.id);
        return res(n.id);
      }
      const child = rows[at + 1];
      return res(child && child.depth > row.depth ? child.node.id : n.id);
    }
    case "enter": {
      if (n.kind === "file") return res(n.id, n.file ?? null, true);
      if (next.has(n.id)) next.delete(n.id);
      else next.add(n.id);
      return res(n.id);
    }
    case "collapse-all": {
      next.clear();
      let i = at;
      while (i > 0 && rows[i].depth > 0) i--;
      return res(rows[i].node.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Virtual list
// ---------------------------------------------------------------------------

export interface VWindow {
  /** First and one-past-last row to render. */
  start: number;
  end: number;
  /** Space above the first rendered row, and the height of the whole list. */
  offset: number;
  height: number;
}

/** Rows to render for a scroll position: those in view plus `overscan` on each side. */
export function windowRange(total: number, scrollTop: number, viewport: number, rowH = ROW_HEIGHT, overscan = 8): VWindow {
  const first = Math.floor(Math.max(0, scrollTop) / rowH);
  const visible = Math.ceil(viewport / rowH) + 1;
  const start = Math.max(0, Math.min(total, first - overscan));
  const end = Math.max(start, Math.min(total, first + visible + overscan));
  return { start, end, offset: start * rowH, height: total * rowH };
}

/** The scroll position that keeps row `index` in view, moving as little as possible. */
export function scrollToRow(index: number, scrollTop: number, viewport: number, rowH = ROW_HEIGHT): number {
  const top = index * rowH;
  if (top < scrollTop) return top;
  if (top + rowH > scrollTop + viewport) return top + rowH - viewport;
  return scrollTop;
}
