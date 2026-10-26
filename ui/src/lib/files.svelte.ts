// State of the file tree drawer and of quick open: the files of each space as the backend
// lists them, the filter, the cursor, what is expanded, and the search indexes.
// The pure parts (tree, scorer, navigation) live in filetree.ts and fuzzy.ts.

import { app } from "./app.svelte";
import { fileKey } from "./format";
import { FileIndex, type Hit } from "./fuzzy";
import {
  filterView,
  matchesChip,
  repoInputs,
  entriesOf,
  MAX_SHOWN,
  type Chip,
  type FileEntry,
  type FilterView,
  type RepoInput,
} from "./filetree";
import { createMatcher, type Matcher } from "./matcher";
import type { RepoFiles } from "./types";

/** What is known about the files of a space, prepared once per listing. */
export interface Prepared {
  src: RepoFiles[];
  repos: RepoInput[];
  entries: FileEntry[];
  matcher: Matcher;
}

/** One line of quick open. */
export interface QuickHit {
  entry: FileEntry;
  score: number;
  positions: number[];
}

const MIN_WIDTH = 200;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 300;

function readWidth(win: string): number {
  try {
    const n = Number(localStorage.getItem(`vela.files.width.${win}`));
    return Number.isFinite(n) && n >= MIN_WIDTH ? Math.min(MAX_WIDTH, n) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export class FilesState {
  /** Listing by space id. */
  data = $state.raw<Record<string, RepoFiles[]>>({});
  /** Expanded folder ids by space id. */
  expandedBy = $state.raw<Record<string, Set<string>>>({});
  query = $state("");
  chip = $state<Chip>("all");
  /** Id of the row under the cursor. */
  cursor = $state<string | null>(null);
  /** The filter view for the current query and chip, null when not filtering. */
  view = $state.raw<FilterView | null>(null);
  width = $state(DEFAULT_WIDTH);

  private prepared = new Map<string, Prepared>();
  private seeded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private filterSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private off: (() => void) | null = null;
  private listenTo: unknown = null;
  /** The drawer or quick open is on screen, so events refresh the listing. */
  shown = false;
  private stale = new Set<string>();
  /** Milliseconds to wait before reloading after a change event. */
  debounce = 150;

  /** The window this state belongs to, to keep one width per window. */
  private get win(): string {
    return app.pinned ?? "main";
  }

  loadWidth() {
    this.width = readWidth(this.win);
  }

  setWidth(w: number, max = MAX_WIDTH) {
    this.width = Math.max(MIN_WIDTH, Math.min(max, Math.round(w)));
  }

  saveWidth() {
    try {
      localStorage.setItem(`vela.files.width.${this.win}`, String(this.width));
    } catch {
      /* storage blocked: the width is just not remembered */
    }
  }

  // -- listing --------------------------------------------------------------

  /** Listen to the backend: a change reloads the listing (debounced) while the tree is shown. */
  listen() {
    const b = app.backend;
    if (this.listenTo === b) return;
    this.off?.();
    this.listenTo = b;
    this.off = b.onChange((e) => {
      if (!(e.spaceId in this.data)) return;
      if (!this.shown) {
        this.stale.add(e.spaceId);
        return;
      }
      this.schedule(e.spaceId);
    });
  }

  stop() {
    this.off?.();
    this.off = null;
    this.listenTo = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private pendingIds = new Set<string>();
  private schedule(id: string) {
    this.pendingIds.add(id);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const ids = [...this.pendingIds];
      this.pendingIds.clear();
      for (const i of ids) void this.load(i);
    }, this.debounce);
  }

  /** Mark the tree as on screen; reloads what changed while it was hidden. */
  show(on: boolean, spaceId?: string) {
    this.shown = on;
    if (!on) return;
    this.listen();
    if (spaceId && (!(spaceId in this.data) || this.stale.has(spaceId))) void this.load(spaceId);
  }

  /** Fetch the listing of a space. Concurrent calls share one request. */
  load(spaceId: string): Promise<void> {
    this.stale.delete(spaceId);
    const running = this.loading.get(spaceId);
    if (running) return running;
    const p = app.backend
      .spaceFiles(spaceId)
      .then((repos) => {
        this.data = { ...this.data, [spaceId]: repos };
      })
      .catch((e: unknown) => app.toast(e instanceof Error ? e.message : String(e)))
      .finally(() => this.loading.delete(spaceId));
    this.loading.set(spaceId, p);
    return p;
  }

  /** Repos, entries and search index for a space; rebuilt only when the listing changed. */
  prepare(spaceId: string): Prepared | null {
    const src = this.data[spaceId];
    if (!src) return null;
    const hit = this.prepared.get(spaceId);
    if (hit && hit.src === src) return hit;
    hit?.matcher.dispose();
    const entries = entriesOf(src);
    const p: Prepared = {
      src,
      repos: repoInputs(src),
      entries,
      matcher: createMatcher(entries.map((e) => e.path)),
    };
    this.prepared.set(spaceId, p);
    return p;
  }

  // -- expansion ------------------------------------------------------------

  expandedOf(spaceId: string): Set<string> {
    return this.expandedBy[spaceId] ?? new Set();
  }

  setExpanded(spaceId: string, ids: Set<string>) {
    this.expandedBy = { ...this.expandedBy, [spaceId]: ids };
  }

  expand(spaceId: string, ids: Iterable<string>) {
    const cur = this.expandedOf(spaceId);
    const next = new Set(cur);
    let changed = false;
    for (const id of ids)
      if (!next.has(id)) {
        next.add(id);
        changed = true;
      }
    if (changed) this.setExpanded(spaceId, next);
  }

  toggle(spaceId: string, id: string) {
    const next = new Set(this.expandedOf(spaceId));
    if (!next.delete(id)) next.add(id);
    this.setExpanded(spaceId, next);
  }

  /** The default expansion is applied once per space. Returns true when it ran. */
  seed(spaceId: string, ids: () => Set<string>): boolean {
    if (this.seeded.has(spaceId)) return false;
    this.seeded.add(spaceId);
    this.expand(spaceId, ids());
    return true;
  }

  // -- filter ---------------------------------------------------------------

  get filtering(): boolean {
    return this.query.trim() !== "" || this.chip !== "all";
  }

  /** Recompute the filter view for the current query and chip. */
  refilter(spaceId: string) {
    const seq = ++this.filterSeq;
    const prep = this.prepare(spaceId);
    const q = this.query.trim();
    if (!prep || (!q && this.chip === "all")) {
      this.view = null;
      return;
    }
    const entries = this.chip === "all" ? prep.entries : prep.entries.filter((e) => matchesChip(e, this.chip));
    const done = (hits: Hit[] | null) => {
      if (seq !== this.filterSeq) return;
      this.view = filterView(prep.repos, entries, hits);
    };
    if (!q) return done(null);
    if (this.chip === "all") {
      const now = prep.matcher.searchNow(q, MAX_SHOWN);
      if (now) return done(now);
      // A worker answers later; typing stays smooth because the UI thread is free.
      void prep.matcher.search(q, MAX_SHOWN).then(done);
      return;
    }
    done(new FileIndex(entries.map((e) => e.path)).search(q, MAX_SHOWN));
  }

  clearFilter() {
    this.query = "";
    this.chip = "all";
    this.view = null;
    this.filterSeq++;
  }

  // -- quick open -----------------------------------------------------------

  /**
   * Best matches across all repos of the space. Recent files get a boost; with no query the
   * recent files come first, then the changed ones.
   */
  quick(spaceId: string, query: string, recent: string[], limit = 50): QuickHit[] {
    const prep = this.prepare(spaceId);
    if (!prep) return [];
    const rank = new Map(recent.map((k, i) => [k, i]));
    const boost = (e: FileEntry) => {
      const r = rank.get(fileKey(e.repo, e.path));
      return r === undefined ? 0 : 30 * (1 - r / Math.max(1, recent.length));
    };
    const q = query.trim();
    const byKey = new Map(prep.entries.map((e) => [fileKey(e.repo, e.path), e]));
    if (!q) {
      const out: QuickHit[] = [];
      const seen = new Set<string>();
      for (const k of recent) {
        const e = byKey.get(k);
        if (e && !seen.has(k)) {
          seen.add(k);
          out.push({ entry: e, score: 0, positions: [] });
        }
      }
      for (const e of prep.entries) {
        if (out.length >= limit) break;
        const k = fileKey(e.repo, e.path);
        if ((e.staged || e.unstaged) && !seen.has(k)) {
          seen.add(k);
          out.push({ entry: e, score: 0, positions: [] });
        }
      }
      return out.slice(0, limit);
    }
    const hits = prep.matcher.searchNow(q, 300) ?? new FileIndex(prep.entries.map((e) => e.path)).search(q, 300);
    return hits
      .map((h) => ({ entry: prep.entries[h.index], score: h.score + boost(prep.entries[h.index]), positions: h.positions }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export const files = new FilesState();
