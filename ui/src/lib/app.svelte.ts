// The shell state: what the backend says about each space, plus what only the UI knows
// (current view, focused proposal, open overlay). Components read it, `dispatch` changes it.

import { tick } from "svelte";
import type {
  AgentNotice,
  AgentQuestion,
  Backend,
  BackendEvent,
  CheckEvent,
  FileRef,
  BranchInfo,
  GateCheck,
  HarnessTiers,
  RepoPr,
  RolePrompt,
  ReviewComment,
  VelaModelSetting,
  VelaPrompt,
  NewComment,
  ReviewNote,
  TermEvent,
  Unsubscribe,
} from "./backend";
import type { FileReview, RepoHistory } from "./backend";
import { handoffText, matchesAgent, type NextStep } from "./agents";
import { findConflicts } from "./conflicts";
import type { Pane } from "./mergeview";
import { composeMessage, cycleType, mergeAll, moveHunk, splitHunk } from "./commitplan";
import { fileKey, plural, roleLabel, ROLES, toolLabel, uniq } from "./format";
import { emptyHist, placeOf, record, step as navStep, type NavHist, type Place } from "./navhist";
import { expandPasted } from "./paste";
import { VIEWS, type Action, type Overlay, type View } from "./keymap";
import { groupLinks, isHttpUrl, makeLink } from "./links";
import { buildPaletteItems, filterPalette, type PaletteItem } from "./palette";
import { closeTab, loadRecent, openTab, pushRecent, saveRecent, type Tab } from "./tabs";
import { applyCheckEvent, checkKey, flatChecks, gateFromChecks, gateSettled, type Logs } from "./checks";
import {
  buildSections,
  clampHunk,
  fileHunks,
  initialRv,
  moveHunk as moveHunkCursor,
  moveSelection,
  reconcile,
  rowId,
  toggleSection,
  visibleRows,
  acceptLocally,
  stageLocally,
  unstageLocally,
  type FileRow,
  type Focus,
  type RvState,
  type Section,
  type Sections,
} from "./review";
import type {
  Agent,
  AgentRole,
  CheckEntry,
  CommitGroup,
  CommitRules,
  FileChange,
  Harness,
  Hunk,
  Link,
  Problem,
  RepoChecks,
  RoleDefault,
  Space,
  StackItem,
  Tier,
} from "./types";
import { repoBranch, spaceBranches } from "./types";
import { computeUpNext, readyToCommit, waitingCount, type UpNextInput, type UpNextView } from "./upnext";

const TIERS: Tier[] = ["high", "medium", "low"];
/** What the core picks for a role when the config says nothing (docs/HARNESS.md). */
export const DEFAULT_TIERS: Record<AgentRole, Tier> = {
  planner: "high",
  reviewer: "high",
  debugger: "high",
  developer: "medium",
  tester: "low",
  product: "high",
  security: "high",
};

function readCommentRole(): "reviewer" | "developer" {
  try {
    return localStorage.getItem("vela.commentRole") === "developer" ? "developer" : "reviewer";
  } catch {
    return "reviewer";
  }
}

export interface SpaceData {
  hunks: Hunk[];
  reasons: Record<string, string>;
  agents: Agent[];
  stack: StackItem[];
  status: FileChange[];
  question: AgentQuestion | null;
  notes: ReviewNote[];
  comments: ReviewComment[];
  files: FileRef[];
  links: Link[];
  checks: RepoChecks[];
}

export interface SpaceUi {
  view: View;
  /** Id of the focused proposal. */
  hi: string | null;
  /** Key (repo/path) of the file open in the code view. */
  file: string;
  /** Open tabs of the code view: pinned ones, and at most one preview. */
  tabs: Tab[];
  /** Files opened last, most recent first (quick open boosts them). */
  recent: string[];
  /** File shown in the second pane of the code view (split view), if any. */
  split?: string | null;
}

/** An agent hunk with what the UI needs to show it. */
export interface Proposal {
  hunk: Hunk;
  role: AgentRole;
  tool: string;
  why: string;
  note: ReviewNote | null;
  edited: boolean;
}

/** The commit composer: the plan the user edits before committing. */
export interface ComposerState {
  conventional: boolean;
  rules: CommitRules;
  /** The repo being committed: a commit is for one repo of the space, never all of them. */
  repo: string;
  /** Its commits. */
  groups: CommitGroup[];
  /** The proposed commits of the other repos with staged changes, by repo. */
  rest: Record<string, CommitGroup[]>;
  /** Focused commit and focused hunk inside it. */
  gi: number;
  hi: number;
  /** Validation problems by group id. */
  problems: Record<string, Problem[]>;
  /** Staged hunks by id, to show what each commit takes. */
  hunks: Record<string, Hunk>;
}

export interface GateState {
  checks: GateCheck[];
  /** The backend finished running the gate (it may have run no checks at all). */
  done: boolean;
  reason: string;
  composer: ComposerState;
}

/** A small modal asked for by a menu: confirm something, or type one value. */
export type SheetSpec =
  | {
      kind: "confirm";
      title: string;
      body: string;
      /** What is lost or changed, one line each. */
      items?: string[];
      confirmLabel: string;
      danger?: boolean;
      /** The confirm button stays disabled until this box is ticked. */
      ack?: string;
      run: () => Promise<void> | void;
    }
  | {
      kind: "pick";
      title: string;
      /** Typing filters; a name that matches nothing offers `createLabel`. */
      placeholder: string;
      items: { id: string; label: string; hint?: string; current?: boolean }[];
      createLabel?: string;
      run: (id: string) => Promise<void> | void;
    }
  | {
      kind: "prompt";
      title: string;
      label: string;
      value: string;
      submitLabel: string;
      hint?: string;
      /** Returns a message when the value is not acceptable. */
      validate?: (v: string) => string | null;
      run: (v: string) => Promise<void> | void;
    };

export class AppState {
  backend!: Backend;
  ready = $state(false);
  /** Why the first load failed after its retries; the window offers to try again. */
  bootError = $state<string | null>(null);
  spaces = $state.raw<Space[]>([]);
  data = $state.raw<Record<string, SpaceData>>({});
  ui = $state<Record<string, SpaceUi>>({});
  repos = $state.raw<string[]>([]);
  active = $state(0);
  /** Spaces hidden from the rail with "Archive". */
  archived = $state.raw<Space[]>([]);
  /** The confirmation or prompt sheet that is open (overlay "sheet"). */
  sheet = $state<SheetSpec | null>(null);
  /** Extra command bar items for the current context (set by the menus module). */
  contextItems: () => PaletteItem[] = () => [];
  /** Menu key / Shift F10 (set by the menus module). */
  onContextMenuKey: () => void = () => {};

  /** The spaces bar is hidden; it then floats in while the pointer is on the left edge. */
  railHidden = $state(readFlag("vela.railHidden", false));
  /** The hidden bar is showing, floating over the window. */
  railPeek = $state(false);
  /** The spaces bar is out of the way: hidden by hand (Ctrl B), or in the Review, which needs the width. */
  get railOff(): boolean {
    return this.railHidden || this.view === "review";
  }

  /** The file tree drawer is open. Open by default, remembered per window. */
  filesOpen = $state(readFlag("vela.filesOpen", true));
  overlay = $state<Overlay>(null);
  stackOpen = $state(false);
  /** The role and harness of the last request stay picked for the next one. */
  role = $state<AgentRole>(readRole());
  composerText = $state("");
  /** The composer opens as a large window: from the agents page, and with a text to read (a handoff, a rerun). */
  composerWide = $state(false);
  /** Harnesses Vela knows about and whether they are installed. */
  harnesses = $state.raw<Harness[]>([]);
  /** What each role gets by default, per space (the config can change it). */
  roleDefaults = $state.raw<Record<string, RoleDefault[]>>({});
  /** The harness picked in the composer (kept across requests and restarts); null: the role's default. */
  harness = $state<string | null>(readStr("vela.harness"));
  /** The tier picked in the composer; null keeps the role's default. */
  tier = $state<Tier | null>(null);
  pal = $state({ q: "", i: 0 });
  newSp = $state<{
    name: string;
    repos: string[];
    missingName: boolean;
    branch: string;
    base: string;
    /** A branch for one repo (by path) instead of `branch`. */
    repoBranches: Record<string, string>;
    ticket: string;
  }>({
    name: "",
    repos: [],
    missingName: false,
    branch: "",
    base: "",
    repoBranches: {},
    ticket: "",
  });
  /** The naming template of new branches (`[spaces] branch`). */
  branchTemplate = $state("feat/{slug}");
  /** Branches of the first repo picked in the new space sheet, for its suggestions. */
  sheetBranches = $state.raw<BranchInfo[]>([]);

  /** Load the template and the branches the new space sheet suggests. */
  async loadBranchChoices(repo: string | null) {
    try {
      const t = (await this.backend.branchNaming(""))?.template;
      if (typeof t === "string" && t.trim()) this.branchTemplate = t;
    } catch {
      /* keep the default */
    }
    if (!repo) {
      this.sheetBranches = [];
      return;
    }
    try {
      const list = await this.backend.repoBranches(repo);
      this.sheetBranches = Array.isArray(list) ? list : [];
    } catch {
      this.sheetBranches = [];
    }
  }

