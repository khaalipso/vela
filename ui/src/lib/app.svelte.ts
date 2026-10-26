// The shell state: what the backend says about each space, plus what only the UI knows
// (current view, focused proposal, open overlay). Components read it, `dispatch` changes it.

import { tick } from "svelte";
import type {
  AgentQuestion,
  Backend,
  BackendEvent,
  FileRef,
  GateCheck,
  ReviewNote,
  Unsubscribe,
} from "./backend";
import { composeMessage, cycleType, mergeAll, moveHunk, splitHunk } from "./commitplan";
import { GATE_NAMES, fileKey, plural, roleLabel, ROLES, toolLabel, uniq } from "./format";
import type { Action, Overlay, View } from "./keymap";
import { groupLinks, isHttpUrl, makeLink, removable, topBarChips, type Chips } from "./links";
import { buildPaletteItems, filterPalette, type PaletteItem } from "./palette";
import { closeTab, loadRecent, openTab, pushRecent, saveRecent, type Tab } from "./tabs";
import type {
  Agent,
  AgentRole,
  CommitGroup,
  CommitRules,
  FileChange,
  Hunk,
  Link,
  Problem,
  Space,
  StackItem,
} from "./types";
import { computeUpNext, readyToCommit, waitingCount, type UpNextInput, type UpNextView } from "./upnext";

export interface SpaceData {
  hunks: Hunk[];
  reasons: Record<string, string>;
  agents: Agent[];
  stack: StackItem[];
  status: FileChange[];
  question: AgentQuestion | null;
  notes: ReviewNote[];
  files: FileRef[];
  links: Link[];
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
  groups: CommitGroup[];
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

const GATE_TOTAL = GATE_NAMES.length;

export class AppState {
  backend!: Backend;
  ready = $state(false);
  spaces = $state.raw<Space[]>([]);
  data = $state.raw<Record<string, SpaceData>>({});
  ui = $state<Record<string, SpaceUi>>({});
  repos = $state.raw<string[]>([]);
  active = $state(0);

  /** The file tree drawer is open. */
  filesOpen = $state(false);
  overlay = $state<Overlay>(null);
  stackOpen = $state(false);
  role = $state<AgentRole>("developer");
  composerText = $state("");
  pal = $state({ q: "", i: 0 });
  newSp = $state<{ name: string; repos: string[]; missingName: boolean }>({ name: "", repos: [], missingName: false });
  /** Id of the space this window is pinned to (`#space-<id>`), null in the main window. */
  pinned = $state<string | null>(null);
  gate = $state<GateState | null>(null);
  /** The links sheet: text in the URL field and the selected row. */
  linksUi = $state({ q: "", i: 0 });
  toastState = $state<{ id: number; text: string } | null>(null);
  /** Hunks accepted with E, to label them "edited by you". */
  edited = $state<Record<string, true>>({});
  /** Bumped when a file changed under the editor (accept, undo, fix), so the editor reloads it. */
  contentRev = $state<Record<string, number>>({});
  /** Ask the code view to put the cursor on a line (absolute number) of a file. */
  focusRequest = $state<{ file: string; line: number; seq: number } | null>(null);

  private off: Unsubscribe | null = null;
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
    this.repos = await backend.listRepos();
    this.newSp.repos = this.defaultRepos();
    this.spaces = this.forThisWindow(await backend.listSpaces());
    await Promise.all(this.spaces.map((s) => this.load(s.id)));
    this.ready = true;
  }

  destroy() {
    this.off?.();
  }

  /** A pinned window shows its one space only. */
  private forThisWindow(list: Space[]): Space[] {
    const pin = this.pinned;
    return pin ? list.filter((s) => s.id === pin) : list;
  }

  /** The repo preselected in the new space sheet: "api" when there is one, else none. */
  private defaultRepos(): string[] {
    return this.repos.includes("api") ? ["api"] : [];
  }

  /** Refresh the list of spaces, loading the data of new ones before they are shown. */
  private async syncSpaces() {
    const list = this.forThisWindow(await this.backend.listSpaces());
    await Promise.all(list.filter((s) => !this.data[s.id]).map((s) => this.load(s.id)));
    this.spaces = list;
  }

  private async onEvent(e: BackendEvent) {
    await this.syncSpaces();
    if (!this.data[e.spaceId]) return;
    await this.load(e.spaceId, e.kind === "file");
    if (e.kind !== "file") this.contentRev[e.spaceId] = (this.contentRev[e.spaceId] ?? 0) + 1;
    if (e.toast) this.toast(e.toast);
  }

