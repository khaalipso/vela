// The shell state: what the backend says about each space, plus what only the UI knows
// (current view, focused proposal, open overlay). Components read it, `dispatch` changes it.

import type {
  AgentQuestion,
  Backend,
  BackendEvent,
  FileRef,
  GateCheck,
  ReviewNote,
  Unsubscribe,
} from "./backend";
import { GATE_NAMES, fileKey, plural, roleLabel, ROLES, toolLabel, uniq } from "./format";
import type { Action, Overlay, View } from "./keymap";
import { buildPaletteItems, filterPalette, type PaletteItem } from "./palette";
import type { Agent, AgentRole, FileChange, Hunk, Space, StackItem } from "./types";
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
}

export interface SpaceUi {
  view: View;
  /** Id of the focused proposal. */
  hi: string | null;
  /** Key (repo/path) of the file open in the code view. */
  file: string;
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

export interface GateState {
  checks: GateCheck[];
  message: string;
  reason: string;
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

  changes = $state(false);
  overlay = $state<Overlay>(null);
  stackOpen = $state(false);
  role = $state<AgentRole>("developer");
  composerText = $state("");
  pal = $state({ q: "", i: 0 });
  newSp = $state({ name: "", repos: ["api"], missingName: false });
  gate = $state<GateState | null>(null);
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

  // -- boot -----------------------------------------------------------------

  async init(backend: Backend) {
    this.backend = backend;
    this.off?.();
    this.off = backend.onChange((e) => void this.onEvent(e));
    this.repos = await backend.listRepos();
    this.spaces = await backend.listSpaces();
    await Promise.all(this.spaces.map((s) => this.load(s.id)));
    this.ready = true;
  }

  destroy() {
    this.off?.();
  }

  /** Refresh the list of spaces, loading the data of new ones before they are shown. */
  private async syncSpaces() {
    const list = await this.backend.listSpaces();
    await Promise.all(list.filter((s) => !this.data[s.id]).map((s) => this.load(s.id)));
    this.spaces = list;
  }

  private async onEvent(e: BackendEvent) {
    await this.syncSpaces();
    await this.load(e.spaceId, e.kind === "file");
    if (e.kind !== "file") this.contentRev[e.spaceId] = (this.contentRev[e.spaceId] ?? 0) + 1;
    if (e.toast) this.toast(e.toast);
  }

  /** Reload everything the backend knows about a space. */
  async load(id: string, light = false) {
    const b = this.backend;
    const [hunks, reasons, agents, stack, status, question, notes, files] = await Promise.all([
      b.hunks(id),
      b.reasons(id),
      b.agents(id),
      b.stack(id),
      b.status(id),
      b.question(id),
      b.notes(id),
      b.listFiles(id),
    ]);
    this.data = { ...this.data, [id]: { hunks, reasons, agents, stack, status, question, notes, files } };
    if (!light || !this.ui[id]) this.ensureUi(id);
  }

  private ensureUi(id: string) {
    if (this.ui[id]) return;
    const d = this.data[id];
    const pending = d.hunks.filter((h) => h.origin.type === "agent" && h.state === "pending");
    const first = pending[0] ?? d.hunks.find((h) => h.origin.type === "agent");
    const file = first ? fileKey(first.repo, first.path) : d.files[0] ? fileKey(d.files[0].repo, d.files[0].path) : "";
    this.ui[id] = {
      view: d.question ? "agents" : pending.length ? "review" : "code",
      hi: first?.id ?? null,
      file,
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
    return (this.space.window ?? null) !== null;
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
      spaces: this.spaces.map((s) => ({
        name: s.name,
        branch: s.branch,
        color: s.color,
        files: this.data[s.id].files.map((f) => ({ id: fileKey(f.repo, f.path), repo: f.repo, path: f.path })),
      })),
    });
    return filterPalette(items, this.pal.q);
  }

  get gateOk(): boolean {
    const g = this.gate;
    if (!g || g.checks.length < GATE_TOTAL) return false;
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

  openFile(spaceIdx: number, file: string) {
    this.active = spaceIdx;
    const u = this.ui[this.spaces[spaceIdx].id];
    u.view = "code";
    u.file = file;
    this.overlay = null;
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
    await this.backend.setWindow(s.id, toMain ? null : 2);
    this.toast(toMain ? `${s.name} is back in this window` : `${s.name} moved to window 2`);
    await this.refresh(s.id);
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
    const message = await this.backend.draftCommit(sid);
    this.gate = { checks: [], message, reason: "" };
    this.overlay = "commit";
    try {
      await this.backend.runGate(sid, (i, c) => {
        if (token !== this.gateSeq || !this.gate || this.overlay !== "commit") return;
        const checks = this.gate.checks.slice();
        checks[i] = c;
        this.gate.checks = checks;
      });
    } catch (e) {
      this.fail(e);
    }
  }

  closeOverlay() {
    this.overlay = null;
    this.gate = null;
    this.stackOpen = false;
    this.gateSeq++;
  }

  async doCommit() {
    const g = this.gate;
    if (!g || !this.gateOk) return;
    const s = this.space;
    const failing = !g.checks.every((c) => c.pass);
    try {
      const r = await this.backend.commit(s.id, g.message, failing ? g.reason.trim() : undefined);
      this.overlay = null;
      this.gate = null;
      this.gateSeq++;
      this.cui.hi = null;
      this.toast(`Pushed ${r.repos.join(" and ")} on ${r.branch}`);
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
      this.ui[s.id].view = "agents";
      this.active = this.spaces.findIndex((x) => x.id === s.id);
      this.overlay = null;
      this.newSp = { name: "", repos: ["api"], missingName: false };
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
      case "toggle-changes":
        this.changes = !this.changes;
        return;
      case "toggle-stack":
        this.stackOpen = !this.stackOpen;
        return;
      case "open-stack":
        this.stackOpen = true;
        return;
      case "open-commit":
        return this.openCommit();
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
    }
  }

  /** Unique repos of the staged files. */
  get stagedRepos(): string[] {
    return uniq(this.staged.map((f) => f.repo));
  }
}

export const app = new AppState();