  /** Rename the branch of one repo, or of every repo when `repo` is left out. */
  async renameBranch(branch: string, repo?: string | null): Promise<boolean> {
    const sid = this.space.id;
    try {
      const s = await this.backend.renameBranch(sid, branch, repo ?? null);
      await this.syncSpaces();
      this.toast(repo ? `${repo} is now on ${repoBranch(s, repo)}` : `Now on ${s.branch}`);
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** Jump to another branch in one repo, or in every repo when `repo` is left out. */
  async switchBranch(branch: string, repo?: string | null): Promise<boolean> {
    try {
      const s = await this.backend.switchBranch(this.space.id, branch, repo ?? null);
      await this.syncSpaces();
      this.toast(repo ? `${repo} is now on ${repoBranch(s, repo)}` : `Now on ${spaceBranches(s).join(", ")}`);
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** Whether an agent belongs to the branch the space is on (agents from before show everywhere). */
  onThisBranch(a: Agent): boolean {
    return !a.branch || a.branch === spaceBranches(this.space).join(", ");
  }

  /** Push the branch of one repo, or of every repo when `repo` is left out. */
  async pushBranch(repo?: string | null) {
    const b = repo ? repoBranch(this.space, repo) : spaceBranches(this.space).join(", ");
    this.toast(`Pushing ${b}…`);
    try {
      const repos = await this.backend.pushBranch(this.space.id, repo ?? null);
      this.toast(`Pushed ${b} (${repos.join(", ")})`);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Set the ticket of the space; "" removes it. */
  async setTicket(ticket: string): Promise<boolean> {
    try {
      const s = await this.backend.setTicket(this.space.id, ticket);
      await this.syncSpaces();
      await this.refresh(s.id);
      this.toast(s.ticket ? `Ticket ${s.ticket}: in the Refs footer of the next commits` : "Ticket removed");
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  async setBranchTemplate(t: string) {
    try {
      this.branchTemplate = (await this.backend.setBranchTemplate(t)).template;
      this.toast("Branch naming saved");
    } catch (e) {
      this.fail(e);
    }
  }
  /** The repo sheet creates a space ("new") or adds repos to the current one ("add"). */
  sheetMode = $state<"new" | "add">("new");

  openAddRepo() {
    this.sheetMode = "add";
    this.newSp.repos = [];
    this.newSp.branch = "";
    this.repoFilter = "";
    this.overlay = "newspace";
  }

  /** Add the picked repos to the current space. */
  async addRepos() {
    const paths = [...this.newSp.repos];
    if (!paths.length) {
      this.toast("Pick a repo to add");
      return;
    }
    const id = this.space.id;
    try {
      const branch = this.newSp.branch.trim().replace(/^origin\//, "") || null;
      for (const p of paths) await this.backend.addRepoToSpace(id, p, branch);
      await this.syncSpaces();
      await this.load(id);
      this.overlay = null;
      this.sheetMode = "new";
      this.newSp.repos = this.defaultRepos();
      this.newSp.branch = "";
      this.toast(`Added ${paths.map((p) => p.split("/").pop()).join(", ")} to ${this.space.name}`);
    } catch (e) {
      this.fail(e);
    }
  }

  /** An older space worked in a Vela worktree: move the repo and its uncommitted work into the clone. */
  async moveRepoIntoClone(repo: string) {
    const id = this.space.id;
    try {
      const s = await this.backend.moveRepoIntoClone(id, repo);
      await this.syncSpaces();
      await this.load(id);
      const r = s.repos.find((x) => x.name === repo);
      this.toast(`${repo} now works in ${r?.source ?? "your clone"}`);
    } catch (e) {
      this.fail(e);
    }
  }

  async removeRepo(repo: string) {
    const id = this.space.id;
    try {
      await this.backend.removeRepoFromSpace(id, repo);
      await this.syncSpaces();
      await this.load(id);
      this.toast(`Removed ${repo} from ${this.space.name}`);
    } catch (e) {
      this.fail(e);
    }
  }
  /** Id of the space this window is pinned to (`#space-<id>`), null in the main window. */
  pinned = $state<string | null>(null);
  gate = $state<GateState | null>(null);
  /** The page of each space (Markdown), loaded when first shown. `editing`: the editor is open. */
  pages = $state<Record<string, { text: string; loaded: boolean }>>({});
  pageEditing = $state(false);
  private pageTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  toastState = $state<{ id: number; text: string; action?: { label: string; run: () => void } } | null>(null);
  /** Hunks accepted with E, to label them "edited by you". */
  edited = $state<Record<string, true>>({});
  /** Bumped when a file changed under the editor (accept, undo, fix), so the editor reloads it. */
  contentRev = $state<Record<string, number>>({});
  /** Ask the code view to put the cursor on a line (absolute number) of a file. */
  focusRequest = $state<{ file: string; line: number; seq: number } | null>(null);

  /** Review view state per space: selection, collapsed sections, focus, hunk cursor. */
  rv = $state<Record<string, RvState>>({});
  /** Live output of the checks per space. */
  checkLogs = $state.raw<Record<string, Logs>>({});
  /** Width in px of the file column; 0 means the default (about 34%). */
  rvWidth = $state(0);
  /** The Review diff shows before and after side by side (V), remembered per window. */
  rvSplit = $state(readFlag("vela.rvSplit", false));
  /** What the diff of a file with agent changes compares: your file now, or the last commit. */
  rvCompare: "incoming" | "commit" = $state("incoming");

  /** Markdown files shown as source instead of the preview (key `space:repo/path`). */
  mdSource = $state<Record<string, true>>({});
  /** Bumped by Ctrl F so the code view opens its find bar. */
  findSeq = $state(0);
  /** The pane of the code view that has the focus: Ctrl F and the change keys go to it. */
  activePane = $state<"main" | "split">("main");

  /** The terminal panel at the bottom is open, remembered per window. */
  termOpen = $state(readFlag("vela.termOpen", false));
  /** The terminal panel on top is open, remembered per window. */
  termTopOpen = $state(readFlag("vela.termTopOpen", false));
  /** Terminals of every space, in the order they were opened. */
  terms = $state<TermTab[]>([]);
  /** The terminal shown, per space and panel (see `termKey`). */
  termActive = $state<Record<string, number>>({});
  /** Share of the view each panel takes when it is alone (half by default). */
  termFrac = $state({ bottom: 0.5, top: 0.5 });
  /** Share of the height the top panel takes when both are open. */
  termSplit = $state(0.5);
  /** Bumped when a terminal should take the focus: the shown one of `termFocusDock`. */
  termFocusSeq = $state(0);
  termFocusDock = $state<TermDock>("bottom");
  /** Where the output of each terminal goes once its view is up; buffered until then. */
  private termSinks = new Map<number, (data: string) => void>();
  private termBuf = new Map<number, string[]>();
  private offTerm: Unsubscribe | null = null;

  /** Tier settings of every harness (overlay "settings"). */
  tierSettings = $state.raw<HarnessTiers[]>([]);
  /** The tab of the settings sheet. */
  settingsTab = $state<"tiers" | "prompts" | "branches">("tiers");
  /** The settings were fetched at least once (the sheet shows the cached ones meanwhile). */
  settingsLoaded = $state(false);
  /** Model names per harness, loaded after the sheet is open. */
  agentModelList = $state.raw<Record<string, string[]>>({});
  rolePrompts = $state.raw<RolePrompt[]>([]);
  velaPrompt = $state.raw<VelaPrompt | null>(null);

  /** Pull requests per space, fetched with the GitHub CLI when the PRs view opens. */
  prs = $state.raw<Record<string, { list: RepoPr[]; at: number; loading: boolean; error: string | null }>>({});

  private off: Unsubscribe | null = null;
  private offCheck: Unsubscribe | null = null;
  private offAgent: Unsubscribe | null = null;
  private agentTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  private toastSeq = 0;
  private gateSeq = 0;
  private focusSeq = 0;
  private valSeq: Record<string, number> = {};

  // -- boot -----------------------------------------------------------------

  async init(backend: Backend, pinned: string | null = null) {
    this.backend = backend;
    this.pinned = pinned;
    this.off?.();
    this.off = backend.onChange((e) => void this.onEvent(e));
    this.offCheck?.();
    this.offCheck = backend.onCheck((e) => this.onCheckEvent(e));
    this.offAgent?.();
    this.offAgent = backend.onAgent((n) => this.onAgentEvent(n));
    this.offTerm?.();
    this.offTerm = backend.onTerm((e) => this.onTermEvent(e));
    void this.loadHarnesses();
    await this.boot();
  }

  /**
   * The first load. A call can fail while the backend starts (a git lock taken by the watchers,
   * say): it is tried again a few times, then the window says why instead of staying blank.
   */
  async boot(tries = 5) {
    const b = this.backend;
    this.bootError = null;
    for (let n = 1; ; n++) {
      try {
        this.repos = await b.listRepos();
        this.newSp.repos = this.defaultRepos();
        this.spaces = this.forThisWindow(await b.listSpaces());
        await Promise.all(this.spaces.map((s) => this.load(s.id)));
        await this.loadArchived();
        this.ready = true;
        return;
      } catch (e) {
        console.error(`vela: first load, try ${n}`, e);
        if (n >= tries) {
          this.bootError = e instanceof Error ? e.message : String(e);
          return;
        }
        await new Promise((r) => setTimeout(r, 250 * n));
      }
    }
  }

  /** Refresh the list of archived spaces (the main window only; a pinned window has none). */
  async loadArchived() {
    if (this.pinned) {
      this.archived = [];
      return;
    }
    this.archived = await this.backend.listArchived().catch((): Space[] => []);
  }

  destroy() {
    this.off?.();
    this.offCheck?.();
    this.offAgent?.();
    this.offTerm?.();
    for (const t of this.terms) void this.backend.termClose(t.id).catch(() => {});
    for (const t of Object.values(this.agentTimers)) clearTimeout(t);
  }

  /** A pinned window shows its one space only. */
  private forThisWindow(list: Space[]): Space[] {
    const pin = this.pinned;
    list = list.filter((s) => !this.removing.has(s.id));
    return pin ? list.filter((s) => s.id === pin) : list;
  }

  /** The repo preselected in the new space sheet: "api" when there is one, else none. */
  private defaultRepos(): string[] {
    return this.repos.includes("api") ? ["api"] : [];
  }

  /** Refresh the list of spaces, loading the data of new ones before they are shown. */
  async syncSpaces() {
    const list = this.forThisWindow(await this.backend.listSpaces());
    await Promise.all(list.filter((s) => !this.data[s.id]).map((s) => this.load(s.id)));
    this.spaces = list;
    this.forget(list);
  }

  /** Drop what is held for spaces that are gone (removed): their data, ui state and counters. */
  private forget(alive: Space[]) {
    const keep = new Set(alive.map((s) => s.id));
    const gone = Object.keys(this.data).filter((id) => !keep.has(id));
    if (!gone.length) return;
    this.data = Object.fromEntries(Object.entries(this.data).filter(([id]) => keep.has(id)));
    for (const id of gone) {
      delete this.ui[id];
      delete this.contentRev[id];
    }
  }

  /** Spaces being removed: hidden even while the backend still lists them. */
  removing = new Set<string>();

  /** Hide a space at once, before the backend has finished removing it. */
  hideSpace(id: string) {
    this.removing.add(id);
    this.spaces = this.spaces.filter((s) => s.id !== id);
    this.forget(this.spaces);
  }

  private async onEvent(e: BackendEvent) {
    const was = this.spaces.find((s) => s.id === e.spaceId);
    const wasOn = was ? spaceBranches(was).join(", ") : "";
    await this.syncSpaces();
    // Switched elsewhere (a terminal, another editor): follow it, and say so.
    const now = this.spaces.find((s) => s.id === e.spaceId);
    if (was && now && spaceBranches(now).join(", ") !== wasOn && !e.toast) {
      this.toast(`Now on ${spaceBranches(now).join(", ")}: agents and changes follow the branch`);
      if (e.spaceId === this.space.id) void this.loadHistory(e.spaceId);
    }
    if (!this.data[e.spaceId] || !this.spaces.some((s) => s.id === e.spaceId)) return;
    try {
      await this.load(e.spaceId, e.kind === "file");
    } catch (err) {
      // The space went away while it reloaded (removed, archived): nothing to show.
      if (this.spaces.some((s) => s.id === e.spaceId)) this.fail(err);
      return;
    }
    if (e.kind !== "file") this.contentRev[e.spaceId] = (this.contentRev[e.spaceId] ?? 0) + 1;
    if (e.toast) this.toast(e.toast);
  }

  private loadJobs: Record<string, Promise<void> | undefined> = {};
  private loadAgain: Record<string, boolean> = {};

  /**
   * Reload everything the backend knows about a space. Calls that come while a reload runs
   * share it, and one more reload follows it: an action and the change event it causes cost
   * two reloads at most, and every caller sees data newer than its call.
   */
  load(id: string, light = false): Promise<void> {
    const running = this.loadJobs[id];
    if (running) {
      this.loadAgain[id] = true;
      return running;
    }
    const job = (async () => {
      try {
        do {
          this.loadAgain[id] = false;
          await this.loadOnce(id, light);
        } while (this.loadAgain[id]);
      } finally {
        delete this.loadJobs[id];
      }
    })();
    this.loadJobs[id] = job;
    return job;
  }

  private async loadOnce(id: string, light: boolean) {
    const b = this.backend;
    const [hunks, reasons, agents, stack, status, question, notes, files, links, checks, comments] = await Promise.all([
      b.hunks(id),
      b.reasons(id),
      b.agents(id),
      b.stack(id),
      b.status(id),
      b.question(id),
      b.notes(id),
      b.listFiles(id),
      b.links(id).catch((): Link[] => []),
      b.checks(id).catch((): RepoChecks[] => []),
      b.comments(id).catch((): ReviewComment[] => []),
    ]);
    const before = this.rv[id] ? this.rowsOf(id) : [];
    const prevIndex = before.findIndex((r) => r.id === this.rv[id]?.sel);
    this.data = { ...this.data, [id]: { hunks, reasons, agents, stack, status, question, notes, files, links, checks, comments } };
    if (!light || !this.ui[id]) this.ensureUi(id);
    this.syncRv(id, prevIndex);
  }

  // -- review view ----------------------------------------------------------

  sectionsOf(id: string): Sections {
    const d = this.data[id];
    return buildSections(d?.status ?? [], d?.hunks ?? []);
  }
  private rowsOf(id: string): FileRow[] {
    return visibleRows(this.sectionsOf(id), (this.rv[id] ?? initialRv()).collapsed);
  }
  /** Re-validate the selection after the data changed and point `hi` at the hunk under the cursor. */
  private syncRv(id: string, prevIndex = 0) {
    const st = this.rv[id] ?? initialRv();
    const rows = this.rowsOf(id);
    let next = reconcile(st, rows, prevIndex);
    if (st.sel === null) {
      // First look: open on the proposal the space points at, else on the first file.
      const hi = this.data[id].hunks.find((h) => h.id === this.ui[id]?.hi);
      const want = hi && hi.state === "pending" ? rowId(hi.repo, hi.path) : null;
      if (want && rows.some((r) => r.id === want)) next = { ...next, sel: want };
    }
    const row = rows.find((r) => r.id === next.sel);
    const count = row ? fileHunks(this.data[id].hunks, row.repo, row.path).length : 0;
    next = clampHunk(next, count);
    this.rv[id] = next;
    this.syncHi(id);
  }
  private syncHi(id: string) {
    const u = this.ui[id];
    if (!u) return;
    const h = this.currentHunkOf(id);
    if (h) u.hi = h.id;
  }
  private currentHunkOf(id: string): Hunk | null {
    const st = this.rv[id];
    const row = st && this.rowsOf(id).find((r) => r.id === st.sel);
    if (!row) return null;
    return fileHunks(this.data[id].hunks, row.repo, row.path)[st.hunk] ?? null;
  }

  get sections(): Sections {
    return this.sectionsOf(this.space.id);
  }
  get rvs(): RvState {
    return this.rv[this.space.id] ?? initialRv();
  }
  get rows(): FileRow[] {
    return visibleRows(this.sections, this.rvs.collapsed);
  }
  get selectedRow(): FileRow | null {
    return this.rows.find((r) => r.id === this.rvs.sel) ?? null;
  }
  /** Every hunk of the selected file with its state. */
  get selectedHunks(): Hunk[] {
    const r = this.selectedRow;
    return r ? fileHunks(this.sd.hunks, r.repo, r.path) : [];
  }
  get currentHunk(): Hunk | null {
    return this.selectedHunks[this.rvs.hunk] ?? null;
  }
  get checkRepos(): RepoChecks[] {
    return this.sd.checks;
  }
  get focusedCheck(): CheckEntry | null {
    const all = flatChecks(this.sd.checks);
    return all.find((c) => checkKey(c.repo, c.id) === this.rvs.check) ?? null;
  }
  logOf(repo: string, id: string): string[] {
    return this.checkLogs[this.space.id]?.[checkKey(repo, id)] ?? [];
  }
  /** The gate rows: real check results first, then whatever the backend gate says. */
  get gateRows() {
    return [...gateFromChecks(this.sd.checks), ...(this.gate?.checks ?? [])];
  }

  private setRv(patch: Partial<RvState>) {
    const id = this.space.id;
    this.rv[id] = { ...this.rvs, ...patch };
    this.syncHi(id);
  }

  rvSelect(rowId: string) {
    this.setRv({ sel: rowId, hunk: 0, focus: "files" });
  }
  /** The file you scrolled to, or clicked in, in the stack of diffs: it becomes the selected one. */
  rvSeen(rowId: string, focus: Focus = this.rvs.focus) {
    if (this.rvs.sel !== rowId || this.rvs.focus !== focus) this.setRv({ sel: rowId, hunk: 0, focus });
  }
  rvToggleSection(sec: Section) {
    const id = this.space.id;
    const idx = this.rows.findIndex((r) => r.id === this.rvs.sel);
    this.rv[id] = toggleSection(this.rvs, sec);
    this.syncRv(id, idx);
  }
  rvFile(delta: 1 | -1) {
    this.rv[this.space.id] = moveSelection(this.rvs, this.rows, delta);
    this.setRv({ focus: "files" });
  }
  /** Tab, Shift Tab: next, previous change of the file in the diff. */
  rvChange(delta: 1 | -1) {
    if (!this.pane) return;
    const ok = delta > 0 ? this.pane.next() : this.pane.prev();
    if (!ok && this.selectedRow) this.toast(delta > 0 ? "Last change of the file. J for the next file" : "First change of the file");
  }
  rvHunkMove(delta: 1 | -1) {
    this.rv[this.space.id] = moveHunkCursor(this.rvs, this.selectedHunks.length, delta);
    this.setRv({ focus: "diff" });
  }
  rvHunkSet(i: number) {
    this.setRv({ hunk: i, focus: "diff" });
  }
  rvFocusDiff() {
    this.setRv({ focus: "diff" });
  }
  /** Put the cursor on a hunk, selecting the row it lives in. */
  rvLocate(hunkId: string) {
    const h = this.sd.hunks.find((x) => x.id === hunkId);
    if (!h) return;
    const row = this.rows.find((r) => r.repo === h.repo && r.path === h.path);
    if (!row) return;
    const i = fileHunks(this.sd.hunks, h.repo, h.path).findIndex((x) => x.id === hunkId);
    this.setRv({ sel: row.id, hunk: Math.max(0, i) });
  }

  /** Show the result of a change at once; the reload after the backend call settles it. */
  private optimistic(sid: string, f: (status: FileChange[], hunks: Hunk[]) => { status: FileChange[]; hunks: Hunk[] }) {
    const d = this.data[sid];
    if (!d) return;
    const prev = this.rowsOf(sid).findIndex((r) => r.id === this.rv[sid]?.sel);
    this.data = { ...this.data, [sid]: { ...d, ...f(d.status, d.hunks) } };
    this.syncRv(sid, prev);
  }

  /** Pending proposals of agents, of one file or of all. */
  private pendingAgentHunks(sid: string, file?: FileRow): Hunk[] {
    return (this.data[sid]?.hunks ?? []).filter(
      (h) => h.state === "pending" && h.origin.type === "agent" && (!file || (h.repo === file.repo && h.path === file.path)),
    );
  }

  /**
   * Accept files: what the Review shows for each (the agents' changes merged into your file,
   * or what you made of it in the diff) is written and the file is staged. A file with
   * conflicts left is not touched; the toast says which.
   */
  private async approveRows(sid: string, rows: FileRow[]) {
    if (!rows.length) return;
    const blocked = rows.filter((r) => this.conflictsLeft(sid, r) > 0);
    if (rows.length === 1 && blocked.length) {
      const n = this.conflictsLeft(sid, rows[0]);
      this.toast(`${n === 1 ? "1 conflict" : `${n} conflicts`} left in ${rows[0].path}: keep your lines or the agent's on each first`);
      const c = findConflicts(this.rvTextOf(sid, rows[0]) ?? "")[0];
      if (c) this.pane?.reveal(c.line);
      return;
    }
    const go = rows.filter((r) => !blocked.includes(r));
    const ids = go.flatMap((r) => this.pendingAgentHunks(sid, r).map((h) => h.id));
    this.advanceFrom(sid, go);
    this.optimistic(sid, (st, hs) => {
      const a = acceptLocally(st, hs, ids);
      const b = stageLocally(a.status, a.hunks, go);
      return { status: b.status, hunks: b.hunks.map((h) => (go.some((r) => r.repo === h.repo && r.path === h.path) && h.state === "pending" && h.origin.type === "you" ? { ...h, state: "staged" } : h)) };
    });
    const left: string[] = blocked.map((r) => r.path);
    try {
      const drafted = go.filter((r) => this.rvDrafts[draftKey(sid, r.id)] !== undefined);
      for (const r of drafted) {
        await this.backend.acceptFile(sid, r.repo, r.path, this.rvDrafts[draftKey(sid, r.id)]);
        delete this.rvDrafts[draftKey(sid, r.id)];
      }
      const rest = go.filter((r) => !drafted.includes(r));
      if (rest.length) left.push(...(await this.backend.acceptFiles(sid, rest.map((r) => ({ repo: r.repo, path: r.path })))));
    } catch (e) {
      this.fail(e);
    }
    if (left.length) this.toast(left.length === 1 ? `Left for you, conflicts with your edits: ${left[0]}` : `${left.length} files left for you: conflicts with your edits`);
    await this.refresh(sid);
  }
  /** Conflict blocks left in what accepting a file would write (known once its review loaded). */
  conflictsLeft(sid: string, r: FileRow): number {
    const t = this.rvTextOf(sid, r);
    return t ? findConflicts(t).length : 0;
  }
  /** What accepting a file writes: your draft in the diff, else the merged result. */
  rvTextOf(sid: string, r: FileRow): string | null {
    const d = this.rvDrafts[draftKey(sid, r.id)];
    if (d !== undefined) return d;
    const fr = this.reviews[draftKey(sid, r.id)];
    return fr && fr.agents.length ? fr.result : null;
  }
  /** After the selected file leaves "To review", select the next one still waiting. */
  private advanceFrom(sid: string, rows: FileRow[]) {
    const sel = this.rv[sid]?.sel;
    if (!sel || !rows.some((r) => r.id === sel)) return;
    const list = this.sectionsOf(sid).review.flatMap((g) => g.files);
    const i = list.findIndex((r) => r.id === sel);
    const rest = list.filter((r) => !rows.some((x) => x.id === r.id));
    const next = rest.find((r) => list.indexOf(r) > i) ?? rest[rest.length - 1];
    if (next) this.rv[sid] = { ...(this.rv[sid] ?? initialRv()), sel: next.id, hunk: 0 };
  }
  private async unstageRows(sid: string, rows: FileRow[]) {
    if (!rows.length) return;
    for (const h of this.data[sid].hunks) if (rows.some((r) => r.repo === h.repo && r.path === h.path)) delete this.edited[`${sid}:${h.id}`];
    this.optimistic(sid, (st, hs) => unstageLocally(st, hs, rows));
    try {
      await this.backend.unstageFiles(sid, rows.map((r) => ({ repo: r.repo, path: r.path })));
    } catch (e) {
      this.fail(e);
    }
    await this.refresh(sid);
  }
  private failedToApply(failed: string[]) {
    if (failed.length) this.toast(failed.length === 1 ? failed[0] : `${failed.length} proposals did not apply: ${failed[0]}`);
  }

  /** Space: accept the selected file, or take an accepted one back to review. */
  async rvToggleFile() {
    const r = this.selectedRow;
    if (r) await this.rvStageRow(r);
  }
  /** Accept one file (or take it back to review when it is accepted). */
  async rvStageRow(r: FileRow) {
    const sid = this.space.id;
    if (r.section === "done") {
      delete this.rvDrafts[draftKey(sid, r.id)];
      return this.unstageRows(sid, [r]);
    }
    return this.approveRows(sid, [r]);
  }
  /** Reject every proposal of agents in one file; your own edits stay. */
  async rvRejectRow(r: FileRow) {
    const sid = this.space.id;
    const ids = this.pendingAgentHunks(sid, r).map((h) => h.id);
    if (!ids.length) return this.toast("No change of an agent in this file. Your own edits are never thrown away here");
    if (!r.mine) this.advanceFrom(sid, [r]);
    delete this.rvDrafts[draftKey(sid, r.id)];
    this.optimistic(sid, (st, hs) => ({ status: st, hunks: hs.map((h) => (ids.includes(h.id) ? { ...h, state: "rejected" } : h)) }));
    try {
      await this.backend.rejectFile(sid, r.repo, r.path);
      this.toast(`Rejected the agent's changes in ${r.path.slice(r.path.lastIndexOf("/") + 1)}`);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh(sid);
  }
  /** N: reject the agents' changes in the selected file. */
  rvRejectSelected() {
    const r = this.selectedRow;
    if (r) return this.rvRejectRow(r);
  }
  /** E: open the selected file in the editor, at the line of the diff cursor. */
  rvOpenInEditor() {
    const r = this.selectedRow;
    if (!r) return;
    this.gotoLine(fileKey(r.repo, r.path), this.pane?.line() ?? 1);
  }

  // The diff of the selected file, as the Review shows it.
  /** What accepting each file gives, by `space|row`. */
  reviews: Record<string, FileReview> = $state({});
  /** What you made of a file in the diff (typed, reverted a change, resolved a conflict), by `space|row`. */
  rvDrafts: Record<string, string> = $state({});
  /** The diff editor on screen, for the keys that act in it. */
  pane: Pane | null = null;
  /** Latest load of each file: an older answer never overwrites a newer one. */
  private reviewSeq: Record<string, number> = {};
  /** Load (or reload) what accepting a file gives. */
  async loadReview(sid: string, r: FileRow) {
    const k = draftKey(sid, r.id);
    const seq = (this.reviewSeq[k] = (this.reviewSeq[k] ?? 0) + 1);
    try {
      const raw = await this.backend.reviewFile(sid, r.repo, r.path);
      const fr: FileReview = {
        repo: r.repo,
        path: r.path,
        mine: raw?.mine ?? null,
        result: raw?.result ?? null,
        head: raw?.head ?? null,
        conflicts: raw?.conflicts ?? 0,
        notes: raw?.notes ?? [],
        agents: raw?.agents ?? [],
        binary: !!raw?.binary,
      };
      if (seq === this.reviewSeq[k]) this.reviews = { ...this.reviews, [k]: fr };
    } catch (e) {
      // A file that just went away: the list moves on, nothing to say.
      if (this.sections.review.concat(this.sections.done).some((g) => g.files.some((x) => x.id === r.id))) this.fail(e);
    }
  }
  setDraft(sid: string, r: FileRow, text: string | null) {
    const k = draftKey(sid, r.id);
    if (text === null) {
      if (k in this.rvDrafts) delete this.rvDrafts[k];
    } else if (this.rvDrafts[k] !== text) this.rvDrafts[k] = text;
  }
  async rvStageAll() {
    return this.rvApproveAll();
  }
  async rvUnstageAll() {
    const rows = this.sections.done.flatMap((g) => g.files);
    if (!rows.length) return this.toast("Nothing is accepted yet");
    await this.unstageRows(this.space.id, rows);
  }
  async rvAcceptAll() {
    return this.rvApproveAll();
  }
  /** Accept the files waiting among these (a folder of the tree). */
  async rvApproveRows(rows: FileRow[]) {
    const list = rows.filter((r) => r.section === "review");
    if (list.length) await this.approveRows(this.space.id, list);
  }
  /** Shift A: accept every file waiting, in one go. */
  async rvApproveAll() {
    const sid = this.space.id;
    const rows = this.sections.review.flatMap((g) => g.files);
    if (!rows.length) return this.toast(this.readyToCommit ? "Everything is accepted. Press C to commit" : "Nothing waits for review");
    await this.approveRows(sid, rows);
    if (!this.sections.counts.review && this.readyToCommit) this.toast("Everything is accepted. Press C to commit");
  }
  /** Y on the hunk under the cursor: stage it (accept it when an agent proposed it). */
  async rvHunkStage() {
    const h = this.currentHunk;
    if (!h) return;
    if (h.state === "staged") return this.toast("Already staged");
    if (h.origin.type === "agent") {
      this.cui.hi = h.id;
      return this.decide("accept");
    }
    const sid = this.space.id;
    try {
      await this.backend.stageHunk(sid, h.id);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh(sid);
  }
  async rvHunkUnstage() {
    const h = this.currentHunk;
    if (!h) return;
    if (h.state !== "staged") return this.toast("This hunk is not staged");
    const sid = this.space.id;
    delete this.edited[`${sid}:${h.id}`];
    try {
      await this.backend.unstageHunk(sid, h.id);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh(sid);
  }
  /** N: reject an agent proposal. Your own edits are never discarded from here. */
  rvHunkReject() {
    const h = this.currentHunk;
    if (!h) return;
    if (h.origin.type !== "agent") return this.toast("Your own changes are never discarded here");
    if (h.state !== "pending") return this.toast("Only pending proposals can be rejected");
    this.cui.hi = h.id;
    return this.decide("reject");
  }

  // -- checks ---------------------------------------------------------------

  onCheckEvent(e: CheckEvent) {
    const d = this.data[e.spaceId];
    if (!d) return;
    const logs = this.checkLogs[e.spaceId] ?? {};
    const r = applyCheckEvent(d.checks, logs, e);
    if (r.repos !== d.checks) this.data = { ...this.data, [e.spaceId]: { ...d, checks: r.repos } };
    if (r.logs !== logs) this.checkLogs = { ...this.checkLogs, [e.spaceId]: r.logs };
  }
  async runChecks(ids?: string[], force = false) {
    try {
      await this.backend.runChecks(this.space.id, ids, force);
    } catch (e) {
      this.fail(e);
    }
  }
  rvRunFocused() {
    const c = this.focusedCheck;
    if (!c) return this.toast("Click a check or press Shift J to pick one");
    if (c.missing) return this.toast(`${c.command.split(" ")[0]} is not installed`);
    void this.runChecks([c.id], true);
  }
  rvCheckMove(delta: 1 | -1) {
    const all = flatChecks(this.sd.checks);
    if (!all.length) return;
    const cur = all.findIndex((c) => checkKey(c.repo, c.id) === this.rvs.check);
    const next = all[Math.max(0, Math.min(all.length - 1, cur < 0 ? 0 : cur + delta))];
    this.setRv({ check: checkKey(next.repo, next.id), focus: "checks" });
  }
  focusCheck(c: CheckEntry) {
    this.setRv({ check: checkKey(c.repo, c.id), focus: "checks" });
  }
  /** O or a click: open or close the log of the focused check. */
  async rvToggleLog() {
    const c = this.focusedCheck;
    if (!c) return;
    const k = checkKey(c.repo, c.id);
    if (this.rvs.open === k) return this.setRv({ open: null });
    this.setRv({ open: k });
    const sid = this.space.id;
    if (!(this.checkLogs[sid]?.[k]?.length ?? 0)) {
      try {
        const text = await this.backend.checkLog(sid, c.repo, c.id);
        if (text && !(this.checkLogs[sid]?.[k]?.length ?? 0)) {
          const lines = text.split("\n").filter((_, i, a) => i < a.length - 1 || a[i] !== "");
          this.checkLogs = { ...this.checkLogs, [sid]: { ...(this.checkLogs[sid] ?? {}), [k]: lines } };
        }
      } catch (e) {
        this.fail(e);
      }
    }
  }
  async setCheckEnabled(c: CheckEntry, enabled: boolean) {
    try {
      await this.backend.setCheckEnabled(this.space.id, c.repo, c.id, enabled);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh();
    if (enabled && c.when === "staged" && this.staged.length) void this.runChecks([c.id]);
  }
  async setAuto(repo: string, auto: boolean) {
    try {
      await this.backend.setChecksAuto(this.space.id, repo, auto);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh();
  }
  /** `checks.auto` as shown in the panel header: on when every repo with checks has it on. */
  get autoOn(): boolean {
    const rs = this.sd.checks.filter((r) => r.checks.length);
    return rs.length > 0 && rs.every((r) => r.auto);
  }
  async toggleAutoAll() {
    const on = !this.autoOn;
    for (const r of this.sd.checks.filter((x) => x.checks.length)) await this.setAuto(r.repo, on);
  }

  private ensureUi(id: string) {
    if (this.ui[id]) return;
    const d = this.data[id];
    const pending = d.hunks.filter((h) => h.origin.type === "agent" && h.state === "pending");
    const first = pending[0] ?? d.hunks.find((h) => h.origin.type === "agent");
    const file = first ? fileKey(first.repo, first.path) : d.files[0] ? fileKey(d.files[0].repo, d.files[0].path) : "";
    // Tabs: the files agents touched, plus the one shown. The tree opens the others.
    let tabs: Tab[] = [];
    for (const h of d.hunks) if (h.origin.type === "agent") tabs = openTab(tabs, fileKey(h.repo, h.path), true);
    if (file) tabs = openTab(tabs, file, true);
    this.ui[id] = {
      view: d.question ? "agents" : pending.length ? "review" : "code",
      hi: first?.id ?? null,
      file,
      tabs,
      recent: loadRecent(id),
    };
  }

  // -- derived --------------------------------------------------------------

  get space(): Space {
    return this.spaces[this.active];
  }
  get sd(): SpaceData {
    return this.data[this.space.id];
  }
  get cui(): SpaceUi {
    return this.ui[this.space.id];
  }
  get view(): View {
    return this.cui.view;
  }
  get elsewhere(): boolean {
    return !this.pinned && (this.space.window ?? null) !== null;
  }

  proposalsOf(i: number): Proposal[] {
    const s = this.spaces[i];
    const d = s && this.data[s.id];
    if (!d) return [];
    return d.hunks.flatMap((hunk) => {
      if (hunk.origin.type !== "agent") return [];
      const agentId = hunk.origin.agent;
      const agent = d.agents.find((a) => a.id === agentId);
      return [
        {
          hunk,
          role: agent?.role ?? "developer",
          tool: agent?.tool ?? "claude",
          why: d.reasons[hunk.id] ?? "",
          note: d.notes.find((n) => n.hunkId === hunk.id && !n.resolved) ?? d.notes.find((n) => n.hunkId === hunk.id) ?? null,
          edited: !!this.edited[`${s.id}:${hunk.id}`],
        },
      ];
    });
  }
  get proposals(): Proposal[] {
    return this.proposalsOf(this.active);
  }
  get pending(): Proposal[] {
    return this.proposals.filter((p) => p.hunk.state === "pending");
  }
  get accepted(): Proposal[] {
    return this.proposals.filter((p) => p.hunk.state === "staged");
  }
  get rejected(): Proposal[] {
    return this.proposals.filter((p) => p.hunk.state === "rejected");
  }
  /** The lines you typed, as hunks. */
  get mine(): Hunk[] {
    return this.sd.hunks.filter((h) => h.origin.type === "you");
  }
  /** The focused proposal; falls back on the first pending one. */
  get focused(): Proposal | null {
    const all = this.proposals;
    if (this.view === "code") {
      // Only the proposals drawn in the open file can be focused, so Y never accepts something unseen.
      const inFile = this.pending.filter((p) => fileKey(p.hunk.repo, p.hunk.path) === this.cui.file);
      return inFile.find((p) => p.hunk.id === this.cui.hi) ?? inFile[0] ?? null;
    }
    if (this.view === "review") return all.find((p) => p.hunk.id === this.cui.hi) ?? null;
    return all.find((p) => p.hunk.id === this.cui.hi) ?? all.find((p) => p.hunk.state === "pending") ?? all[0] ?? null;
  }

  stagedOf(i: number): FileRef[] {
    const s = this.spaces[i];
    const d = s && this.data[s.id];
    return d ? d.status.filter((c) => c.staged).map((c) => ({ repo: c.repo, path: c.path })) : [];
  }
  get staged(): FileRef[] {
    return this.stagedOf(this.active);
  }

  inputFor(i: number): UpNextInput {
    const s = this.spaces[i];
    const d = this.data[s.id];
    const q = d.question;
    return {
      window: s.window ?? null,
      branch: s.branch,
      question: q ? { tool: toolLabel(q.tool), text: q.text } : null,
      pending: this.proposalsOf(i)
        .filter((p) => p.hunk.state === "pending")
        .map((p) => ({ repo: p.hunk.repo, tool: toolLabel(p.tool) })),
      staged: this.stagedOf(i),
      nextWaiting: null,
    };
  }
  waitingOf(i: number): number {
    return waitingCount(this.inputFor(i));
  }
  /** Index of the next other space in this window that has something waiting. */
  get nextWaitingSpace(): number | null {
    const n = this.spaces.length;
    for (let j = 1; j <= n; j++) {
      const k = (this.active + j) % n;
      if (k !== this.active && this.waitingOf(k) > 0 && (this.spaces[k].window ?? null) === null) return k;
    }
    return null;
  }
  get upNext(): UpNextView {
    const other = this.nextWaitingSpace;
    return computeUpNext({ ...this.inputFor(this.active), nextWaiting: other === null ? null : this.spaces[other].name });
  }
  get readyToCommit(): boolean {
    return readyToCommit(this.inputFor(this.active));
  }

  get paletteItems(): PaletteItem[] {
    const items = buildPaletteItems({
      upNextTitle: this.upNext.title,
      links: this.sd.links,
      spaces: this.spaces.map((s) => ({
        name: s.name,
        branch: s.branch,
        color: s.color,
        files: this.data[s.id].files.map((f) => ({ id: fileKey(f.repo, f.path), repo: f.repo, path: f.path })),
      })),
    });
    // The actions of the current context ("Here") come right after the general actions.
    const at = items.findIndex((x) => x.sec !== "Actions");
    items.splice(at < 0 ? items.length : at, 0, ...this.contextItems());
    return filterPalette(items, this.pal.q);
  }

  get links(): Link[] {
    return this.sd.links;
  }
  /** Links Vela finds by itself (ticket, branch, commits, repo files): shown on the space page. */
  get detectedLinks(): Link[] {
    return groupLinks(this.sd.links.filter((l) => l.source !== "manual" && l.source !== "paste"));
  }

  get cc(): ComposerState | null {
    return this.gate?.composer ?? null;
  }
  /** Every commit has a subject and no validation problem. */
  get composerOk(): boolean {
    const c = this.cc;
    if (!c || !c.groups.length) return false;
    return c.groups.every((g) => g.subject.trim() !== "" && !c.problems[g.id]?.length);
  }

  get gateOk(): boolean {
    const g = this.gate;
    if (!g || !g.done || !gateSettled(this.sd.checks)) return false;
    return this.gateRows.every((c) => c.pass) || g.reason.trim().length > 3;
  }

  // -- helpers --------------------------------------------------------------

  /** A short message; with an action (Undo...), it stays longer and shows a button. */
  toast(text: string, action?: { label: string; run: () => void }) {
    const id = ++this.toastSeq;
    this.toastState = { id, text, action };
    setTimeout(
      () => {
        if (this.toastState?.id === id) this.toastState = null;
      },
      action ? 8000 : 2400,
    );
  }

  // -- your changes in the code view ------------------------------------------

  /** Bumped by Ctrl Alt Up / Down: the code view goes to the previous or next change. */
  changeMove = $state({ seq: 0, delta: 1 as 1 | -1 });

  /** Your hunks (staged or not) of a file, top to bottom. */
  myHunksOf(key: string): Hunk[] {
    return this.sd.hunks
      .filter((h) => h.origin.type === "you" && h.state !== "rejected" && fileKey(h.repo, h.path) === key)
      .sort((a, b) => a.newStart - b.newStart);
  }

  async stageMine(hunkId: string, stage: boolean) {
    const sid = this.space.id;
    try {
      if (stage) await this.backend.stageHunk(sid, hunkId);
      else await this.backend.unstageHunk(sid, hunkId);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh(sid);
  }

  /** Put back the content a revert replaced, then reload. */
  private undoRevert(sid: string, repo: string, path: string, content: string) {
    void this.backend
      .writeFile(sid, repo, path, content)
      .then(() => this.refresh(sid))
      .then(() => {
        this.contentRev[sid] = (this.contentRev[sid] ?? 0) + 1;
        this.toast("Restored");
      })
      .catch((e) => this.fail(e));
  }

  /** Revert one of your hunks; the file as it was is kept for an Undo. */
  async revertMine(hunkId: string) {
    const sid = this.space.id;
    const h = this.sd.hunks.find((x) => x.id === hunkId);
    if (!h) return;
    let before: string | null = null;
    try {
      before = (await this.backend.readFile(sid, h.repo, h.path)).content;
    } catch {
      /* no undo then */
    }
    try {
      await this.backend.discardHunk(sid, hunkId);
    } catch (e) {
      this.fail(e);
      return;
    }
    await this.refresh(sid);
    this.contentRev[sid] = (this.contentRev[sid] ?? 0) + 1;
    const n = h.newLines || h.oldLines;
    const content = before;
    this.toast(
      `Reverted ${n} line${n === 1 ? "" : "s"} in ${h.path}`,
      content === null ? undefined : { label: "Undo", run: () => this.undoRevert(sid, h.repo, h.path, content) },
    );
  }

  /** Revert every change of yours in a file (staged or not), with an Undo. */
  async revertFile(key: string) {
    const sid = this.space.id;
    const i = key.indexOf("/");
    const repo = key.slice(0, i);
    const path = key.slice(i + 1);
    let before: string | null = null;
    try {
      before = (await this.backend.readFile(sid, repo, path)).content;
      for (const h of this.myHunksOf(key).filter((x) => x.state === "staged")) await this.backend.unstageHunk(sid, h.id);
      await this.backend.discardFile(sid, repo, path);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh(sid);
    this.contentRev[sid] = (this.contentRev[sid] ?? 0) + 1;
    const content = before;
    this.toast(`Reverted ${path}`, content === null ? undefined : { label: "Undo", run: () => this.undoRevert(sid, repo, path, content) });
  }

  async refresh(id = this.space.id) {
    await this.syncSpaces();
    await this.load(id);
    this.contentRev[id] = (this.contentRev[id] ?? 0) + 1;
  }

  fail(e: unknown) {
    this.toast(e instanceof Error ? e.message : String(e));
  }

  /** Hunks you can move across with J and K in the current view. */
  private get visible(): Proposal[] {
    if (this.view !== "code") return this.proposals;
    return this.pending.filter((p) => fileKey(p.hunk.repo, p.hunk.path) === this.cui.file);
  }

  private nextPendingId(from: string): string {
    const all = this.proposals;
    const start = all.findIndex((p) => p.hunk.id === from);
    for (let j = 1; j <= all.length; j++) {
      const p = all[(start + j) % all.length];
      if (p.hunk.state === "pending") return p.hunk.id;
    }
    return from;
  }

  // -- actions --------------------------------------------------------------

  setView(v: View) {
    if (this.cui.view === "space" && v !== "space") this.editPage(false);
    this.cui.view = v;
    this.overlay = null;
    if (v === "prs") void this.loadPrs();
    if (v === "space") void this.loadPage();
  }

  // -- back and forward -------------------------------------------------------

  /** Where you were, per space (not reactive: only the keys and buttons read it). */
  private navHist: Record<string, NavHist> = {};

  /** The place now: the view, and the file or the agent that view shows. */
  get place(): Place {
    return placeOf(this.view, this.cui.file, this.selectedAgent?.id ?? "", "");
  }

  /** The shell calls this after each change of place; a place equal to the current one is not new. */
  noteLocation(sid: string, p: Place) {
    this.navHist[sid] = record(this.navHist[sid] ?? emptyHist(), p);
  }

  /** The strip of places shown while you move through them: recent first, `at` is the current one. */
  navStrip = $state<{ places: Place[]; at: number } | null>(null);
  private navTimer: ReturnType<typeof setTimeout> | undefined;
  private showNav(h: NavHist) {
    this.navStrip = { places: [...h.stack].reverse(), at: h.stack.length - 1 - h.at };
    clearTimeout(this.navTimer);
    this.navTimer = setTimeout(() => this.hideNav(), 2500);
  }
  hideNav() {
    clearTimeout(this.navTimer);
    this.navStrip = null;
  }

  /** Back (-1) or forward (+1), like a browser: Ctrl Shift arrows, mouse buttons. */
  navigate(delta: 1 | -1) {
    const sid = this.space.id;
    const r = navStep(this.navHist[sid] ?? emptyHist(), delta);
    if (!r) return this.toast(delta < 0 ? "Nothing to go back to" : "Nothing to go forward to");
    this.navHist[sid] = r.hist;
    this.showNav(r.hist);
    const p = r.place;
    this.closeOverlay();
    if (p.agent && this.sd.agents.some((a) => a.id === p.agent)) this.selectAgent(p.agent);
    this.setView(p.view as View);
    if (p.file) this.openFile(this.active, p.file, true);
  }

  // -- file named in an answer -------------------------------------------------

  /** The file whose changes the mini page shows (overlay "filepeek"). */
  peek = $state<{ repo: string; path: string } | null>(null);

  openPeek(repo: string, path: string) {
    this.peek = { repo, path };
    this.overlay = "filepeek";
  }

  goSpace(i: number) {
    if (i < 0 || i >= this.spaces.length) return;
    this.active = i;
    this.overlay = null;
    this.stackOpen = false;
  }

  /** Show a file in the code view. A click in the tree opens a preview tab, `pin` keeps the tab. */
  openFile(spaceIdx: number, file: string, pin = true) {
    this.active = spaceIdx;
    const id = this.spaces[spaceIdx].id;
    const u = this.ui[id];
    u.view = "code";
    u.file = file;
    u.tabs = openTab(u.tabs, file, pin);
    u.recent = pushRecent(u.recent, file);
    saveRecent(id, u.recent);
    this.overlay = null;
  }

  /** Open a file and put the cursor on an (absolute) line. */
  gotoLine(file: string, line: number) {
    this.openFile(this.active, file, true);
    this.focusRequest = { file, line, seq: ++this.focusSeq };
  }

  /** Split view: show a file beside the open one (the open file again when none is given); a second call closes it. */
  toggleSplit(key?: string) {
    const u = this.cui;
    if (u.split && !key) return this.closeSplit();
    const f = key ?? u.file;
    if (!f) return this.toast("Open a file first");
    u.split = f;
    this.activePane = "split";
  }

  closeSplit() {
    this.cui.split = null;
    this.activePane = "main";
  }

  closeTab(key: string) {
    const u = this.cui;
    const r = closeTab(u.tabs, key, u.file);
    u.tabs = r.tabs;
    u.file = r.current;
  }

  move(delta: 1 | -1) {
    const v = this.visible;
    if (!v.length) {
      if (this.view === "code") {
        const p = this.pending[0];
        if (p) {
          this.cui.file = fileKey(p.hunk.repo, p.hunk.path);
          this.cui.hi = p.hunk.id;
        }
      }
      return;
    }
    const cur = v.findIndex((p) => p.hunk.id === this.focused?.hunk.id);
    const k = cur < 0 ? 0 : Math.min(v.length - 1, Math.max(0, cur + delta));
    this.cui.hi = v[k].hunk.id;
  }

  async decide(kind: "accept" | "reject" | "edit") {
    const f = this.focused;
    if (!f || f.hunk.state !== "pending") return;
    const sid = this.space.id;
    const b = this.backend;
    try {
      if (kind === "accept") await b.stageHunk(sid, f.hunk.id);
      else if (kind === "reject") await b.rejectHunk(sid, f.hunk.id);
      else {
        const h = await b.editHunk(sid, f.hunk.id);
        this.edited[`${sid}:${h.id}`] = true;
        await this.refresh(sid);
        const u = this.ui[sid];
        u.view = "code";
        u.file = fileKey(h.repo, h.path);
        this.focusRequest = { file: u.file, line: h.newStart, seq: ++this.focusSeq };
        this.toast("Accepted. Edit the lines, then Esc");
        return;
      }
    } catch (e) {
      this.fail(e);
      return;
    }
    await this.refresh(sid);
    const u = this.ui[sid];
    u.hi = this.nextPendingId(f.hunk.id);
    if (this.view === "review") this.rvLocate(u.hi);
    if (!this.pending.length) this.toast(this.readyToCommit ? "All reviewed. Press C to commit" : "All reviewed");
  }

  async undo() {
    const f = this.focused;
    if (!f || f.hunk.state === "pending") return;
    const sid = this.space.id;
    delete this.edited[`${sid}:${f.hunk.id}`];
    try {
      await this.backend.unstageHunk(sid, f.hunk.id);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh(sid);
    if (this.view === "review") this.rvLocate(f.hunk.id);
  }

  /** Notes of a file, by line. */
  notesOf(repo: string, path: string): ReviewNote[] {
    return this.sd.notes.filter((n) => n.repo === repo && n.path === path).sort((a, b) => a.line - b.line);
  }
  /** The open note under the cursor: of the hunk in the Review view, else of the focused proposal. */
  private currentNote(): ReviewNote | null {
    if (this.view === "review") {
      const h = this.currentHunk;
      const open = this.sd.notes.filter((n) => !n.resolved);
      if (h) {
        const n = open.find((x) => x.hunkId === h.id);
        if (n) return n;
      }
      const hi = this.cui.hi;
      const byFocus = hi ? open.find((x) => x.hunkId === hi) : undefined;
      if (byFocus) return byFocus;
      const r = this.selectedRow;
      if (r) return open.find((x) => x.repo === r.repo && x.path === r.path && !x.hunkId) ?? null;
      return null;
    }
    const p = this.focused;
    return p?.note && !p.note.resolved ? p.note : null;
  }

  /** F: send a note to its author (or a developer agent) for a fix. */
  async askFix(noteId?: string) {
    const n = noteId ? this.sd.notes.find((x) => x.id === noteId) : this.currentNote();
    if (!n) return this.toast("No open note here");
    if (n.resolved || n.busy) return;
    try {
      await this.backend.askFix(this.space.id, n.id);
      this.toast("Sent for a fix");
    } catch (e) {
      this.fail(e);
    }
    await this.refresh();
  }

  // -- review comments ------------------------------------------------------

  /** Where the comment being written goes; null when none is open. */
  commentDraft: { repo: string; path: string; line: number; hunkId: string } | null = $state(null);
  /** Who answers new comments: the reviewer explains, the developer may change the code. */
  commentRole: "reviewer" | "developer" = $state(readCommentRole());

  /** Comment threads of a file, by line. */
  commentsOf(repo: string, path: string): ReviewComment[] {
    return (this.sd.comments ?? []).filter((c) => c.repo === repo && c.path === path).sort((a, b) => a.line - b.line);
  }
  /** Open the comment box on a line of a hunk (its first changed line when none is given). */
  openComment(h: Hunk, line?: number) {
    const first = h.lines.find((l) => l.kind !== "context");
    const n = line ?? first?.new ?? first?.old ?? h.newStart;
    this.commentDraft = { repo: h.repo, path: h.path, line: n, hunkId: h.id };
  }
  /** M: comment the line under the cursor of the diff. */
  rvComment() {
    const r = this.selectedRow;
    if (!r) return this.toast("Pick a file to comment");
    this.openCommentAt(r.repo, r.path, this.pane?.line() ?? 1);
  }
  /** Open the comment box on a line of a file (the change around it answers for it). */
  openCommentAt(repo: string, path: string, line: number) {
    const hs = fileHunks(this.sd.hunks, repo, path);
    const h = hs.find((x) => line >= x.newStart && line < x.newStart + Math.max(1, x.newLines)) ?? hs.find((x) => x.state === "pending") ?? hs[0];
    this.commentDraft = { repo, path, line, hunkId: h?.id ?? "" };
  }
  setCommentRole(r: "reviewer" | "developer") {
    this.commentRole = r;
    try {
      localStorage.setItem("vela.commentRole", r);
    } catch {
      /* storage off: the choice lasts until the window closes */
    }
  }
  async sendComment(text: string) {
    const d = this.commentDraft;
    const t = text.trim();
    if (!d || !t) return;
    const sid = this.space.id;
    const role = this.commentRole;
    this.commentDraft = null;
    try {
      await this.backend.addComment(sid, { ...d, text: t, role } satisfies NewComment);
      this.toast(role === "developer" ? "Sent to a developer" : "Sent to a reviewer");
    } catch (e) {
      this.fail(e);
    }
    await this.refresh(sid);
  }
  async replyComment(id: string, text: string) {
    const t = text.trim();
    if (!t) return;
    const sid = this.space.id;
    try {
      await this.backend.replyComment(sid, id, t);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh(sid);
  }
  async resolveComment(id: string, resolved: boolean) {
    const sid = this.space.id;
    try {
      await this.backend.resolveComment(sid, id, resolved);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh(sid);
  }
  async deleteComment(id: string) {
    const sid = this.space.id;
    try {
      await this.backend.deleteComment(sid, id);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh(sid);
  }

  /** Shift Y: resolve a note (or open it again). */
  async resolveNote(noteId?: string, resolved = true) {
    const n = noteId ? this.sd.notes.find((x) => x.id === noteId) : this.currentNote();
    if (!n) return this.toast("No open note here");
    try {
      await this.backend.resolveNote(this.space.id, n.id, resolved);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh();
  }

  // -- terminals ------------------------------------------------------------

  /** Terminals of the current space, both panels. */
  get spaceTerms(): TermTab[] {
    return this.terms.filter((t) => t.spaceId === this.space.id);
  }
  /** Terminals of the current space in one panel. */
  termsOf(dock: TermDock): TermTab[] {
    return this.spaceTerms.filter((t) => t.dock === dock);
  }
  /** The key of `termActive` for a panel of the current space. */
  termKey(dock: TermDock): string {
    return dock === "top" ? `${this.space.id}:top` : this.space.id;
  }
  activeTermOf(dock: TermDock): TermTab | null {
    const list = this.termsOf(dock);
    return list.find((t) => t.id === this.termActive[this.termKey(dock)]) ?? list[list.length - 1] ?? null;
  }
  get activeTerm(): TermTab | null {
    return this.activeTermOf("bottom");
  }
  isTermOpen(dock: TermDock): boolean {
    return dock === "top" ? this.termTopOpen : this.termOpen;
  }
  private setTermOpen(dock: TermDock, open: boolean) {
    if (dock === "top") this.termTopOpen = open;
    else this.termOpen = open;
    writeFlag(dock === "top" ? "vela.termTopOpen" : "vela.termOpen", open);
  }
  /** Show a terminal of a panel and give it the focus. */
  focusTerm(dock: TermDock, id?: number) {
    if (id !== undefined) this.termActive[this.termKey(dock)] = id;
    this.termFocusDock = dock;
    this.termFocusSeq++;
  }
  /** The view of a terminal takes its output: what came before is replayed first. */
  attachTerm(id: number, write: (data: string) => void): () => void {
    for (const d of this.termBuf.get(id) ?? []) write(d);
    this.termBuf.delete(id);
    this.termSinks.set(id, write);
    return () => {
      if (this.termSinks.get(id) === write) this.termSinks.delete(id);
    };
  }
  private onTermEvent(e: TermEvent) {
    if (e.type === "data") {
      const sink = this.termSinks.get(e.id);
      if (sink) sink(e.data);
      else {
        const b = this.termBuf.get(e.id) ?? [];
        b.push(e.data);
        this.termBuf.set(e.id, b);
      }
      return;
    }
    const t = this.terms.find((x) => x.id === e.id);
    if (t) t.exited = true;
    this.termSinks.get(e.id)?.(`\r\n[process exited${e.code === null ? "" : ` with ${e.code}`}]\r\n`);
  }
  toggleTerminal(dock: TermDock = "bottom") {
    const open = !this.isTermOpen(dock);
    this.setTermOpen(dock, open);
    if (open) {
      if (!this.termsOf(dock).length) void this.newTerminal(null, 100, 24, dock);
      else this.focusTerm(dock);
    } else if (this.isTermOpen(dock === "top" ? "bottom" : "top")) {
      // The other panel is still there: the keys go back to it.
      this.focusTerm(dock === "top" ? "bottom" : "top");
    }
  }
  /** Open one more shell in the current space (in `repo`, or the first repo), in a panel. */
  async newTerminal(repo: string | null = null, cols = 100, rows = 24, dock: TermDock = "bottom") {
    const sid = this.space.id;
    if (!this.isTermOpen(dock)) this.setTermOpen(dock, true);
    try {
      const id = await this.backend.termOpen(sid, repo, cols, rows);
      const n = this.terms.filter((t) => t.spaceId === sid).length + 1;
      const name = repo ?? this.spaces.find((x) => x.id === sid)?.repos[0]?.name ?? "shell";
      this.terms.push({ id, spaceId: sid, title: n > 1 ? `${name} ${n}` : name, exited: false, dock });
      this.focusTerm(dock, id);
    } catch (e) {
      this.fail(e);
    }
  }
  async closeTerminal(id: number) {
    const t = this.terms.find((x) => x.id === id);
    this.terms = this.terms.filter((x) => x.id !== id);
    this.termSinks.delete(id);
    this.termBuf.delete(id);
    if (t && !t.exited) await this.backend.termClose(id).catch(() => {});
    if (t && !this.terms.some((x) => x.spaceId === t.spaceId && x.dock === t.dock) && t.spaceId === this.space.id) {
      this.setTermOpen(t.dock, false);
    }
  }

  // -- agent tier settings --------------------------------------------------

  /** Open the agent settings at once; the data comes in behind (cached values first). */
  openSettings(tab: "tiers" | "prompts" | "branches" = "tiers") {
    this.settingsTab = tab;
    this.overlay = "settings";
    void this.loadSettings();
  }
  private async loadSettings() {
    const b = this.backend;
    try {
      const [tiers, prompts, velaModel, velaPrompt] = await Promise.all([b.agentTiers(), b.agentPrompts(), b.velaModel().catch(() => null), b.velaPrompt().catch(() => null)]);
      this.tierSettings = tiers;
      this.rolePrompts = prompts;
      this.velaPrompt = velaPrompt;
      this.velaModel = velaModel;
      this.settingsLoaded = true;
    } catch (e) {
      this.fail(e);
      return;
    }
    for (const h of this.tierSettings) {
      if (h.models.length || !h.available) continue;
      void b
        .agentModels(h.harness)
        .then((m) => (this.agentModelList = { ...this.agentModelList, [h.harness]: m }))
        .catch(() => {});
    }
  }
  /** Models to suggest for a harness: what the tiers call gave, else the lazily loaded list. */
  modelsOf(h: HarnessTiers): string[] {
    return h.models.length ? h.models : (this.agentModelList[h.harness] ?? []);
  }
  /** Save the Vela prompt (null or blank: back to the built in one). */
  async setVelaPromptText(text: string | null) {
    const def = this.velaPrompt?.default;
    const t = text?.trim() || null;
    const custom = t && t !== def?.trim() ? t : null;
    if (this.velaPrompt) this.velaPrompt = { ...this.velaPrompt, custom };
    try {
      await this.backend.setVelaPrompt(custom);
      this.toast(custom ? "Vela prompt saved" : "Vela prompt reset");
    } catch (e) {
      this.fail(e);
    }
  }
  /** Save the brief of a role (null or blank: back to the built in one). */
  async setPrompt(role: AgentRole, text: string | null) {
    const def = this.rolePrompts.find((p) => p.role === role)?.default;
    const t = text?.trim() || null;
    const custom = t && t !== def ? t : null;
    this.rolePrompts = this.rolePrompts.map((p) => (p.role === role ? { ...p, custom } : p));
    try {
      await this.backend.setAgentPrompt(role, custom);
      this.toast(custom ? `${roleLabel(role)} brief saved` : `${roleLabel(role)} brief reset`);
    } catch (e) {
      this.fail(e);
    }
  }

  // -- pull requests --------------------------------------------------------

  /** Commit graph and branch state per space (Git view). */
  history: Record<string, RepoHistory[]> = $state({});
  historyError: Record<string, string> = $state({});
  async loadHistory(sid = this.space.id) {
    try {
      this.history = { ...this.history, [sid]: await this.backend.gitHistory(sid) };
      delete this.historyError[sid];
    } catch (e) {
      this.historyError[sid] = e instanceof Error ? e.message : String(e);
    }
  }

  get prState() {
    return this.prs[this.space.id] ?? { list: [], at: 0, loading: false, error: null };
  }
  /** PRs that want something from you: changes requested or failing checks. */
  get prAttention(): number {
    return this.prState.list.filter(
      (r) => r.pr && r.pr.state === "OPEN" && (r.pr.reviewDecision === "CHANGES_REQUESTED" || r.pr.checks.some((c) => c.state === "fail")),
    ).length;
  }
  /** Fetch the PRs of the space; a fetch less than a minute old is kept unless `force`. */
  async loadPrs(force = false) {
    const id = this.space.id;
    const cur = this.prs[id];
    if (cur?.loading || (!force && cur && Date.now() - cur.at < 60_000)) return;
    this.prs = { ...this.prs, [id]: { list: cur?.list ?? [], at: cur?.at ?? 0, loading: true, error: null } };
    try {
      const list = await this.backend.pullRequests(id);
      this.prs = { ...this.prs, [id]: { list, at: Date.now(), loading: false, error: null } };
    } catch (e) {
      this.prs = { ...this.prs, [id]: { list: cur?.list ?? [], at: Date.now(), loading: false, error: String((e as Error)?.message ?? e) } };
    }
  }
  async createPr(repo: string, draft = false) {
    this.toast(`Pushing ${repo} and opening the pull request…`);
    try {
      const url = await this.backend.createPullRequest(this.space.id, repo, draft);
      if (url) await this.addLinkFromPaste(url).catch(() => {});
      this.toast("Pull request opened");
    } catch (e) {
      this.fail(e);
    }
    await this.loadPrs(true);
  }
  async commentPr(repo: string, body: string): Promise<boolean> {
    try {
      await this.backend.commentPullRequest(this.space.id, repo, body);
    } catch (e) {
      this.fail(e);
      return false;
    }
    await this.loadPrs(true);
    return true;
  }
  /** Send a review comment to an agent: the remembered harness, as a developer. */
  async fixPrComment(repo: string, text: string, where?: string) {
    const prompt = `A reviewer left this comment on the pull request${where ? ` at ${where}` : ""} (repo ${repo}):\n${text}\n\nAddress it. Change only what the comment asks for.`;
    try {
      const harness = this.effectiveHarnessFor("developer");
      await this.backend.askAgent(this.space.id, "developer", prompt, { harness });
      this.toast("Sent to a developer agent");
    } catch (e) {
      this.fail(e);
    }
    await this.refresh();
  }

  /** The Vela model: the small model that labels the conversations (null until loaded). */
  velaModel = $state<VelaModelSetting | null>(null);
  /** Change the Vela model; what is left out keeps its latest value. */
  async setVelaModel(patch: { enabled?: boolean; harness?: string | null; model?: string | null }) {
    const cur = this.velaModel;
    const enabled = patch.enabled ?? cur?.enabled ?? true;
    const harness = patch.harness !== undefined ? patch.harness?.trim() || null : (cur?.harness ?? null);
    const model = patch.model !== undefined ? patch.model?.trim() || null : (cur?.model ?? null);
    if (cur) this.velaModel = { ...cur, enabled, harness, model };
    try {
      this.velaModel = await this.backend.setVelaModel(enabled, harness, model);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Change the model and/or the effort of a tier; what is left out keeps its latest value. */
  async setTier(harness: string, tier: Tier, patch: { model?: string | null; effort?: string | null }) {
    const cur = this.tierSettings.find((h) => h.harness === harness)?.tiers.find((t) => t.tier === tier);
    const model = patch.model !== undefined ? patch.model?.trim() || null : (cur?.model ?? null);
    const effort = patch.effort !== undefined ? patch.effort || null : (cur?.effort ?? null);
    // Shown at once, so a second change made before the backend answers builds on this one.
    this.tierSettings = this.tierSettings.map((h) =>
      h.harness !== harness ? h : { ...h, tiers: h.tiers.map((t) => (t.tier === tier ? { ...t, model, effort } : t)) },
    );
    try {
      await this.backend.setAgentTier(harness, tier, model, effort);
      this.tierSettings = await this.backend.agentTiers();
      await this.loadRoleDefaults(this.space.id).catch(() => {});
    } catch (e) {
      this.fail(e);
    }
  }

  async answer(yes: boolean) {
    const q = this.sd.question;
    if (!q) return;
    this.toast(`Sent to ${toolLabel(q.tool)}`);
    try {
      await this.backend.answerAgent(this.space.id, yes);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh();
  }

  async toggleWindow() {
    const s = this.space;
    const toMain = (s.window ?? null) !== null;
    this.overlay = null;
    try {
      await this.backend.setWindow(s.id, toMain ? null : 2);
    } catch (e) {
      this.fail(e);
      return;
    }
    await this.refresh(s.id);
    const n = this.spaces.find((x) => x.id === s.id)?.window;
    this.toast(toMain ? `${s.name} is back in this window` : `${s.name} moved to window ${n ?? 2}`);
  }

  openComposer() {
    this.composerWide = this.view === "agents";
    this.overlay = "composer";
    // The list is cached by the backend; refresh it behind the open composer.
    void this.loadHarnesses();
    void this.loadRoleDefaults(this.space.id);
  }

  async loadHarnesses() {
    try {
      this.harnesses = await this.backend.harnesses();
    } catch {
      this.harnesses = [];
    }
  }

  async loadRoleDefaults(id: string) {
    try {
      this.roleDefaults = { ...this.roleDefaults, [id]: await this.backend.roleDefaults(id) };
    } catch {
      /* the composer falls back to the first installed harness */
    }
  }

  /** The harnesses that can be picked (installed ones only). */
  get installedHarnesses(): Harness[] {
    return this.harnesses.filter((h) => h.available);
  }

  /** The harness the next request uses: the pick, else the role's default, else the first installed. */
  get effectiveHarness(): string {
    return this.effectiveHarnessFor(this.role);
  }
  effectiveHarnessFor(role: AgentRole): string {
    const def = this.roleDefaults[this.space.id]?.find((d) => d.role === role)?.harness;
    const installed = this.installedHarnesses.map((h) => h.name);
    // A remembered harness that is no longer installed gives way to the default.
    if (this.harness && (!installed.length || installed.includes(this.harness))) return this.harness;
    return def && (!installed.length || installed.includes(def)) ? def : (installed[0] ?? def ?? "claude");
  }

  /** The tier the next request uses: the pick, else the role's default. */
  get effectiveTier(): Tier {
    return this.tier ?? this.roleDefaults[this.space.id]?.find((d) => d.role === this.role)?.tier ?? DEFAULT_TIERS[this.role];
  }

  cycleHarness(delta: 1 | -1) {
    const names = this.installedHarnesses.map((h) => h.name);
    if (!names.length) return;
    const i = Math.max(0, names.indexOf(this.effectiveHarness));
    this.harness = names[(i + (delta === 1 ? 1 : names.length - 1)) % names.length];
    writeStr("vela.harness", this.harness);
  }

  /** `delta` 1 raises the tier (towards high), -1 lowers it. */
  bumpTier(delta: 1 | -1) {
    const i = TIERS.indexOf(this.effectiveTier);
    this.tier = TIERS[Math.min(TIERS.length - 1, Math.max(0, i - delta))];
  }

  /** The agent whose conversation is open, per space. */
  agentSel = $state<Record<string, string>>({});
  /** The search of the Agents view: words found in the labels, request, summary, role, session. */
  agentQuery = $state("");
  /** Show the agents of the other branches too. */
  allBranches = $state(false);
  /** The agents of the branch the space is on (all of them with `allBranches`). */
  get branchAgents(): Agent[] {
    return this.allBranches ? this.sd.agents : this.sd.agents.filter((a) => this.onThisBranch(a));
  }
  /** The agents of the space the search keeps, at work first. */
  get agentList(): Agent[] {
    const list = this.branchAgents.filter((a) => matchesAgent(a, this.agentQuery));
    return [
      ...list.filter((x) => x.status === "working" || x.status === "waiting"),
      ...list.filter((x) => x.status !== "working" && x.status !== "waiting"),
    ];
  }
  private noticeListeners = new Set<(n: AgentNotice) => void>();
  /** Every agent event as it happens (the chat appends them live). */
  onAgentNotice(fn: (n: AgentNotice) => void): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }
  /** The agent shown in the chat: the picked one, else the first at work, else the newest. */
  get selectedAgent(): Agent | null {
    const list = this.branchAgents;
    const id = this.agentSel[this.space.id];
    return (
      list.find((a) => a.id === id) ??
      list.find((a) => a.status === "waiting") ??
      list.find((a) => a.status === "working") ??
      list[0] ??
      null
    );
  }
  selectAgent(id: string) {
    this.agentSel[this.space.id] = id;
  }

  private onAgentEvent(n: AgentNotice) {
    for (const l of this.noticeListeners) l(n);
    if (!this.data[n.spaceId]) return;
    clearTimeout(this.agentTimers[n.spaceId]);
    this.agentTimers[n.spaceId] = setTimeout(() => void this.loadAgents(n.spaceId, n), 120);
  }

  /** Reload the agents, their question and the reasons of the proposals. */
  async loadAgents(id: string, notice?: AgentNotice) {
    const b = this.backend;
    try {
      const [agents, question, reasons, comments] = await Promise.all([
        b.agents(id),
        b.question(id),
        b.reasons(id),
        b.comments(id).catch((): ReviewComment[] => this.data[id]?.comments ?? []),
      ]);
      if (!this.data[id]) return;
      this.data = { ...this.data, [id]: { ...this.data[id], agents, question, reasons, comments } };
      void this.flushQueued(id);
      if (notice?.event.type === "failed" && notice.event.error !== "cancelled") this.toast(`Agent failed: ${notice.event.error}`);
      if (notice?.event.type === "done") {
        const a = agents.find((x) => x.id === notice.agentId);
        if (a && a.status === "done") this.toast(`${roleLabel(a.role)} finished`);
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /** Answer the waiting agent in words. */
  async reply(text: string) {
    const q = this.sd.question;
    const t = text.trim();
    if (!q || !t) return;
    this.toast(`Sent to ${toolLabel(q.tool)}`);
    try {
      await this.backend.answerAgentText(this.space.id, q.agentId, t);
    } catch (e) {
      this.fail(e);
    }
    await this.loadAgents(this.space.id);
  }

  /** What you wrote to agents while they worked, sent as soon as each one stops (`space|agent`). */
  queued: Record<string, string[]> = $state({});
  /** Write to an agent at work: the message waits and leaves when its run ends. */
  queueFor(agentId: string, text: string) {
    const t = text.trim();
    if (!t) return;
    const k = `${this.space.id}|${agentId}`;
    this.queued[k] = [...(this.queued[k] ?? []), t];
  }
  unqueue(agentId: string, index: number) {
    const k = `${this.space.id}|${agentId}`;
    const list = (this.queued[k] ?? []).filter((_, i) => i !== index);
    if (list.length) this.queued[k] = list;
    else delete this.queued[k];
  }
  queuedFor(agentId: string): string[] {
    return this.queued[`${this.space.id}|${agentId}`] ?? [];
  }
  /** Send what waits for agents of a space that stopped working. */
  private async flushQueued(sid: string) {
    for (const [k, list] of Object.entries(this.queued)) {
      const [s, agentId] = k.split("|");
      if (s !== sid || !list.length) continue;
      const a = this.data[sid]?.agents.find((x) => x.id === agentId);
      if (!a || a.status === "working") continue;
      delete this.queued[k];
      try {
        await this.backend.answerAgentText(sid, agentId, list.join("\n\n"));
        this.toast(`Sent what you wrote to ${roleLabel(a.role)}`);
      } catch (e) {
        this.fail(e);
      }
    }
  }

  /** More work for a finished agent: a resumed run of its session, in its own worktree. */
  async followUp(agentId: string, text: string): Promise<boolean> {
    const t = text.trim();
    if (!t) return false;
    try {
      await this.backend.answerAgentText(this.space.id, agentId, t);
      this.toast("Sent");
    } catch (e) {
      this.fail(e);
      return false;
    }
    await this.loadAgents(this.space.id);
    return true;
  }

  /** Open the composer for the next agent, with the answer of this one in it: you read and edit it, then send. */
  handoff(a: Agent, step: NextStep, answer: string) {
    this.role = step.role;
    this.tier = null;
    this.composerText = handoffText(step, a.role, answer);
    this.openComposer();
    this.composerWide = true;
  }

  /** Open the composer with the request of an agent, to edit it and run it again. */
  rerun(a: Agent) {
    this.role = a.role;
    this.harness = a.tool;
    this.tier = a.tier ?? null;
    this.composerText = a.prompt ?? "";
    this.openComposer();
    this.composerWide = (a.prompt ?? "").length > 160 || this.view === "agents";
  }

  async cancelAgent(agentId: string) {
    try {
      await this.backend.cancelAgent(this.space.id, agentId);
    } catch (e) {
      this.fail(e);
    }
    await this.loadAgents(this.space.id);
  }

  async sendComposer() {
    const text = expandPasted(this.composerText).trim();
    if (!text) return false;
    const s = this.space;
    try {
      const harness = this.effectiveHarness;
      const a = await this.backend.askAgent(s.id, this.role, text, { harness, tier: this.tier });
      this.agentSel[s.id] = a.id;
      this.harness = harness;
      writeStr("vela.harness", harness);
      writeStr("vela.role", this.role);
      const wt = a.worktrees[0] ? `${a.worktrees[0][0]} · ${a.worktrees[0][1]}` : "read only";
      this.toast(`${roleLabel(this.role)} started in ${wt}`);
    } catch (e) {
      this.fail(e);
    }
    this.composerText = "";
    this.tier = null;
    this.overlay = null;
    await this.refresh(s.id);
    return true;
  }

  cycleRole(delta: 1 | -1) {
    const n = ROLES.length;
    this.role = ROLES[(ROLES.indexOf(this.role) + (delta === 1 ? 1 : n - 1)) % n];
  }

  async openCommit() {
    if (!this.staged.length) {
      this.toast("Nothing staged yet. Accept a proposal with Y");
      return;
    }
    const sid = this.space.id;
    const token = ++this.gateSeq;
    let plan;
    try {
      plan = await this.backend.commitPlan(sid);
    } catch (e) {
      this.fail(e);
      return;
    }
    if (!plan.groups.length) {
      this.toast("Nothing staged yet. Accept a proposal with Y");
      return;
    }
    if (token !== this.gateSeq) return;
    const hunks = Object.fromEntries(this.sd.hunks.filter((h) => h.state === "staged").map((h) => [h.id, h]));
    const byRepo: Record<string, CommitGroup[]> = {};
    for (const g of plan.groups) (byRepo[g.repo] ??= []).push(g);
    const repo = this.commitRepoFor(Object.keys(byRepo));
    const groups = byRepo[repo];
    delete byRepo[repo];
    this.gate = {
      checks: [],
      done: false,
      reason: "",
      composer: { ...plan, repo, groups, rest: byRepo, gi: 0, hi: 0, problems: {}, hunks },
    };
    this.overlay = "commit";
    void this.revalidate();
    void this.runChecks();
    try {
      await this.backend.runGate(sid, (i, c) => {
        if (token !== this.gateSeq || !this.gate || this.overlay !== "commit") return;
        const checks = this.gate.checks.slice();
        checks[i] = c;
        this.gate.checks = checks;
      });
      if (token === this.gateSeq && this.gate) this.gate.done = true;
    } catch (e) {
      this.fail(e);
    }
  }

  // -- commit composer ------------------------------------------------------

  /** The repo the composer opens on: the one of the file open in the code view, else the first
   *  repo of the space with staged changes. */
  private commitRepoFor(repos: string[]): string {
    const here = this.view === "code" && this.cui.file ? this.cui.file.split("/")[0] : undefined;
    if (here && repos.includes(here)) return here;
    return this.space.repos.map((r) => r.name).find((r) => repos.includes(r)) ?? repos[0];
  }

  /** The repos with staged changes, in the order of the space. */
  get ccRepos(): string[] {
    const c = this.cc;
    if (!c) return [];
    const has = new Set([c.repo, ...Object.keys(c.rest)]);
    return this.space.repos.map((r) => r.name).filter((r) => has.has(r));
  }

  /** Commit another repo: its proposed commits come in, the ones you edited wait on the side. */
  ccRepo(repo: string) {
    const c = this.cc;
    if (!c || repo === c.repo || !c.rest[repo]) return;
    const rest = { ...c.rest, [c.repo]: c.groups };
    c.groups = rest[repo];
    delete rest[repo];
    c.rest = rest;
    c.repo = repo;
    c.gi = 0;
    c.hi = 0;
    void this.revalidate();
  }
  ccRepoMove(delta: 1 | -1) {
    const list = this.ccRepos;
    const c = this.cc;
    if (!c || list.length < 2) return this.toast("Only this repo has staged changes");
    this.ccRepo(list[(list.indexOf(c.repo) + delta + list.length) % list.length]);
  }

  /** Validate the message of one commit (or all of them) against the repo rules. */
  async revalidate(groupId?: string) {
    const c = this.cc;
    if (!c) return;
    for (const g of c.groups) {
      if (groupId && g.id !== groupId) continue;
      const token = (this.valSeq[g.id] = (this.valSeq[g.id] ?? 0) + 1);
      try {
        const msg = composeMessage($state.snapshot(g), c.conventional);
        const p = await this.backend.validateMessage(msg, $state.snapshot(c.rules), c.conventional);
        if (this.valSeq[g.id] === token && this.cc === c) c.problems[g.id] = p;
      } catch (e) {
        this.fail(e);
      }
    }
    for (const id of Object.keys(c.problems)) if (!c.groups.some((g) => g.id === id)) delete c.problems[id];
  }

  /** Put the focus back in range after the list of commits changed. */
  private clampFocus(c: ComposerState) {
    c.gi = Math.max(0, Math.min(c.gi, c.groups.length - 1));
    c.hi = Math.max(0, Math.min(c.hi, (c.groups[c.gi]?.hunks.length ?? 1) - 1));
  }

  ccFocus(gi: number) {
    const c = this.cc;
    if (!c || gi === c.gi || gi < 0 || gi >= c.groups.length) return;
    c.gi = gi;
    c.hi = 0;
  }
  ccGroup(delta: 1 | -1) {
    const c = this.cc;
    if (c) this.ccFocus(Math.max(0, Math.min(c.groups.length - 1, c.gi + delta)));
  }
  ccHunk(delta: 1 | -1) {
    const c = this.cc;
    if (!c) return;
    c.hi = Math.max(0, Math.min((c.groups[c.gi]?.hunks.length ?? 1) - 1, c.hi + delta));
  }
  ccType() {
    const c = this.cc;
    const g = c?.groups[c.gi];
    if (!c || !g) return;
    g.kind = cycleType(g.kind, c.rules);
    void this.revalidate(g.id);
  }
  ccBreaking() {
    const c = this.cc;
    const g = c?.groups[c.gi];
    if (!g) return;
    g.breaking = !g.breaking;
    void this.revalidate(g.id);
  }
  ccConventional() {
    const c = this.cc;
    if (!c) return;
    c.conventional = !c.conventional;
    this.toast(c.conventional ? "Conventional commits on" : "Conventional commits off");
    void this.revalidate();
  }
  /** Move the selected hunk to commit number `n` (1 based). */
  ccMove(n: number) {
    const c = this.cc;
    const g = c?.groups[c.gi];
    const id = g?.hunks[c?.hi ?? 0];
    if (!c || !g || !id) return;
    const target = c.groups[n - 1];
    if (!target) return this.toast(`There is no commit ${n}`);
    if (target.id === g.id) return;
    if (target.repo !== g.repo) return this.toast(`Commit ${n} is in ${target.repo}, this hunk is in ${g.repo}`);
    const next = moveHunk($state.snapshot(c.groups), id, n - 1);
    c.groups = next;
    const at = next.findIndex((x) => x.id === g.id);
    c.gi = at >= 0 ? at : Math.min(c.gi, next.length - 1);
    this.clampFocus(c);
    void this.revalidate();
  }
  /** The selected hunk becomes a commit of its own. */
  ccSplit() {
    const c = this.cc;
    const g = c?.groups[c.gi];
    const id = g?.hunks[c?.hi ?? 0];
    if (!c || !g || !id) return;
    if (g.hunks.length < 2) return this.toast("This commit has only one hunk");
    const r = splitHunk($state.snapshot(c.groups), id, c.hunks[id]);
    c.groups = r.groups;
    c.gi = r.index;
    c.hi = 0;
    void this.revalidate();
  }
  ccMerge() {
    const c = this.cc;
    if (!c) return;
    const next = mergeAll($state.snapshot(c.groups));
    if (next.length === c.groups.length) return this.toast("Already one commit");
    c.groups = next;
    c.gi = 0;
    c.hi = 0;
    void this.revalidate();
    this.toast(next.length === 1 ? "Merged into one commit" : `Merged into ${plural(next.length, "commit", "commits")}`);
  }
  ccEdit() {
    const c = this.cc;
    const g = c?.groups[c.gi];
    if (g) document.querySelector<HTMLElement>(`[data-group="${g.id}"] [data-field="subject"]`)?.focus();
  }

  // -- links ----------------------------------------------------------------

  // -- the space page ----------------------------------------------------------

  /** The page of the current space, loaded once. */
  async loadPage(id = this.space.id) {
    if (this.pages[id]?.loaded) return;
    try {
      const text = await this.backend.spacePage(id);
      // Typed while it loaded: keep what was typed.
      if (!this.pages[id]?.loaded) this.pages[id] = { text, loaded: true };
    } catch (e) {
      this.fail(e);
    }
  }

  /** Every change you type: saved half a second after the last one. */
  setPage(text: string, id = this.space.id) {
    this.pages[id] = { text, loaded: true };
    clearTimeout(this.pageTimers[id]);
    this.pageTimers[id] = setTimeout(() => void this.savePage(id), 500);
  }

  async savePage(id = this.space.id) {
    clearTimeout(this.pageTimers[id]);
    delete this.pageTimers[id];
    const p = this.pages[id];
    if (!p?.loaded) return;
    try {
      await this.backend.saveSpacePage(id, p.text);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Add a line at the end of the page (a pasted URL becomes a list item). */
  async appendToPage(line: string, id = this.space.id) {
    await this.loadPage(id);
    const t = (this.pages[id]?.text ?? "").replace(/\s*$/, "");
    // Right under a list, it joins the list; after anything else, a blank line first.
    const last = t.slice(t.lastIndexOf("\n") + 1);
    const sep = !t ? "" : /^\s*([-*+]|\d+\.)\s/.test(last) ? "\n" : "\n\n";
    this.setPage(`${t}${sep}${line}\n`, id);
    await this.savePage(id);
  }

  editPage(on = true) {
    this.pageEditing = on;
    if (!on) void this.savePage();
  }

  /** Open a link in the browser; a key without a tracker URL says how to get one. */
  async openLink(id: string) {
    const l = this.links.find((x) => x.id === id);
    if (!l) return;
    if (!l.url) {
      this.toast(`${l.key ?? l.title} has no URL yet. Set [issues] in ~/.config/vela/config.toml`);
      return;
    }
    try {
      await this.backend.openUrl(l.url);
    } catch (e) {
      this.fail(e);
    }
  }

  /** A URL pasted outside any field goes on the page of the current space. */
  async addLinkFromPaste(text: string): Promise<boolean> {
    const t = text.trim();
    if (!this.ready || !this.spaces.length || !isHttpUrl(t) || /\s/.test(t)) return false;
    const l = makeLink(t, undefined, "paste");
    await this.appendToPage(l.title && l.title !== t ? `- [${l.title}](${t})` : `- <${t}>`);
    this.toast(`Added to the page of ${this.space.name} (0)`, { label: "Show", run: () => this.setView("space") });
    return true;
  }

  closeOverlay() {
    this.overlay = null;
    this.peek = null;
    this.sheet = null;
    this.gate = null;
    this.stackOpen = false;
    this.gateSeq++;
  }

  async doCommit() {
    const g = this.gate;
    const c = g?.composer;
    if (!g || !c || !this.gateOk) return;
    if (!this.composerOk) {
      this.toast("Fix the highlighted messages first");
      return;
    }
    const s = this.space;
    const failing = !this.gateRows.every((x) => x.pass);
    try {
      const r = await this.backend.commitGroups(
        s.id,
        $state.snapshot(c.groups),
        c.conventional,
        failing ? g.reason.trim() : undefined,
      );
      this.overlay = null;
      this.gate = null;
      this.gateSeq++;
      this.cui.hi = null;
      const n = r.commits?.length ?? r.repos.length;
      const left = Object.keys(c.rest);
      this.toast(
        `${r.pushed === false ? "Committed" : "Pushed"} ${plural(n, "commit", "commits")} in ${c.repo} on ${r.branch}` +
          (left.length ? `. ${left.join(", ")} ${left.length > 1 ? "have" : "has"} staged changes too: C to commit` : ""),
      );
      await this.refresh(s.id);
    } catch (e) {
      this.fail(e);
    }
  }

  /** The "new repo" form inside the new space sheet. */
  newRepo = $state({ open: false, name: "", parent: "" });

  async openNewRepo() {
    if (this.overlay !== "newspace") this.sheetMode = "new";
    this.overlay = "newspace";
    this.newRepo.open = true;
    if (!this.newRepo.parent) {
      try {
        this.newRepo.parent = await this.backend.defaultRepoParent();
      } catch {
        this.newRepo.parent = "~/Work";
      }
    }
  }

  /** Create the repo, add it to the list and select it for the new space. */
  async createRepo() {
    const name = this.newRepo.name.trim();
    if (!name) {
      this.toast("Give the repo a name");
      return;
    }
    try {
      const path = await this.backend.createRepo(this.newRepo.parent, name);
      this.repos = await this.backend.listRepos();
      if (!this.newSp.repos.includes(path)) this.newSp.repos.push(path);
      if (!this.newSp.name.trim()) this.newSp.name = name;
      this.newRepo = { open: false, name: "", parent: this.newRepo.parent };
      this.toast(`Created ${path}`);
    } catch (e) {
      this.fail(e);
    }
  }

  async createSpace() {
    if (!this.newSp.name.trim() && this.newSp.repos.length === 1) {
      // One repo and no name: name the space after the repo.
      this.newSp.name = this.newSp.repos[0].split("/").pop() ?? "";
    }
    const name = this.newSp.name.trim();
    if (!name) {
      this.newSp.missingName = true;
      return;
    }
    if (!this.newSp.repos.length) {
      this.toast("Pick at least one repo");
      return;
    }
    try {
      const branch = this.newSp.branch.trim().replace(/^origin\//, "");
      const repos = [...this.newSp.repos];
      const own = repos.map((r) => this.newSp.repoBranches[r]?.trim().replace(/^origin\//, "") || null);
      const s = await this.backend.createSpace(name, repos, {
        branch: branch || null,
        base: this.newSp.base.trim() || null,
        repoBranches: own.some(Boolean) ? own : undefined,
        ticket: this.newSp.ticket.trim() || null,
      });
      await this.syncSpaces();
      await this.load(s.id);
      this.ui[s.id].view = this.data[s.id].agents.length ? "agents" : "code";
      this.active = Math.max(0, this.spaces.findIndex((x) => x.id === s.id));
      this.overlay = null;
      this.newSp = { name: "", repos: this.defaultRepos(), missingName: false, branch: "", base: "", repoBranches: {}, ticket: "" };
      this.toast(`${s.name}: ${plural(s.repos.length, "repo", "repos")} on ${spaceBranches(s).join(", ")}`);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Filter text of the repo picker; a path (starting with / or ~) can be declared. */
  repoFilter = $state("");

  /** Repos matching the filter, selected ones first. */
  get shownRepos(): string[] {
    const q = this.repoFilter.trim().toLowerCase();
    const looksPath = q.startsWith("/") || q.startsWith("~");
    const hit = (r: string) => !q || looksPath || r.toLowerCase().includes(q);
    const sel = this.newSp.repos;
    return [...sel.filter(hit), ...this.repos.filter((r) => !sel.includes(r) && hit(r))];
  }

  /** Enter in the repo filter: declare a path, or toggle the first match. */
  async repoFilterEnter() {
    const q = this.repoFilter.trim();
    if (!q) return;
    if (q.startsWith("/") || q.startsWith("~")) {
      try {
        this.repos = await this.backend.declareRepo(q);
        // A folder of repos declares each of them: pick them all.
        const tail = q.replace(/^~/, "").replace(/\/+$/, "");
        let added = this.repos.filter((r) => r.endsWith(tail) || r.includes(`${tail}/`));
        if (!added.length && this.repos[0]) added = [this.repos[0]];
        for (const r of added) if (!this.newSp.repos.includes(r)) this.newSp.repos.push(r);
        this.repoFilter = "";
        this.toast(`Added ${added.map((r) => r.split("/").pop()).join(", ") || q}`);
      } catch (e) {
        this.toast(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    const first = this.shownRepos.find((r) => !this.newSp.repos.includes(r));
    if (first) this.toggleRepo(first);
    this.repoFilter = "";
  }

  toggleRepo(r: string) {
    const a = this.newSp.repos;
    const k = a.indexOf(r);
    if (k < 0) a.push(r);
    else a.splice(k, 1);
  }

  /** Called by the editor for every change you type. */
  async writeFile(repo: string, path: string, content: string) {
    try {
      await this.backend.writeFile(this.space.id, repo, path, content);
    } catch (e) {
      this.fail(e);
    }
  }

  runPalette(item: PaletteItem | undefined) {
    if (!item) return;
    this.overlay = null;
    this.pal = { q: "", i: 0 };
    if (item.run) item.run();
    else if (item.action) void this.dispatch(item.action);
  }

  upNextGo() {
    switch (this.upNext.action) {
      case "bring-here":
        return void this.toggleWindow();
      case "answer":
        return this.setView("agents");
      case "review": {
        this.setView("review");
        const p = this.pending[0];
        if (p) {
          this.cui.hi = p.hunk.id;
          this.rvLocate(p.hunk.id);
        }
        return;
      }
      case "commit":
        return void this.openCommit();
      case "next-space": {
        const n = this.nextWaitingSpace;
        if (n !== null) this.goSpace(n);
        return;
      }
      case "ask":
        return this.openComposer();
    }
  }

  async dispatch(a: Action): Promise<void> {
    switch (a.type) {
      case "palette-toggle":
        this.overlay = this.overlay === "palette" ? null : "palette";
        this.pal = { q: "", i: 0 };
        return;
      case "open-palette":
        this.overlay = "palette";
        this.pal = { q: "", i: 0 };
        return;
      case "palette-move": {
        const n = this.paletteItems.length;
        this.pal.i = Math.max(0, Math.min(n - 1, this.pal.i + a.delta));
        return;
      }
      case "palette-run":
        return this.runPalette(this.paletteItems[this.pal.i]);
      case "close":
        return this.closeOverlay();
      case "nav":
        return this.navigate(a.delta);
      case "open-peek":
        return this.openPeek(a.repo, a.path);
      case "blur":
        return void (document.activeElement as HTMLElement | null)?.blur();
      case "newspace-submit":
        return this.sheetMode === "add" ? this.addRepos() : this.createSpace();
      case "commit-submit":
        return this.doCommit();
      case "composer-role":
        return this.cycleRole(a.delta);
      case "composer-harness":
        return this.cycleHarness(a.delta);
      case "composer-tier":
        return this.bumpTier(a.delta);
      case "composer-send":
        return void (await this.sendComposer());
      case "up-next":
        return this.upNextGo();
      case "next-waiting": {
        const n = this.nextWaitingSpace;
        if (n !== null) this.goSpace(n);
        else this.toast("No other space is waiting for you");
        return;
      }
      case "view":
        return this.setView(a.view);
      case "view-step":
        return this.setView(VIEWS[(VIEWS.indexOf(this.view) + a.delta + VIEWS.length) % VIEWS.length]);
      case "space-prev":
        return this.goSpace((this.active - 1 + this.spaces.length) % this.spaces.length);
      case "space-next":
        return this.goSpace((this.active + 1) % this.spaces.length);
      case "space-jump":
        return this.goSpace(a.index);
      case "move":
        return this.move(a.delta);
      case "accept":
        return this.decide("accept");
      case "reject":
        return this.view === "review" ? this.rvHunkReject() : this.decide("reject");
      case "edit":
        return this.decide("edit");
      case "undo":
        return this.undo();
      case "fix":
        return this.askFix();
      case "answer":
        return this.answer(a.yes);
      case "find":
        this.findSeq++;
        return;
      case "split":
        this.toggleSplit();
        return;
      case "agent-move": {
        const list = this.agentList;
        if (!list.length) return;
        const i = list.findIndex((x) => x.id === this.selectedAgent?.id);
        this.selectAgent(list[Math.max(0, Math.min(list.length - 1, i + a.delta))].id);
        return;
      }
      case "change-move":
        this.changeMove = { seq: this.changeMove.seq + 1, delta: a.delta };
        return;
      case "noop":
        return;
      case "close-tab":
        if (this.cui.file) this.closeTab(this.cui.file);
        return;
      case "toggle-rail":
        this.railHidden = !this.railHidden;
        this.railPeek = false;
        writeFlag("vela.railHidden", this.railHidden);
        return;
      case "toggle-terminal":
        return this.toggleTerminal(a.dock ?? "bottom");
      case "new-terminal":
        return this.newTerminal();
      case "toggle-preview": {
        const f = this.cui.file;
        if (!f || !isMarkdown(f)) return this.toast("Preview is for Markdown files");
        const k = `${this.space.id}:${f}`;
        if (this.mdSource[k]) delete this.mdSource[k];
        else this.mdSource[k] = true;
        return;
      }
      case "open-settings":
        return this.openSettings("tiers");
      case "open-prompts":
        return this.openSettings("prompts");
      case "open-branch-settings":
        void this.loadBranchChoices(null);
        return this.openSettings("branches");
      case "prs-refresh":
        return this.loadPrs(true);
      case "rv-split":
        this.rvSplit = !this.rvSplit;
        writeFlag("vela.rvSplit", this.rvSplit);
        return;
      case "rv-note-resolve":
        return this.resolveNote();
      case "toggle-files":
        this.filesOpen = !this.filesOpen;
        writeFlag("vela.filesOpen", this.filesOpen);
        return;
      case "toggle-stack":
        this.stackOpen = !this.stackOpen;
        return;
      case "open-stack":
        this.stackOpen = true;
        return;
      case "open-commit":
        return this.openCommit();
      case "open-link":
        return this.openLink(a.id);
      case "page-edit":
        return this.editPage(!this.pageEditing);
      case "hide-terminals":
        for (const d of ["top", "bottom"] as const) if (this.isTermOpen(d)) this.setTermOpen(d, false);
        return;
      case "cc-type":
        return this.ccType();
      case "cc-breaking":
        return this.ccBreaking();
      case "cc-hunk":
        return this.ccHunk(a.delta);
      case "cc-group":
        return this.ccGroup(a.delta);
      case "cc-move":
        return this.ccMove(a.to);
      case "cc-split":
        return this.ccSplit();
      case "cc-merge":
        return this.ccMerge();
      case "cc-edit":
        return this.ccEdit();
      case "cc-conventional":
        return this.ccConventional();
      case "cc-repo":
        return this.ccRepoMove(a.delta);
      case "toggle-window":
        return this.toggleWindow();
      case "open-composer":
        return this.openComposer();
      case "open-newspace":
        this.sheetMode = "new";
        this.overlay = "newspace";
        return;
      case "open-addrepo":
        return this.openAddRepo();
      case "move-repo-into-clone":
        return this.moveRepoIntoClone(a.repo);
      case "remove-repo":
        return this.removeRepo(a.repo);
      case "open-newrepo":
        return this.openNewRepo();
      case "open-help":
        this.overlay = "help";
        return;
      case "open-file":
        return this.openFile(a.space, a.file);
      case "context-menu":
        return this.onContextMenuKey();
      case "quick-open":
        this.overlay = this.overlay === "quickopen" ? null : "quickopen";
        return;
      case "files-filter":
        if (!this.filesOpen) this.filesOpen = true;
        await tick();
        document.querySelector<HTMLElement>("[data-files-filter]")?.focus();
        return;
      case "rv-file":
        return this.rvFile(a.delta);
      case "rv-check":
        return this.rvCheckMove(a.delta);
      case "rv-toggle-file":
        return this.rvToggleFile();
      case "rv-stage-all":
        return this.rvStageAll();
      case "rv-unstage-all":
        return this.rvUnstageAll();
      case "rv-approve-all":
        return this.rvApproveAll();
      case "rv-comment":
        return this.rvComment();
      case "rv-focus-diff":
        this.rvFocusDiff();
        this.pane?.focus();
        return;
      case "rv-hunk":
        return this.rvChange(a.delta);
      case "rv-reject-file":
        return this.rvRejectSelected();
      case "rv-accept-file": {
        const r = this.selectedRow;
        if (!r) return;
        return r.section === "review" ? this.rvStageRow(r) : this.toast("Already accepted. U takes it back to review");
      }
      case "rv-unaccept-file": {
        const r = this.selectedRow;
        if (!r) return;
        return r.section === "done" ? this.rvStageRow(r) : this.toast("Not accepted yet");
      }
      case "rv-open-editor":
        return this.rvOpenInEditor();
      case "rv-hunk-stage":
        return this.rvHunkStage();
      case "rv-hunk-unstage":
        return this.rvHunkUnstage();
      case "rv-run-all":
        return this.runChecks();
      case "rv-run-focused":
        return this.rvRunFocused();
      case "rv-toggle-log":
        return this.rvToggleLog();
    }
  }

  /** Unique repos of the staged files. */
  get stagedRepos(): string[] {
    return uniq(this.staged.map((f) => f.repo));
  }
}

/** Key of a file of the Review in a space: drafts and loaded reviews. */
export const draftKey = (sid: string, rowId: string) => `${sid}|${rowId}`;

export const app = new AppState();

/** A terminal tab of the panel. */
/** Where a terminal panel sits: under the view, or above it. */
export type TermDock = "top" | "bottom";

export interface TermTab {
  id: number;
  spaceId: string;
  title: string;
  exited: boolean;
  dock: TermDock;
}

export function isMarkdown(key: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(key);
}

function readStr(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStr(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}
function readRole(): AgentRole {
  const r = readStr("vela.role");
  return r && (ROLES as string[]).includes(r) ? (r as AgentRole) : "developer";
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return v === null || v === undefined ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    globalThis.localStorage?.setItem(key, value ? "1" : "0");
  } catch {
    // storage unavailable: the flag just is not remembered
  }
}