  /** Reload everything the backend knows about a space. */
  async load(id: string, light = false) {
    const b = this.backend;
    const [hunks, reasons, agents, stack, status, question, notes, files, links] = await Promise.all([
      b.hunks(id),
      b.reasons(id),
      b.agents(id),
      b.stack(id),
      b.status(id),
      b.question(id),
      b.notes(id),
      b.listFiles(id),
      b.links(id).catch((): Link[] => []),
    ]);
    this.data = { ...this.data, [id]: { hunks, reasons, agents, stack, status, question, notes, files, links } };
    if (!light || !this.ui[id]) this.ensureUi(id);
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
          note: d.notes.find((n) => n.hunkId === hunk.id) ?? null,
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
    return filterPalette(items, this.pal.q);
  }

  get links(): Link[] {
    return this.sd.links;
  }
  /** Links in the order of the sheet (grouped by kind). */
  get orderedLinks(): Link[] {
    return groupLinks(this.sd.links);
  }
  get chips(): Chips {
    return topBarChips(groupLinks(this.sd.links));
  }
  /** What the URL field would add, for the live preview. */
  get linkPreview(): Link | null {
    const q = this.linksUi.q.trim();
    return q && isHttpUrl(q) && !/\s/.test(q) ? makeLink(q, undefined, "manual") : null;
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
    if (!g || !(g.done || g.checks.length >= GATE_TOTAL)) return false;
    return g.checks.every((c) => c.pass) || g.reason.trim().length > 3;
  }

  // -- helpers --------------------------------------------------------------

  toast(text: string) {
    const id = ++this.toastSeq;
    this.toastState = { id, text };
    setTimeout(() => {
      if (this.toastState?.id === id) this.toastState = null;
    }, 2400);
  }

  private async refresh(id = this.space.id) {
    await this.syncSpaces();
    await this.load(id);
    this.contentRev[id] = (this.contentRev[id] ?? 0) + 1;
  }

  private fail(e: unknown) {
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
    this.cui.view = v;
    this.overlay = null;
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
  }

  async askFix(hunkId?: string) {
    const p = hunkId ? this.proposals.find((x) => x.hunk.id === hunkId) : this.focused;
    if (!p?.note || p.note.resolved || p.note.busy) return;
    try {
      await this.backend.askFix(this.space.id, p.hunk.id);
    } catch (e) {
      this.fail(e);
    }
    await this.refresh();
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
    this.overlay = "composer";
  }

  async sendComposer() {
    const text = this.composerText.trim();
    if (!text) return false;
    const s = this.space;
    try {
      const a = await this.backend.askAgent(s.id, this.role, text);
      const wt = a.worktrees[0] ? `${a.worktrees[0][0]} · ${a.worktrees[0][1]}` : "read only";
      this.toast(`${roleLabel(this.role)} started in ${wt}`);
    } catch (e) {
      this.fail(e);
    }
    this.composerText = "";
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
    this.gate = {
      checks: [],
      done: false,
      reason: "",
      composer: { ...plan, gi: 0, hi: 0, problems: {}, hunks },
    };
    this.overlay = "commit";
    void this.revalidate();
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
    if (next.length === c.groups.length) return this.toast("Already one commit per repo");
    c.groups = next;
    c.gi = 0;
    c.hi = 0;
    void this.revalidate();
    this.toast(next.length === 1 ? "Merged into one commit" : `Merged into ${plural(next.length, "commit", "commits")}, one per repo`);
  }
  ccEdit() {
    const c = this.cc;
    const g = c?.groups[c.gi];
    if (g) document.querySelector<HTMLElement>(`[data-group="${g.id}"] [data-field="subject"]`)?.focus();
  }

  // -- links ----------------------------------------------------------------

  openLinks() {
    this.linksUi = { q: "", i: 0 };
    this.overlay = "links";
  }

  private async reloadLinks(id: string) {
    const links = await this.backend.links(id);
    const d = this.data[id];
    if (d) this.data = { ...this.data, [id]: { ...d, links } };
    return links;
  }

  linksMove(delta: 1 | -1) {
    const n = this.orderedLinks.length;
    if (n) this.linksUi.i = Math.max(0, Math.min(n - 1, this.linksUi.i + delta));
  }

  /** Open a link in the browser; a key without a tracker URL says how to get one. */
  async openLink(id?: string) {
    const l = id ? this.links.find((x) => x.id === id) : this.orderedLinks[this.linksUi.i];
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

  /** Enter in the URL field: add the URL, or open the selected link when the field is empty. */
  async linksSubmit() {
    const q = this.linksUi.q.trim();
    if (!q) return this.openLink();
    if (!this.linkPreview) return this.toast("Paste a full http or https URL");
    const sid = this.space.id;
    try {
      const l = await this.backend.addLink(sid, q, undefined, "manual");
      await this.reloadLinks(sid);
      this.linksUi.q = "";
      this.linksUi.i = Math.max(0, this.orderedLinks.findIndex((x) => x.id === l.id));
      this.toast(`Linked ${l.title}`);
    } catch (e) {
      this.fail(e);
    }
  }

  async removeLink() {
    const l = this.orderedLinks[this.linksUi.i];
    if (!l) return;
    if (!removable(l)) {
      this.toast(l.source === "repo" ? "Repo links live in .vela/links.toml" : "Found in the history, it cannot be removed here");
      return;
    }
    const sid = this.space.id;
    try {
      await this.backend.removeLink(sid, l.id);
      await this.reloadLinks(sid);
      this.linksUi.i = Math.max(0, Math.min(this.linksUi.i, this.orderedLinks.length - 1));
      this.toast(`Removed ${l.title}`);
    } catch (e) {
      this.fail(e);
    }
  }

  /** A URL pasted outside any field is linked to the current space. */
  async addLinkFromPaste(text: string): Promise<boolean> {
    const t = text.trim();
    if (!this.ready || !this.spaces.length || !isHttpUrl(t) || /\s/.test(t)) return false;
    const sid = this.space.id;
    try {
      const l = await this.backend.addLink(sid, t, undefined, "paste");
      await this.reloadLinks(sid);
      this.toast(`Linked ${l.title}`);
    } catch (e) {
      this.fail(e);
    }
    return true;
  }

  closeOverlay() {
    this.overlay = null;
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
    const failing = !g.checks.every((x) => x.pass);
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
      this.toast(`${r.pushed === false ? "Committed" : "Pushed"} ${plural(n, "commit", "commits")} on ${r.branch}`);
      await this.refresh(s.id);
    } catch (e) {
      this.fail(e);
    }
  }

  async createSpace() {
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
      const s = await this.backend.createSpace(name, [...this.newSp.repos]);
      await this.syncSpaces();
      await this.load(s.id);
      this.ui[s.id].view = this.data[s.id].agents.length ? "agents" : "code";
      this.active = Math.max(0, this.spaces.findIndex((x) => x.id === s.id));
      this.overlay = null;
      this.newSp = { name: "", repos: this.defaultRepos(), missingName: false };
      this.toast(`Created ${plural(s.repos.length, "worktree", "worktrees")} on ${s.branch}`);
    } catch (e) {
      this.fail(e);
    }
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
    void this.dispatch(item.action);
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
        if (p) this.cui.hi = p.hunk.id;
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
      case "blur":
        return void (document.activeElement as HTMLElement | null)?.blur();
      case "newspace-submit":
        return this.createSpace();
      case "commit-submit":
        return this.doCommit();
      case "composer-role":
        return this.cycleRole(a.delta);
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
        return this.decide("reject");
      case "edit":
        return this.decide("edit");
      case "undo":
        return this.undo();
      case "fix":
        return this.askFix();
      case "answer":
        return this.answer(a.yes);
      case "toggle-files":
        this.filesOpen = !this.filesOpen;
        return;
      case "toggle-stack":
        this.stackOpen = !this.stackOpen;
        return;
      case "open-stack":
        this.stackOpen = true;
        return;
      case "open-commit":
        return this.openCommit();
      case "open-links":
        return this.openLinks();
      case "open-link":
        return this.openLink(a.id);
      case "links-move":
        return this.linksMove(a.delta);
      case "links-open":
        return this.openLink();
      case "links-submit":
        return this.linksSubmit();
      case "links-remove":
        return this.removeLink();
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
      case "toggle-window":
        return this.toggleWindow();
      case "open-composer":
        return this.openComposer();
      case "open-newspace":
        this.overlay = "newspace";
        return;
      case "open-help":
        this.overlay = "help";
        return;
      case "open-file":
        return this.openFile(a.space, a.file);
      case "quick-open":
        this.overlay = this.overlay === "quickopen" ? null : "quickopen";
        return;
      case "files-filter":
        if (!this.filesOpen) this.filesOpen = true;
        await tick();
        document.querySelector<HTMLElement>("[data-files-filter]")?.focus();
        return;
    }
  }

  /** Unique repos of the staged files. */
  get stagedRepos(): string[] {
    return uniq(this.staged.map((f) => f.repo));
  }
}

export const app = new AppState();
