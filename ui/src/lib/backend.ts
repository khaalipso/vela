import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fileKey, toolForRole, toolLabel, uniq } from "./format";
import { composeMessage, planFromHunks, validateFor } from "./commitplan";
import { isHttpUrl, makeLink, removable, sameLink } from "./links";
import { fakeContent, repoPaths } from "./seedtree";
import { REPOS, seedLinks, seedSpaces, type SeedSpace } from "./seed";
import type {
  Agent,
  AgentRole,
  CommitGroup,
  CommitPlan,
  ChangeKind,
  CommitRules,
  DiffLine,
  FileChange,
  GroupCommit,
  Hunk,
  HunkState,
  Link,
  LinkSource,
  Problem,
  CheckEntry,
  CheckKind,
  CheckStatus,
  RepoChecks,
  RepoFiles,
  Space,
  StackItem,
} from "./types";

// ---------------------------------------------------------------------------
// UI-side types that are not part of model.rs
// ---------------------------------------------------------------------------

export interface FileRef {
  repo: string;
  path: string;
}

/** File content. For big files the mock only holds a snippet that starts at `firstLine`. */
export interface FileContent extends FileRef {
  content: string;
  /** Number of the first line of `content` in the real file (1 for a whole file). */
  firstLine: number;
  language: "typescript" | "javascript" | "rust" | "yaml" | "sql" | "markdown" | "plain";
}

/** A blocking note from the reviewer, attached to a hunk. */
export interface ReviewNote {
  hunkId: string;
  /** e.g. "Reviewer · Codex". */
  by: string;
  text: string;
  resolved: boolean;
  /** The author is working on the fix. */
  busy: boolean;
}

/** A question an agent is waiting on. */
export interface AgentQuestion {
  agentId: string;
  role: AgentRole;
  tool: string;
  text: string;
  yes: string;
  no: string;
}

export interface GateCheck {
  name: string;
  detail: string;
  pass: boolean;
}

export interface CommitResult {
  repos: string[];
  branch: string;
  /** False when the commits stay local (the real backend does not push yet). */
  pushed?: boolean;
  /** One entry per commit made by `commitGroups`. */
  commits?: GroupCommit[];
}

export interface BackendEvent {
  spaceId: string;
  /** "file" when the content of a file was written by the user, "state" otherwise. */
  kind: "file" | "state";
  /** Message to show in a toast, if any. */
  toast?: string;
}

/** `vela://check`: live progress of one check. `line` is one line of output while running. */
export interface CheckEvent {
  spaceId: string;
  repo: string;
  id: string;
  status: CheckStatus;
  line?: string;
  durationMs?: number;
  cached?: boolean;
  exitCode?: number;
  timedOut?: boolean;
}

export type Unsubscribe = () => void;

export interface Backend {
  listRepos(): Promise<string[]>;
  /** Declare a repo by folder path (~ allowed). Returns the updated repo list. */
  declareRepo(path: string): Promise<string[]>;
  /** Create `<parent>/<name>` as a new git repo with a first commit, and declare it. Returns its path. */
  createRepo(parent: string, name: string): Promise<string>;
  /** Folder where new repos go by default (the first repo root, ~/Work by default). */
  defaultRepoParent(): Promise<string>;
  listSpaces(): Promise<Space[]>;
  createSpace(name: string, repos: string[]): Promise<Space>;
  /** Add a repo (path) to a space: one more worktree on the space branch. */
  addRepoToSpace(spaceId: string, path: string): Promise<Space>;
  /** Remove a repo from a space; refused when its worktree has uncommitted changes. */
  removeRepoFromSpace(spaceId: string, repo: string): Promise<Space>;
  /** Move a space to another window, or back to the main one with null. */
  setWindow(spaceId: string, window: number | null): Promise<void>;

  status(spaceId: string): Promise<FileChange[]>;
  /** Agent proposals (any state) and the lines you typed (origin "you"). */
  hunks(spaceId: string): Promise<Hunk[]>;
  /** One-line reason each agent gives for its proposals, by hunk id. Not in model.rs yet. */
  reasons(spaceId: string): Promise<Record<string, string>>;
  /** Accept: apply the proposal to your worktree and stage it. */
  stageHunk(spaceId: string, hunkId: string): Promise<Hunk>;
  /** Undo an accepted or rejected hunk: back to pending. */
  unstageHunk(spaceId: string, hunkId: string): Promise<Hunk>;
  rejectHunk(spaceId: string, hunkId: string): Promise<Hunk>;
  /** Accept, then the caller opens the lines in the editor. */
  editHunk(spaceId: string, hunkId: string): Promise<Hunk>;

  listFiles(spaceId: string): Promise<FileRef[]>;
  /** The file tree: every file of every repo of the space with its status. */
  spaceFiles(spaceId: string): Promise<RepoFiles[]>;
  /** Stage every change of one file (tracked, deleted or untracked). */
  stageFile(spaceId: string, repo: string, path: string): Promise<void>;
  unstageFile(spaceId: string, repo: string, path: string): Promise<void>;
  readFile(spaceId: string, repo: string, path: string): Promise<FileContent>;
  writeFile(spaceId: string, repo: string, path: string, content: string): Promise<void>;

  agents(spaceId: string): Promise<Agent[]>;
  askAgent(spaceId: string, role: AgentRole, prompt: string): Promise<Agent>;
  question(spaceId: string): Promise<AgentQuestion | null>;
  answerAgent(spaceId: string, yes: boolean): Promise<void>;
  notes(spaceId: string): Promise<ReviewNote[]>;
  /** Ask the author of the hunk to fix the reviewer's blocking note. */
  askFix(spaceId: string, hunkId: string): Promise<void>;

  stack(spaceId: string): Promise<StackItem[]>;

  draftCommit(spaceId: string): Promise<string>;
  /** Runs the gate on the staged diff. `onCheck` fires as each check finishes. */
  runGate(spaceId: string, onCheck?: (index: number, check: GateCheck) => void): Promise<GateCheck[]>;
  /** One commit per repo. Fails when the gate fails and no override reason is given. */
  commit(spaceId: string, message: string, overrideReason?: string): Promise<CommitResult>;

  /** Propose commits for the staged hunks: grouped, typed, scoped, with ticket footers. */
  commitPlan(spaceId: string): Promise<CommitPlan>;
  validateMessage(message: string, rules: CommitRules, conventional: boolean): Promise<Problem[]>;
  /** Commit the groups in order. Fails when the gate fails and no override reason is given. */
  commitGroups(
    spaceId: string,
    groups: CommitGroup[],
    conventional: boolean,
    overrideReason?: string,
  ): Promise<CommitResult>;

  /** Stored, detected and repo links of the space. */
  links(spaceId: string): Promise<Link[]>;
  addLink(spaceId: string, url: string, title?: string, source?: LinkSource): Promise<Link>;
  /** Only links the user added can be removed. */
  removeLink(spaceId: string, linkId: string): Promise<void>;
  /** Open in the default browser. Only http and https. */
  openUrl(url: string): Promise<void>;

  onChange(listener: (e: BackendEvent) => void): Unsubscribe;

  // -- right-click menu operations ------------------------------------------
  /** Create an empty file (and its folders). Fails when it exists. `path` is relative to the repo worktree. */
  createFile(spaceId: string, repo: string, path: string): Promise<void>;
  /** Create a folder. Git only lists it once it holds a file. */
  createDir(spaceId: string, repo: string, path: string): Promise<void>;
  renamePath(spaceId: string, repo: string, from: string, to: string): Promise<void>;
  /**
   * Delete a file or folder: system trash first. When there is no trash it fails with a
   * `no_trash` error and nothing is deleted; call again with `permanent` to remove for good.
   */
  deletePath(spaceId: string, repo: string, path: string, permanent?: boolean): Promise<"trashed" | "deleted">;
  /** Throw away the unstaged changes of a file (untracked files are deleted). */
  discardFile(spaceId: string, repo: string, path: string): Promise<void>;
  /** Show a file or folder in the file manager; an empty path is the worktree of the repo. */
  revealPath(spaceId: string, repo: string, path: string): Promise<void>;
  /** Absolute path on disk; an empty path is the worktree of the repo. */
  absolutePath(spaceId: string, repo: string, path: string): Promise<string>;
  /** Open a terminal in the folder (or the folder of the file). Returns the program used. */
  openTerminal(spaceId: string, repo: string, path: string): Promise<string>;
  renameSpace(spaceId: string, name: string): Promise<Space>;
  /** `#RRGGBB`. */
  setSpaceColor(spaceId: string, color: string): Promise<Space>;
  /** Hide a space from the rail; its worktrees stay. */
  archiveSpace(spaceId: string): Promise<Space>;
  unarchiveSpace(spaceId: string): Promise<Space>;
  listArchived(): Promise<Space[]>;
  /** Remove the worktrees; branches with unmerged commits are kept. */
  removeSpace(spaceId: string): Promise<void>;

  /** Checks of every repo of the space with the status for the current staged set. */
  checks(spaceId: string): Promise<RepoChecks[]>;
  /** Start checks (`ids` picks some, even disabled ones; none runs every enabled check). Progress comes through `onCheck`. */
  runChecks(spaceId: string, ids?: string[], force?: boolean): Promise<void>;
  checkLog(spaceId: string, repo: string, id: string): Promise<string>;
  setCheckEnabled(spaceId: string, repo: string, id: string, enabled: boolean): Promise<void>;
  setChecksAuto(spaceId: string, repo: string, auto: boolean): Promise<void>;
  onCheck(listener: (e: CheckEvent) => void): Unsubscribe;
}

export function languageOf(path: string): FileContent["language"] {
  const ext = path.split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
      return "javascript";
    case "rs":
      return "rust";
    case "yml":
    case "yaml":
      return "yaml";
    case "sql":
      return "sql";
    case "md":
      return "markdown";
    default:
      return "plain";
  }
}

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

interface MFile extends FileRef {
  firstLine: number;
  lines: string[];
  /** Content before the first edit by hand, to discard back to it. */
  orig?: string[];
  /** Indices of the lines you typed. */
  mine: Set<number>;
}

interface MHunk {
  id: string;
  repo: string;
  path: string;
  at: number;
  del: string[];
  add: string[];
  agent: string;
  why: string;
  section: string;
  state: HunkState;
}

interface MSpace {
  space: Space;
  files: MFile[];
  hunks: MHunk[];
  agents: Agent[];
  stack: StackItem[];
  tests: { pass: number; total: number };
  baseStaged: FileRef[];
  /** Paths of the generated tree that were deleted or renamed away (`repo/path`). */
  removed: Set<string>;
  /** Files staged or unstaged by hand from the file tree. */
  fileStage: Map<string, { staged: ChangeKind | null; unstaged: ChangeKind | null }>;
  commitMsg: string;
  links: Link[];
  question: SeedSpace["question"];
  notes: Map<string, { note: ReviewNote; fix: string[] }>;
}

interface MCheckDef {
  repo: string;
  id: string;
  name: string;
  kind: CheckKind;
  command: string;
  optional: boolean;
  source: string;
  /** Simulated duration. */
  ms: number;
  fails: boolean;
  log: string[];
}

interface MCheckState {
  defs: MCheckDef[];
  enabled: Map<string, boolean>;
  auto: Map<string, boolean>;
  running: Set<string>;
  cache: Map<string, { status: CheckStatus; durationMs: number }>;
  logs: Map<string, string>;
  autoSeq: number;
}

export interface MockOptions {
  /** Multiplier for the simulated delays. 1 matches the prototype, 0 makes them instant. */
  speed?: number;
  /** False simulates a machine without a system trash (deleting asks for confirmation). */
  trash?: boolean;
}

export interface CommitRecord {
  spaceId: string;
  message: string;
  repos: string[];
  override?: string;
  /** The composer group this commit came from. */
  group?: string;
}

const PALETTE = ["#E8A14A", "#7DB8F5", "#C9A0F0", "#4ADE80", "#F0A3C0", "#9BD0C8"];

export class MockBackend implements Backend {
  private spaces = new Map<string, MSpace>();
  private listeners = new Set<(e: BackendEvent) => void>();
  private speed: number;
  /** Commits made so far, for tests and for the curious. */
  readonly commits: CommitRecord[] = [];
  /** URLs passed to `openUrl`. */
  readonly opened: string[] = [];
  /** Paths passed to `revealPath`, `openTerminal`, and moved to the trash (`repo/path`). */
  readonly revealed: string[] = [];
  readonly terminals: string[] = [];
  readonly trashed: string[] = [];
  private hasTrash: boolean;

  constructor(opts: MockOptions = {}) {
    this.speed = opts.speed ?? 1;
    this.hasTrash = opts.trash ?? true;
    const links = seedLinks();
    for (const s of seedSpaces()) {
      this.spaces.set(s.space.id, {
        links: links[s.space.id] ?? [],
        space: s.space,
        files: s.files.map((f) => ({ ...f, mine: new Set<number>() })),
        hunks: s.hunks.map((h) => ({ ...h, section: h.section ?? "", state: "pending" as const })),
        agents: s.agents,
        stack: s.stack,
        tests: s.tests,
        baseStaged: s.baseStaged,
        fileStage: new Map(),
        removed: new Set(),
        commitMsg: s.commitMsg,
        question: s.question,
        notes: new Map(
          s.notes.map((n) => [
            n.hunkId,
            { note: { hunkId: n.hunkId, by: n.by, text: n.text, resolved: false, busy: false }, fix: n.fix },
          ]),
        ),
      });
    }
  }

  // -- helpers --------------------------------------------------------------

  private sp(id: string): MSpace {
    const s = this.spaces.get(id);
    if (!s) throw new Error(`Unknown space: ${id}`);
    return s;
  }

  private file(s: MSpace, repo: string, path: string): MFile {
    let f = s.files.find((x) => x.repo === repo && x.path === path);
    if (s.removed.has(fileKey(repo, path))) f = undefined;
    else if (!f && s.space.repos.some((r) => r.name === repo) && repoPaths(repo).includes(path)) {
      // A generated file of the tree: it gets content the first time it is opened.
      f = { repo, path, firstLine: 1, lines: fakeContent(path), mine: new Set<number>() };
      s.files.push(f);
    }
    if (!f) throw new Error(`Unknown file: ${repo}/${path}`);
    return f;
  }

  private emit(spaceId: string, kind: BackendEvent["kind"] = "state", toast?: string) {
    for (const l of [...this.listeners]) l({ spaceId, kind, toast });
    if (kind === "state") this.scheduleAuto(spaceId);
  }

  private later(ms: number, fn: () => void) {
    setTimeout(fn, ms * this.speed);
  }

  private find(s: MSpace, hunkId: string): MHunk {
    const h = s.hunks.find((x) => x.id === hunkId);
    if (!h) throw new Error(`Unknown hunk: ${hunkId}`);
    return h;
  }

  private toHunk(s: MSpace, h: MHunk): Hunk {
    const f = this.file(s, h.repo, h.path);
    const n = f.firstLine + h.at;
    const lines: DiffLine[] = [
      ...h.del.map((text, i) => ({ kind: "del" as const, text, old: n + i, new: null })),
      ...h.add.map((text, i) => ({ kind: "add" as const, text, old: null, new: n + i })),
    ];
    return {
      id: h.id,
      repo: h.repo,
      path: h.path,
      oldStart: n,
      oldLines: h.del.length,
      newStart: n,
      newLines: h.add.length,
      section: h.section,
      lines,
      origin: { type: "agent", agent: h.agent },
      state: h.state,
    };
  }

  /** Lines you typed, grouped in runs. */
  private youHunks(s: MSpace): Hunk[] {
    const out: Hunk[] = [];
    for (const f of s.files) {
      const idx = [...f.mine].sort((a, b) => a - b);
      let i = 0;
      while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
        const start = idx[i];
        const lines: DiffLine[] = [];
        for (let k = i; k <= j; k++) {
          lines.push({ kind: "add", text: f.lines[idx[k]] ?? "", old: null, new: f.firstLine + idx[k] });
        }
        out.push({
          id: `you:${fileKey(f.repo, f.path)}#${start}`,
          repo: f.repo,
          path: f.path,
          oldStart: f.firstLine + start,
          oldLines: 0,
          newStart: f.firstLine + start,
          newLines: lines.length,
          section: "",
          lines,
          origin: { type: "you" },
          state: "pending",
        });
        i = j + 1;
      }
    }
    return out;
  }

  /** Replace `removed` lines at `start` by `inserted` lines in the bookkeeping (marks and other hunks). */
  private remap(s: MSpace, f: MFile, start: number, removed: number, inserted: number, except?: string) {
    const delta = inserted - removed;
    const next = new Set<number>();
    for (const i of f.mine) {
      if (i < start) next.add(i);
      else if (i >= start + removed) next.add(i + delta);
    }
    f.mine = next;
    for (const o of s.hunks) {
      if (o.id !== except && o.repo === f.repo && o.path === f.path && o.at > start && o.at >= start + removed) {
        o.at += delta;
      }
    }
  }

  private apply(s: MSpace, h: MHunk) {
    const f = this.file(s, h.repo, h.path);
    f.lines.splice(h.at, h.del.length, ...h.add);
    this.remap(s, f, h.at, h.del.length, h.add.length, h.id);
  }

  private unapply(s: MSpace, h: MHunk) {
    const f = this.file(s, h.repo, h.path);
    f.lines.splice(h.at, h.add.length, ...h.del);
    this.remap(s, f, h.at, h.add.length, h.del.length, h.id);
  }

  private stagedFiles(s: MSpace): FileRef[] {
    const m = new Map<string, FileRef>();
    for (const f of s.baseStaged) m.set(fileKey(f.repo, f.path), f);
    for (const h of s.hunks) if (h.state === "staged") m.set(fileKey(h.repo, h.path), { repo: h.repo, path: h.path });
    return [...m.values()];
  }

  /** Enabled checks whose result for the staged set is a failure: they block the gate. */
  private failingChecks(s: MSpace): GateCheck[] {
    const st = this.checkStates.get(s.space.id);
    if (!st) return [];
    const tree = this.stagedTree(s);
    return st.defs
      .filter((d) => this.isEnabled(st, d) && st.cache.get(`${this.ckKey(d)}@${tree}`)?.status === "fail")
      .map((d) => ({ name: d.name, detail: "failed", pass: false }));
  }

  private gateChecks(s: MSpace, withChecks = true): GateCheck[] {
    const blocking = [...s.notes.values()].filter(
      (n) => !n.note.resolved && s.hunks.find((h) => h.id === n.note.hunkId)?.state !== "rejected",
    ).length;
    const t = s.tests;
    return [
      ...(withChecks ? this.failingChecks(s) : []),
      { name: "Reviewer", detail: blocking ? `${blocking} blocking` : "no blocking notes", pass: !blocking },
      { name: "Tests touched by the diff", detail: `${t.pass} of ${t.total}`, pass: t.pass === t.total },
      { name: "Lint and types", detail: "clean", pass: true },
      { name: "Secrets and .env", detail: "clean", pass: true },
      { name: "Repo rules", detail: "AGENTS.md", pass: true },
    ];
  }

  // -- spaces ---------------------------------------------------------------

  async listRepos(): Promise<string[]> {
    return [...this.declared, ...REPOS.filter((r) => !this.declared.includes(r))];
  }

  private declared: string[] = [];

  async createRepo(parent: string, name: string): Promise<string> {
    const n = name.trim();
    if (!n || n.startsWith(".") || n.includes("/")) throw new Error(`invalid repo name: "${n}"`);
    const path = `${parent.replace(/\/+$/, "")}/${n}`;
    if (this.declared.includes(path) || REPOS.includes(n)) throw new Error(`${path} already exists`);
    this.declared = [path, ...this.declared];
    return path;
  }

  async defaultRepoParent(): Promise<string> {
    return "~/Work";
  }

  async declareRepo(path: string): Promise<string[]> {
    const p = path.trim();
    if (!p.startsWith("/") && !p.startsWith("~")) throw new Error(`folder not found: ${p}`);
    this.declared = [p, ...this.declared.filter((x) => x !== p)];
    return this.listRepos();
  }

  async listSpaces(): Promise<Space[]> {
    return structuredClone([...this.spaces.values()].map((s) => s.space).filter((x) => !x.archived));
  }

  async addRepoToSpace(spaceId: string, path: string): Promise<Space> {
    const s = this.sp(spaceId);
    const name = path.split("/").pop() || path;
    if (s.space.repos.some((r) => r.source === path || r.name === name)) throw new Error(`${name} is already in this space`);
    s.space.repos = [...s.space.repos, { name, source: path, worktree: `wt/${s.space.id}`, base: "main" }];
    this.emit(spaceId);
    return { ...s.space };
  }

  async removeRepoFromSpace(spaceId: string, repo: string): Promise<Space> {
    const s = this.sp(spaceId);
    if (s.space.repos.length === 1) throw new Error("a space needs at least one repo; remove the space instead");
    if (!s.space.repos.some((r) => r.name === repo)) throw new Error(`repo not found: ${repo}`);
    s.space.repos = s.space.repos.filter((r) => r.name !== repo);
    this.emit(spaceId);
    return { ...s.space };
  }

  async createSpace(name: string, repos: string[]): Promise<Space> {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "task";
    let slug = base;
    for (let n = 2; this.spaces.has(slug); n++) slug = `${base}-${n}`;
    const space: Space = {
      id: slug,
      name,
      color: PALETTE[this.spaces.size % PALETTE.length],
      branch: `feat/${slug}`,
      repos: repos.map((r) => ({ name: r, source: `~/Work/${r}`, worktree: `wt/${slug}`, base: "main" })),
      createdAt: new Date().toISOString(),
      window: null,
    };
    const planner: Agent = {
      id: `${slug}-planner`,
      space: slug,
      role: "planner",
      tool: "claude",
      worktrees: [],
      status: "working",
      summary: "Reading the repos to split the task",
    };
    const s: MSpace = {
      space,
      files: [{ repo: repos[0], path: "README.md", firstLine: 1, lines: [`# ${repos[0]}`, ""], mine: new Set() }],
      hunks: [],
      agents: [planner],
      stack: [{ name: "mise", version: null, source: "mise.toml", kind: "runtime", state: "starting" }],
      tests: { pass: 0, total: 0 },
      baseStaged: [],
      fileStage: new Map(),
      removed: new Set(),
      links: [],
      commitMsg: `feat: ${name.toLowerCase()}`,
      question: null,
      notes: new Map(),
    };
    this.spaces.set(slug, s);
    this.later(1800, () => {
      s.stack = [{ name: "node", version: "22.11", source: "mise.toml", kind: "runtime", state: "ok" }];
      planner.status = "done";
      planner.summary = "Plan ready: 3 steps. Ask the Developer to start with @";
      this.emit(slug);
    });
    this.emit(slug);
    return structuredClone(space);
  }

  async setWindow(spaceId: string, window: number | null): Promise<void> {
    this.sp(spaceId).space.window = window;
    this.emit(spaceId);
  }

  // -- status and hunks -----------------------------------------------------

  async status(spaceId: string): Promise<FileChange[]> {
    const s = this.sp(spaceId);
    const m = new Map<string, FileChange>();
    const get = (r: FileRef) => {
      const k = fileKey(r.repo, r.path);
      let c = m.get(k);
      if (!c) m.set(k, (c = { repo: r.repo, path: r.path, staged: null, unstaged: null }));
      return c;
    };
    for (const f of this.stagedFiles(s)) get(f).staged = "modified";
    for (const f of s.files) if (f.mine.size) get(f).unstaged = "modified";
    for (const [k, o] of s.fileStage) {
      const i = k.indexOf("/");
      const c = get({ repo: k.slice(0, i), path: k.slice(i + 1) });
      c.staged = o.staged;
      c.unstaged = o.unstaged;
    }
    return [...m.values()].filter((c) => c.staged || c.unstaged);
  }

  async spaceFiles(spaceId: string): Promise<RepoFiles[]> {
    const s = this.sp(spaceId);
    const st = new Map((await this.status(spaceId)).map((c) => [fileKey(c.repo, c.path), c]));
    return s.space.repos.map((r) => {
      const paths = new Set(repoPaths(r.name).filter((p) => !s.removed.has(fileKey(r.name, p))));
      for (const f of s.files) if (f.repo === r.name && !s.removed.has(fileKey(f.repo, f.path))) paths.add(f.path);
      for (const c of st.values()) if (c.repo === r.name) paths.add(c.path);
      const files = [...paths].sort().map((path) => {
        const c = st.get(fileKey(r.name, path));
        return { path, staged: c?.staged ?? null, unstaged: c?.unstaged ?? null };
      });
      return { repo: r.name, branch: s.space.branch, worktree: r.worktree, ahead: null, behind: null, files, truncated: false };
    });
  }

  async hunks(spaceId: string): Promise<Hunk[]> {
    const s = this.sp(spaceId);
    return [...s.hunks.map((h) => this.toHunk(s, h)), ...this.youHunks(s)];
  }

  async reasons(spaceId: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.sp(spaceId).hunks.map((h) => [h.id, h.why]));
  }

  async stageHunk(spaceId: string, hunkId: string): Promise<Hunk> {
    const s = this.sp(spaceId);
    const h = this.find(s, hunkId);
    if (h.state === "pending") {
      this.apply(s, h);
      h.state = "staged";
      this.emit(spaceId);
    }
    return this.toHunk(s, h);
  }

  async editHunk(spaceId: string, hunkId: string): Promise<Hunk> {
    return this.stageHunk(spaceId, hunkId);
  }

  async rejectHunk(spaceId: string, hunkId: string): Promise<Hunk> {
    const s = this.sp(spaceId);
    const h = this.find(s, hunkId);
    if (h.state === "pending") {
      h.state = "rejected";
      this.emit(spaceId);
    }
    return this.toHunk(s, h);
  }

  async unstageHunk(spaceId: string, hunkId: string): Promise<Hunk> {
    const s = this.sp(spaceId);
    const h = this.find(s, hunkId);
    if (h.state === "staged") this.unapply(s, h);
    if (h.state !== "pending") {
      h.state = "pending";
      this.emit(spaceId);
    }
    return this.toHunk(s, h);
  }

  // -- files ----------------------------------------------------------------

  async listFiles(spaceId: string): Promise<FileRef[]> {
    const s = this.sp(spaceId);
    return s.files.filter((f) => !s.removed.has(fileKey(f.repo, f.path))).map((f) => ({ repo: f.repo, path: f.path }));
  }

  async readFile(spaceId: string, repo: string, path: string): Promise<FileContent> {
    const f = this.file(this.sp(spaceId), repo, path);
    return { repo, path, content: f.lines.join("\n"), firstLine: f.firstLine, language: languageOf(path) };
  }

  async writeFile(spaceId: string, repo: string, path: string, content: string): Promise<void> {
    const s = this.sp(spaceId);
    const f = this.file(s, repo, path);
    const a = f.lines;
    const b = content.split("\n");
    if (!f.orig && !f.mine.size) f.orig = a.slice();
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let q = 0;
    while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    const removed = a.length - q - p;
    const inserted = b.length - q - p;
    if (removed === 0 && inserted === 0) return;
    f.lines = b;
    this.remap(s, f, p, removed, inserted);
    for (let i = p; i < p + inserted; i++) f.mine.add(i);
    this.emit(spaceId, "file");
  }

  // -- agents ---------------------------------------------------------------

  async agents(spaceId: string): Promise<Agent[]> {
    return structuredClone(this.sp(spaceId).agents);
  }

  async stack(spaceId: string): Promise<StackItem[]> {
    return structuredClone(this.sp(spaceId).stack);
  }

  async question(spaceId: string): Promise<AgentQuestion | null> {
    const s = this.sp(spaceId);
    const q = s.question;
    if (!q) return null;
    const a = s.agents.find((x) => x.id === q.agentId);
    return { agentId: q.agentId, role: a?.role ?? "developer", tool: a?.tool ?? "claude", text: q.text, yes: q.yes, no: q.no };
  }

  async notes(spaceId: string): Promise<ReviewNote[]> {
    return structuredClone([...this.sp(spaceId).notes.values()].map((n) => n.note));
  }

  async askAgent(spaceId: string, role: AgentRole, prompt: string): Promise<Agent> {
    const s = this.sp(spaceId);
    const tool = toolForRole(role);
    const wt = `wt/${s.space.branch.split("/").pop()}-${role}`;
    const agent: Agent = {
      id: `${spaceId}-${role}-${s.agents.length + 1}`,
      space: spaceId,
      role,
      tool,
      worktrees: [[s.space.repos[0].name, wt]],
      status: "working",
      summary: prompt,
    };
    s.agents.unshift(agent);
    this.emit(spaceId);
    this.later(2200, () => {
      const f = s.files[0];
      const ext = f.path.split(".").pop();
      const c = ext === "yml" ? "#" : ext === "sql" ? "--" : "//";
      s.hunks.push({
        id: `c${s.hunks.length + 1}-${agent.id}`,
        repo: f.repo,
        path: f.path,
        at: Math.max(0, f.lines.length - 1),
        del: [],
        add: [`  ${c} ${prompt}`],
        agent: agent.id,
        why: `Draft for: ${prompt}`,
        section: "",
        state: "pending",
      });
      agent.status = "done";
      agent.summary = `1 proposal ready: ${prompt}`;
      this.emit(spaceId);
    });
    return structuredClone(agent);
  }

  async answerAgent(spaceId: string, yes: boolean): Promise<void> {
    const s = this.sp(spaceId);
    const q = s.question;
    if (!q) return;
    s.question = null;
    const author = s.agents.find((a) => a.id === q.agentId);
    for (const a of s.agents) {
      if (a.status === "waiting") {
        a.status = "working";
        a.summary = yes ? "Keeping pg_trgm, adding it to the image init script" : "Dropping pg_trgm and the fuzzy index";
      }
    }
    this.emit(spaceId);
    this.later(1600, () => {
      const f = s.files.find((x) => x.path.endsWith(".sql")) ?? s.files[0];
      s.hunks.push({
        id: "p3",
        repo: f.repo,
        path: f.path,
        at: yes ? 0 : 1,
        del: yes
          ? []
          : [
              "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
              "CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops);",
            ],
        add: yes
          ? ["-- requires pg_trgm, installed by infra/initdb/10_ext.sql"]
          : ["-- pg_trgm dropped with Postgres 17, see chore/pg17"],
        agent: author?.id ?? q.agentId,
        why: yes ? "Document where the extension now comes from." : "Remove the extension and its index.",
        section: "",
        state: "pending",
      });
      for (const a of s.agents) {
        if (a.tool === (author?.tool ?? "crush")) {
          a.status = "done";
          a.summary = "1 new proposal";
        }
      }
      this.emit(spaceId);
    });
  }

  async askFix(spaceId: string, hunkId: string): Promise<void> {
    const s = this.sp(spaceId);
    const h = this.find(s, hunkId);
    const entry = s.notes.get(hunkId);
    if (!entry || entry.note.resolved || entry.note.busy) return;
    const { note, fix } = entry;
    note.busy = true;
    const author = s.agents.find((a) => a.id === h.agent);
    const role = author?.role;
    const fixer = s.agents.find((a) => a.role === role);
    if (fixer) {
      fixer.status = "working";
      fixer.summary = `Fixing: ${note.text.split(".")[0]}`;
    }
    this.emit(spaceId);
    this.later(1400, () => {
      if (h.state === "staged") {
        const nh: MHunk = {
          ...h,
          id: `${h.id}f`,
          del: h.add.slice(),
          add: fix,
          why: "Fix from review: return 400 on a bad signature.",
          state: "pending",
        };
        s.hunks.splice(s.hunks.indexOf(h) + 1, 0, nh);
      } else {
        h.add = fix;
        h.why = "Updated after review: catch the bad signature and return 400.";
      }
      note.resolved = true;
      note.busy = false;
      s.tests.pass = s.tests.total;
      if (fixer) {
        fixer.status = "done";
        fixer.summary = `Fix ready, tests ${s.tests.total} of ${s.tests.total}`;
      }
      for (const a of s.agents) {
        if (a.role === "tester") {
          a.status = "done";
          a.summary = `${s.tests.total} of ${s.tests.total} tests pass`;
        }
        if (a.role === "reviewer") a.summary = "No blocking notes";
      }
      this.emit(spaceId, "state", `${toolLabel(author?.tool ?? "agent")} updated the proposal`);
    });
  }

  // -- commit gate ----------------------------------------------------------

  async draftCommit(spaceId: string): Promise<string> {
    return this.sp(spaceId).commitMsg;
  }

  async runGate(spaceId: string, onCheck?: (index: number, check: GateCheck) => void): Promise<GateCheck[]> {
    // The checks of the Review view are shown by the UI itself; this is the rest of the gate.
    const checks = this.gateChecks(this.sp(spaceId), false);
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        onCheck?.(i, checks[i]);
        i++;
        if (i < checks.length) this.later(220, step);
        else resolve(checks);
      };
      this.later(260, step);
    });
  }

  async commit(spaceId: string, message: string, overrideReason?: string): Promise<CommitResult> {
    const s = this.sp(spaceId);
    const files = this.stagedFiles(s);
    if (!files.length) throw new Error("Nothing is staged");
    const passes = this.gateChecks(s).every((c) => c.pass);
    const reason = (overrideReason ?? "").trim();
    if (!passes && reason.length <= 3) {
      throw new Error("Blocked by the commit gate: fix the notes or give a reason to override");
    }
    const repos = uniq(files.map((f) => f.repo));
    s.commitMsg = message;
    s.hunks = s.hunks.filter((h) => h.state === "pending");
    s.baseStaged = [];
    s.fileStage.clear();
    for (const f of s.files) f.mine = new Set();
    this.commits.push({ spaceId, message, repos, override: passes ? undefined : reason });
    this.emit(spaceId);
    return { repos, branch: s.space.branch };
  }

  // -- commit composer ------------------------------------------------------

  /** Staged hunks: accepted proposals, plus a stand in hunk for each file that was staged before. */
  private stagedHunks(s: MSpace): Hunk[] {
    const accepted = s.hunks.filter((h) => h.state === "staged").map((h) => this.toHunk(s, h));
    const early = s.baseStaged
      .filter((f) => !accepted.some((h) => h.repo === f.repo && h.path === f.path))
      .map((f): Hunk => {
        const lines = (s.files.find((x) => x.repo === f.repo && x.path === f.path)?.lines ?? []).slice(0, 1);
        return {
          id: `base:${f.repo}/${f.path}`,
          repo: f.repo,
          path: f.path,
          oldStart: 1,
          oldLines: lines.length,
          newStart: 1,
          newLines: lines.length,
          section: "",
          lines: lines.map((text, i) => ({ kind: "add" as const, text, old: null, new: i + 1 })),
          origin: { type: "you" },
          state: "staged",
        };
      });
    return [...accepted, ...early];
  }

  async commitPlan(spaceId: string): Promise<CommitPlan> {
    const s = this.sp(spaceId);
    const keys = s.links.filter((l) => l.kind === "issue" && l.key).map((l) => l.key as string);
    return planFromHunks(this.stagedHunks(s), { repos: s.space.repos.map((r) => r.name), keys });
  }

  async validateMessage(message: string, rules: CommitRules, conventional: boolean): Promise<Problem[]> {
    return validateFor(message, rules, conventional);
  }

  async commitGroups(
    spaceId: string,
    groups: CommitGroup[],
    conventional: boolean,
    overrideReason?: string,
  ): Promise<CommitResult> {
    const s = this.sp(spaceId);
    if (!groups.length) throw new Error("Nothing to commit");
    const staged = this.stagedHunks(s);
    const known = new Set(staged.map((h) => h.id));
    for (const g of groups) {
      if (!g.subject.trim()) throw new Error(`Commit ${g.id} has no subject`);
      if (!g.hunks.length) throw new Error(`Commit ${g.id} has no hunks`);
      for (const id of g.hunks) if (!known.has(id)) throw new Error(`Hunk not found: ${id}`);
    }
    const passes = this.gateChecks(s).every((c) => c.pass);
    const reason = (overrideReason ?? "").trim();
    if (!passes && reason.length <= 3) {
      throw new Error("Blocked by the commit gate: fix the notes or give a reason to override");
    }
    const taken = new Set(groups.flatMap((g) => g.hunks));
    s.hunks = s.hunks.filter((h) => !(h.state !== "pending" && taken.has(h.id)));
    s.fileStage.clear();
    s.baseStaged = s.baseStaged.filter((f) => !taken.has(`base:${f.repo}/${f.path}`));
    const commits: GroupCommit[] = [];
    for (const g of groups) {
      const footers = reason && !passes ? [...(g.footers ?? []), `Vela-Override: ${reason}`] : g.footers;
      this.commits.push({
        spaceId,
        message: composeMessage({ ...g, footers }, conventional),
        repos: [g.repo],
        override: passes ? undefined : reason,
        group: g.id,
      });
      commits.push({ group: g.id, repo: g.repo, sha: (this.commits.length * 4099).toString(16).padStart(7, "0") });
    }
    this.emit(spaceId);
    return { repos: uniq(groups.map((g) => g.repo)), branch: s.space.branch, commits };
  }

  // -- links ----------------------------------------------------------------

  async links(spaceId: string): Promise<Link[]> {
    return structuredClone(this.sp(spaceId).links);
  }

  async addLink(spaceId: string, url: string, title?: string, source: LinkSource = "manual"): Promise<Link> {
    const s = this.sp(spaceId);
    if (!isHttpUrl(url)) throw new Error(`Not an http(s) URL: ${url.trim()}`);
    const link = makeLink(url, title, source === "paste" ? "paste" : "manual");
    const dup = s.links.find((l) => sameLink(l, link));
    if (dup) return structuredClone(dup);
    s.links.push(link);
    this.emit(spaceId);
    return structuredClone(link);
  }

  async removeLink(spaceId: string, linkId: string): Promise<void> {
    const s = this.sp(spaceId);
    const l = s.links.find((x) => x.id === linkId);
    if (!l) throw new Error(`Link not found: ${linkId}`);
    if (!removable(l)) throw new Error("Only links you added can be removed");
    s.links = s.links.filter((x) => x.id !== linkId);
    this.emit(spaceId);
  }

  async openUrl(url: string): Promise<void> {
    if (!isHttpUrl(url)) throw new Error(`Only http and https links can be opened: ${url.trim()}`);
    this.opened.push(url.trim());
  }

  // -- files: stage and unstage whole files -----------------------------------

  async stageFile(spaceId: string, repo: string, path: string): Promise<void> {
    const s = this.sp(spaceId);
    const bk = `${spaceId}:${fileKey(repo, path)}`;
    const fs = s.fileStage.get(fileKey(repo, path));
    if (fs?.unstaged) {
      // Created, deleted or moved from the tree: the whole file goes to the index.
      s.fileStage.set(fileKey(repo, path), { staged: fs.unstaged === "untracked" ? "added" : fs.unstaged, unstaged: null });
      this.emit(spaceId);
      return;
    }
    if (this.unstagedBase.delete(bk)) {
      // Staged before the session and unstaged since: stage it back.
      if (!s.baseStaged.some((x) => x.repo === repo && x.path === path)) s.baseStaged.push({ repo, path });
      this.emit(spaceId);
      return;
    }
    const f = this.file(s, repo, path);
    if (f.mine.size) {
      this.parked.set(`${spaceId}:${fileKey(repo, path)}`, new Set(f.mine));
      f.mine = new Set();
      if (!s.baseStaged.some((x) => x.repo === repo && x.path === path)) s.baseStaged.push({ repo, path });
    }
    this.emit(spaceId);
  }

  async unstageFile(spaceId: string, repo: string, path: string): Promise<void> {
    const s = this.sp(spaceId);
    const fs = s.fileStage.get(fileKey(repo, path));
    if (fs?.staged && !fs.unstaged) {
      s.fileStage.set(fileKey(repo, path), { staged: null, unstaged: fs.staged === "added" ? "untracked" : fs.staged });
      this.emit(spaceId);
      return;
    }
    const f = this.file(s, repo, path);
    for (const h of s.hunks) {
      if (h.repo === repo && h.path === path && h.state === "staged") {
        this.unapply(s, h);
        h.state = "pending";
      }
    }
    const i = s.baseStaged.findIndex((x) => x.repo === repo && x.path === path);
    if (i >= 0) s.baseStaged.splice(i, 1);
    const key = `${spaceId}:${fileKey(repo, path)}`;
    const parked = this.parked.get(key);
    if (parked) {
      f.mine = parked;
      this.parked.delete(key);
    } else if (i >= 0) {
      this.unstagedBase.add(key);
    }
    this.emit(spaceId);
  }


  // -- right-click menu operations -------------------------------------------

  private exists(s: MSpace, repo: string, path: string): boolean {
    const k = fileKey(repo, path);
    if (s.removed.has(k)) return false;
    return s.files.some((f) => f.repo === repo && f.path === path) || repoPaths(repo).includes(path);
  }

  private isDir(s: MSpace, repo: string, path: string): boolean {
    const prefix = `${path}/`;
    return (
      repoPaths(repo).some((p) => p.startsWith(prefix) && !s.removed.has(fileKey(repo, p))) ||
      s.files.some((f) => f.repo === repo && f.path.startsWith(prefix) && !s.removed.has(fileKey(repo, f.path)))
    );
  }

  /** Same guard as the real `resolve_path`: relative, no `..`, nothing under `.git`. */
  private guard(s: MSpace, repo: string, path: string, allowRoot = false): string {
    if (!s.space.repos.some((r) => r.name === repo)) throw new Error(`repo not found in space: ${repo}`);
    if (path === "" && allowRoot) return path;
    const parts = path.split("/");
    if (!path || path.startsWith("/") || parts.some((p) => p === ".." || p === "") || parts[0] === ".git") {
      throw new BackendError("forbidden_path", `path is outside the space worktree: ${path}`);
    }
    return path;
  }

  private filesUnder(s: MSpace, repo: string, path: string): string[] {
    const prefix = `${path}/`;
    const all = new Set<string>();
    for (const p of repoPaths(repo)) if (!s.removed.has(fileKey(repo, p))) all.add(p);
    for (const f of s.files) if (f.repo === repo && !s.removed.has(fileKey(repo, f.path))) all.add(f.path);
    return [...all].filter((p) => p === path || p.startsWith(prefix));
  }

  async createFile(spaceId: string, repo: string, path: string): Promise<void> {
    const s = this.sp(spaceId);
    this.guard(s, repo, path);
    if (this.exists(s, repo, path) || this.isDir(s, repo, path)) throw new BackendError("invalid_input", `${path} already exists`);
    s.removed.delete(fileKey(repo, path));
    s.files.push({ repo, path, firstLine: 1, lines: [""], mine: new Set() });
    s.fileStage.set(fileKey(repo, path), { staged: null, unstaged: "untracked" });
    this.emit(spaceId);
  }

  /** Folders created by hand (`space:repo/path`). They show in the tree once they hold a file. */
  readonly dirs: string[] = [];

  async createDir(spaceId: string, repo: string, path: string): Promise<void> {
    const s = this.sp(spaceId);
    this.guard(s, repo, path);
    if (this.exists(s, repo, path) || this.isDir(s, repo, path)) throw new BackendError("invalid_input", `${path} already exists`);
    this.dirs.push(`${spaceId}:${fileKey(repo, path)}`);
    this.emit(spaceId);
  }

  async renamePath(spaceId: string, repo: string, from: string, to: string): Promise<void> {
    const s = this.sp(spaceId);
    this.guard(s, repo, from);
    this.guard(s, repo, to);
    const isDir = this.isDir(s, repo, from);
    if (!isDir && !this.exists(s, repo, from)) throw new BackendError("invalid_input", `${from} does not exist`);
    if (this.exists(s, repo, to) || this.isDir(s, repo, to)) throw new BackendError("invalid_input", `${to} already exists`);
    if (to.startsWith(`${from}/`)) throw new BackendError("invalid_input", "cannot move a folder into itself");
    for (const old of this.filesUnder(s, repo, from)) {
      const next = to + old.slice(from.length);
      const src = this.file(s, repo, old);
      s.files.push({ repo, path: next, firstLine: src.firstLine, lines: src.lines.slice(), mine: new Set() });
      this.dropFile(s, repo, old);
      s.removed.delete(fileKey(repo, next));
      s.fileStage.set(fileKey(repo, next), { staged: null, unstaged: "untracked" });
    }
    this.emit(spaceId);
  }

  /** Remove a file from the tree: untracked ones vanish, tracked ones show as deleted. */
  private dropFile(s: MSpace, repo: string, path: string) {
    const k = fileKey(repo, path);
    const st = s.fileStage.get(k);
    const created = st?.unstaged === "untracked" || st?.staged === "added";
    s.files = s.files.filter((f) => !(f.repo === repo && f.path === path));
    s.hunks = s.hunks.filter((h) => !(h.repo === repo && h.path === path && h.state === "pending"));
    s.baseStaged = s.baseStaged.filter((f) => !(f.repo === repo && f.path === path));
    s.removed.add(k);
    if (created) s.fileStage.delete(k);
    else s.fileStage.set(k, { staged: null, unstaged: "deleted" });
  }

  async deletePath(spaceId: string, repo: string, path: string, permanent = false): Promise<"trashed" | "deleted"> {
    const s = this.sp(spaceId);
    this.guard(s, repo, path);
    const under = this.filesUnder(s, repo, path);
    if (!under.length) throw new BackendError("invalid_input", `${path} does not exist`);
    if (!permanent && !this.hasTrash) throw new BackendError("no_trash", "no system trash: this machine has none");
    for (const p of under) this.dropFile(s, repo, p);
    if (!permanent) this.trashed.push(fileKey(repo, path));
    this.emit(spaceId);
    return permanent ? "deleted" : "trashed";
  }

  async discardFile(spaceId: string, repo: string, path: string): Promise<void> {
    const s = this.sp(spaceId);
    this.guard(s, repo, path);
    const k = fileKey(repo, path);
    const st = (await this.status(spaceId)).find((c) => c.repo === repo && c.path === path);
    if (!st?.unstaged) throw new BackendError("invalid_input", `${path} has no unstaged changes`);
    if (st.unstaged === "untracked") {
      this.dropFile(s, repo, path);
      if (this.hasTrash) this.trashed.push(k);
    } else if (st.unstaged === "deleted") {
      s.removed.delete(k);
      s.fileStage.delete(k);
    } else {
      const f = this.file(s, repo, path);
      if (f.orig) f.lines = f.orig;
      f.orig = undefined;
      f.mine = new Set();
      this.parked.delete(`${spaceId}:${k}`);
    }
    this.emit(spaceId);
  }

  async revealPath(spaceId: string, repo: string, path: string): Promise<void> {
    this.guard(this.sp(spaceId), repo, path, true);
    this.revealed.push(path ? fileKey(repo, path) : repo);
  }

  async absolutePath(spaceId: string, repo: string, path: string): Promise<string> {
    const s = this.sp(spaceId);
    this.guard(s, repo, path, true);
    const r = s.space.repos.find((x) => x.name === repo)!;
    return path ? `/home/you/.local/share/vela/${r.worktree}/${path}` : `/home/you/.local/share/vela/${r.worktree}`;
  }

  async openTerminal(spaceId: string, repo: string, path: string): Promise<string> {
    const s = this.sp(spaceId);
    this.guard(s, repo, path, true);
    const dir = !path || this.isDir(s, repo, path) ? path : path.split("/").slice(0, -1).join("/");
    this.terminals.push(dir ? fileKey(repo, dir) : repo);
    return "xterm";
  }

  async renameSpace(spaceId: string, name: string): Promise<Space> {
    const s = this.sp(spaceId);
    const n = name.trim();
    if (!n) throw new BackendError("invalid_input", `invalid space name: ${n}`);
    s.space.name = n;
    this.emit(spaceId);
    return structuredClone(s.space);
  }

  async setSpaceColor(spaceId: string, color: string): Promise<Space> {
    const s = this.sp(spaceId);
    if (!/^#[0-9a-fA-F]{6}$/.test(color.trim())) throw new BackendError("invalid_input", `not a #RRGGBB color: ${color}`);
    s.space.color = color.trim().toUpperCase();
    this.emit(spaceId);
    return structuredClone(s.space);
  }

  async archiveSpace(spaceId: string): Promise<Space> {
    const s = this.sp(spaceId);
    s.space.archived = true;
    this.emit(spaceId);
    return structuredClone(s.space);
  }

  async unarchiveSpace(spaceId: string): Promise<Space> {
    const s = this.sp(spaceId);
    s.space.archived = false;
    this.emit(spaceId);
    return structuredClone(s.space);
  }

  async listArchived(): Promise<Space[]> {
    return structuredClone([...this.spaces.values()].map((s) => s.space).filter((x) => x.archived));
  }

  async removeSpace(spaceId: string): Promise<void> {
    this.sp(spaceId);
    this.spaces.delete(spaceId);
    this.emit(spaceId);
  }

  // -- checks ---------------------------------------------------------------

  private parked = new Map<string, Set<number>>();
  /** Files staged before the session that you unstaged, so Space can stage them back. */
  private unstagedBase = new Set<string>();
  private checkStates = new Map<string, MCheckState>();
  private checkListeners = new Set<(e: CheckEvent) => void>();

  private ck(spaceId: string): MCheckState {
    let st = this.checkStates.get(spaceId);
    if (!st) {
      const s = this.sp(spaceId);
      const repo = s.space.repos[0].name;
      const defs: MCheckDef[] = [
        {
          repo,
          id: "pre-commit",
          name: "pre-commit",
          kind: "hook",
          command: "pre-commit run --files {files}",
          optional: false,
          source: ".pre-commit-config.yaml",
          ms: 600,
          fails: false,
          log: [
            "trim trailing whitespace.................................................Passed",
            "fix end of files.........................................................Passed",
            "check yaml...............................................................Passed",
            "check for added large files..............................................Passed",
          ],
        },
        {
          repo,
          id: "test",
          name: "Tests (pnpm)",
          kind: "test",
          command: "pnpm test",
          optional: true,
          source: "package.json",
          ms: 1800,
          fails: false,
          log: [
            " RUN  v5.0.5",
            " ✓ src/webhook.test.ts (6 tests) 41ms",
            " ✓ src/refunds.test.ts (4 tests) 22ms",
            "",
            " Test Files  2 passed (2)",
            "      Tests  10 passed (10)",
          ],
        },
      ];
      if (spaceId === "stripe") {
        defs.splice(1, 0, {
          repo,
          id: "lint",
          name: "Lint",
          kind: "lint",
          command: "pnpm run lint",
          optional: false,
          source: "package.json",
          ms: 900,
          fails: true,
          log: [
            "> api@1.0.0 lint /home/me/wt/stripe-v2",
            "> eslint src --max-warnings 0",
            "",
            "src/billing/webhook.ts",
            "  14:9  error  'sig' is assigned a value but never used  @typescript-eslint/no-unused-vars",
            "  22:3  error  Unexpected console statement              no-console",
            "",
            "✖ 2 problems (2 errors, 0 warnings)",
            "ELIFECYCLE Command failed with exit code 1.",
          ],
        });
      }
      st = { defs, enabled: new Map(), auto: new Map(), running: new Set(), cache: new Map(), logs: new Map(), autoSeq: 0 };
      this.checkStates.set(spaceId, st);
    }
    return st;
  }

  /** Identity of the staged set, the way the tree of the index is in the real core. */
  private stagedTree(s: MSpace): string {
    const files = this.stagedFiles(s).map((f) => fileKey(f.repo, f.path));
    const hunks = s.hunks.filter((h) => h.state === "staged").map((h) => h.id);
    return [...files.sort(), "|", ...hunks.sort()].join(",");
  }

  private isEnabled(st: MCheckState, d: MCheckDef): boolean {
    return st.enabled.get(`${d.repo}/${d.id}`) ?? !d.optional;
  }

  private ckKey(d: MCheckDef): string {
    return `${d.repo}/${d.id}`;
  }

  private emitCheck(e: CheckEvent) {
    for (const l of [...this.checkListeners]) l(e);
  }

  async checks(spaceId: string): Promise<RepoChecks[]> {
    const s = this.sp(spaceId);
    const st = this.ck(spaceId);
    const tree = this.stagedTree(s);
    return s.space.repos.map((r) => ({
      repo: r.name,
      auto: st.auto.get(r.name) ?? true,
      checks: st.defs
        .filter((d) => d.repo === r.name)
        .map((d): CheckEntry => {
          const hit = st.cache.get(`${this.ckKey(d)}@${tree}`);
          const enabled = this.isEnabled(st, d);
          const status: CheckStatus = !enabled
            ? "disabled"
            : st.running.has(this.ckKey(d))
              ? "running"
              : hit
                ? hit.status
                : "idle";
          return {
            repo: d.repo,
            id: d.id,
            name: d.name,
            kind: d.kind,
            command: d.command,
            optional: d.optional,
            enabled,
            missing: false,
            source: d.source,
            when: "staged",
            status,
            durationMs: hit?.durationMs ?? null,
            cached: !!hit,
            exitCode: hit ? (hit.status === "pass" ? 0 : 1) : null,
            timedOut: false,
          };
        }),
      warnings: [],
    }));
  }

  async runChecks(spaceId: string, ids?: string[], force = false): Promise<void> {
    const st = this.ck(spaceId);
    for (const d of st.defs) {
      const wanted = ids ? ids.includes(d.id) : this.isEnabled(st, d);
      if (wanted) this.runCheck(spaceId, d, force);
    }
  }

  private runCheck(spaceId: string, d: MCheckDef, force: boolean) {
    const s = this.sp(spaceId);
    const st = this.ck(spaceId);
    const k = this.ckKey(d);
    if (st.running.has(k)) return;
    const cacheKey = `${k}@${this.stagedTree(s)}`;
    const hit = force ? undefined : st.cache.get(cacheKey);
    const base = { spaceId, repo: d.repo, id: d.id };
    st.running.add(k);
    this.emitCheck({ ...base, status: "running" });
    const lines = [`$ ${d.command}`, ...d.log];
    for (const line of lines) this.emitCheck({ ...base, status: "running", line });
    st.logs.set(k, lines.join("\n") + "\n");
    this.later(hit ? 0 : d.ms, () => {
      st.running.delete(k);
      const status: CheckStatus = d.fails ? "fail" : "pass";
      if (!hit) st.cache.set(cacheKey, { status, durationMs: d.ms });
      this.emitCheck({
        ...base,
        status,
        durationMs: hit?.durationMs ?? d.ms,
        cached: !!hit,
        exitCode: d.fails ? 1 : 0,
        timedOut: false,
      });
    });
  }

  async checkLog(spaceId: string, repo: string, id: string): Promise<string> {
    return this.ck(spaceId).logs.get(`${repo}/${id}`) ?? "";
  }

  async setCheckEnabled(spaceId: string, repo: string, id: string, enabled: boolean): Promise<void> {
    this.ck(spaceId).enabled.set(`${repo}/${id}`, enabled);
    this.emit(spaceId);
  }

  async setChecksAuto(spaceId: string, repo: string, auto: boolean): Promise<void> {
    this.ck(spaceId).auto.set(repo, auto);
    this.emit(spaceId);
  }

  onCheck(listener: (e: CheckEvent) => void): Unsubscribe {
    this.checkListeners.add(listener);
    return () => this.checkListeners.delete(listener);
  }

  /** Rerun the enabled checks 500 ms after the staged set changed (checks.auto). */
  private scheduleAuto(spaceId: string) {
    const st = this.checkStates.get(spaceId);
    if (!st) return;
    const seq = ++st.autoSeq;
    this.later(500, () => {
      if (seq !== st.autoSeq) return;
      const s = this.sp(spaceId);
      if (!this.stagedFiles(s).length) return;
      for (const d of st.defs) {
        if (!(st.auto.get(d.repo) ?? true) || !this.isEnabled(st, d)) continue;
        if (st.cache.has(`${this.ckKey(d)}@${this.stagedTree(s)}`)) continue;
        this.runCheck(spaceId, d, false);
      }
    });
  }

  onChange(listener: (e: BackendEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// ---------------------------------------------------------------------------
// Tauri backend: thin calls to the commands of app/src/tauri_cmds.rs
// ---------------------------------------------------------------------------

/** Error from the Rust side: `{ kind, message }` on the wire, an Error here. */
export class BackendError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

export function toBackendError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (e && typeof e === "object" && "message" in e) {
    const { kind, message } = e as { kind?: unknown; message: unknown };
    return new BackendError(typeof kind === "string" ? kind : "unknown", String(message));
  }
  return new BackendError("unknown", String(e));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toBackendError(e);
  }
}

/** Event the file watcher of the app emits; the payload is a BackendEvent. */
export const CHANGED_EVENT = "vela://changed";
/** Event the check runner of the app emits; the payload is a CheckEvent. */
export const CHECK_EVENT = "vela://check";

/**
 * Talks to the Rust core. Agents, notes, questions, stack and gate come back empty until
 * their milestones (the Rust commands are marked TODO(M2/M3/M4)); nothing is faked here.
 */
export class TauriBackend implements Backend {
  listRepos() {
    return call<string[]>("list_repos");
  }
  declareRepo(path: string) {
    return call<string[]>("declare_repo", { path });
  }
  addRepoToSpace(spaceId: string, path: string) {
    return call<Space>("add_repo_to_space", { spaceId, path });
  }
  removeRepoFromSpace(spaceId: string, repo: string) {
    return call<Space>("remove_repo_from_space", { spaceId, repo });
  }
  createRepo(parent: string, name: string) {
    return call<string>("create_repo", { parent, name });
  }
  defaultRepoParent() {
    return call<string>("default_repo_parent");
  }
  listSpaces() {
    return call<Space[]>("list_spaces");
  }
  createSpace(name: string, repos: string[]) {
    return call<Space>("create_space", { name, repos });
  }
  /** A window number opens the space in its own window (the app picks the number); null closes it. */
  async setWindow(spaceId: string, window: number | null) {
    if (window === null) await call<void>("set_window", { spaceId, window: null });
    else await call<void>("open_space_window", { spaceId });
  }
  status(spaceId: string) {
    return call<FileChange[]>("status", { spaceId });
  }
  hunks(spaceId: string) {
    return call<Hunk[]>("hunks", { spaceId });
  }
  /** TODO(M2): the core has no reasons yet. */
  reasons(spaceId: string) {
    return call<Record<string, string>>("reasons", { spaceId });
  }
  stageHunk(spaceId: string, hunkId: string) {
    return call<Hunk>("stage_hunk", { spaceId, hunkId });
  }
  unstageHunk(spaceId: string, hunkId: string) {
    return call<Hunk>("unstage_hunk", { spaceId, hunkId });
  }
  rejectHunk(spaceId: string, hunkId: string) {
    return call<Hunk>("reject_hunk", { spaceId, hunkId });
  }
  editHunk(spaceId: string, hunkId: string) {
    return call<Hunk>("edit_hunk", { spaceId, hunkId });
  }
  listFiles(spaceId: string) {
    return call<FileRef[]>("list_files", { spaceId });
  }
  spaceFiles(spaceId: string) {
    return call<RepoFiles[]>("space_files", { spaceId });
  }
  stageFile(spaceId: string, repo: string, path: string) {
    return call<void>("stage_file", { spaceId, repo, path });
  }
  unstageFile(spaceId: string, repo: string, path: string) {
    return call<void>("unstage_file", { spaceId, repo, path });
  }
  async readFile(spaceId: string, repo: string, path: string): Promise<FileContent> {
    const content = await call<string>("read_file", { spaceId, repo, path });
    return { repo, path, content, firstLine: 1, language: languageOf(path) };
  }
  writeFile(spaceId: string, repo: string, path: string, content: string) {
    return call<void>("write_file", { spaceId, repo, path, content });
  }
  agents(spaceId: string) {
    return call<Agent[]>("agents", { spaceId });
  }
  askAgent(spaceId: string, role: AgentRole, prompt: string) {
    return call<Agent>("ask_agent", { spaceId, role, prompt });
  }
  question(spaceId: string) {
    return call<AgentQuestion | null>("question", { spaceId });
  }
  answerAgent(spaceId: string, yes: boolean) {
    return call<void>("answer_agent", { spaceId, yes });
  }
  notes(spaceId: string) {
    return call<ReviewNote[]>("notes", { spaceId });
  }
  askFix(spaceId: string, hunkId: string) {
    return call<void>("ask_fix", { spaceId, hunkId });
  }
  stack(spaceId: string) {
    return call<StackItem[]>("stack", { spaceId });
  }
  draftCommit(spaceId: string) {
    return call<string>("draft_commit", { spaceId });
  }
  async runGate(spaceId: string, onCheck?: (index: number, check: GateCheck) => void) {
    const checks = await call<GateCheck[]>("run_gate", { spaceId });
    checks.forEach((c, i) => onCheck?.(i, c));
    return checks;
  }
  async commit(spaceId: string, message: string, overrideReason?: string): Promise<CommitResult> {
    const r = await call<CommitResult>("commit", { spaceId, message, overrideReason: overrideReason ?? null });
    return { ...r, pushed: false };
  }
  commitPlan(spaceId: string) {
    return call<CommitPlan>("commit_plan", { spaceId });
  }
  validateMessage(message: string, rules: CommitRules, conventional: boolean) {
    return call<Problem[]>("validate_message", { message, rules, conventional });
  }
  async commitGroups(
    spaceId: string,
    groups: CommitGroup[],
    conventional: boolean,
    overrideReason?: string,
  ): Promise<CommitResult> {
    const r = await call<CommitResult>("commit_groups", {
      spaceId,
      groups,
      conventional,
      overrideReason: overrideReason ?? null,
    });
    return { ...r, pushed: false };
  }
  links(spaceId: string) {
    return call<Link[]>("links", { spaceId });
  }
  addLink(spaceId: string, url: string, title?: string, source?: LinkSource) {
    return call<Link>("add_link", { spaceId, url, title: title ?? null, source: source ?? null });
  }
  removeLink(spaceId: string, linkId: string) {
    return call<void>("remove_link", { spaceId, linkId });
  }
  openUrl(url: string) {
    return call<void>("open_url", { url });
  }
  checks(spaceId: string) {
    return call<RepoChecks[]>("checks", { spaceId });
  }
  async runChecks(spaceId: string, ids?: string[], force?: boolean) {
    await call<[string, string][]>("run_checks", { spaceId, ids: ids ?? null, force: force ?? false });
  }
  checkLog(spaceId: string, repo: string, id: string) {
    return call<string>("check_log", { spaceId, repo, id });
  }
  setCheckEnabled(spaceId: string, repo: string, id: string, enabled: boolean) {
    return call<void>("set_check_enabled", { spaceId, repo, id, enabled });
  }
  setChecksAuto(spaceId: string, repo: string, auto: boolean) {
    return call<void>("set_checks_auto", { spaceId, repo, auto });
  }
  createFile(spaceId: string, repo: string, path: string) {
    return call<void>("create_file", { spaceId, repo, path });
  }
  createDir(spaceId: string, repo: string, path: string) {
    return call<void>("create_dir", { spaceId, repo, path });
  }
  renamePath(spaceId: string, repo: string, from: string, to: string) {
    return call<void>("rename_path", { spaceId, repo, from, to });
  }
  deletePath(spaceId: string, repo: string, path: string, permanent = false) {
    return call<"trashed" | "deleted">("delete_path", { spaceId, repo, path, permanent });
  }
  discardFile(spaceId: string, repo: string, path: string) {
    return call<void>("discard_file", { spaceId, repo, path });
  }
  revealPath(spaceId: string, repo: string, path: string) {
    return call<void>("reveal_path", { spaceId, repo, path });
  }
  absolutePath(spaceId: string, repo: string, path: string) {
    return call<string>("absolute_path", { spaceId, repo, path });
  }
  openTerminal(spaceId: string, repo: string, path: string) {
    return call<string>("open_terminal", { spaceId, repo, path });
  }
  renameSpace(spaceId: string, name: string) {
    return call<Space>("rename_space", { spaceId, name });
  }
  setSpaceColor(spaceId: string, color: string) {
    return call<Space>("set_space_color", { spaceId, color });
  }
  archiveSpace(spaceId: string) {
    return call<Space>("archive_space", { spaceId });
  }
  unarchiveSpace(spaceId: string) {
    return call<Space>("unarchive_space", { spaceId });
  }
  listArchived() {
    return call<Space[]>("list_archived");
  }
  removeSpace(spaceId: string) {
    return call<void>("remove_space", { spaceId });
  }
  onCheck(listener: (e: CheckEvent) => void): Unsubscribe {
    return this.subscribe(CHECK_EVENT, listener);
  }
  onChange(listener: (e: BackendEvent) => void): Unsubscribe {
    return this.subscribe(CHANGED_EVENT, listener);
  }
  private subscribe<T>(name: string, listener: (e: T) => void): Unsubscribe {
    let off: (() => void) | null = null;
    let cancelled = false;
    void listen<T>(name, (ev) => listener(ev.payload)).then((u) => {
      if (cancelled) u();
      else off = u;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }
}

/** Tauri inside the desktop app, the in-memory mock in a plain browser. */
export function createBackend(): Backend {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return new TauriBackend();
  return new MockBackend();
}

/** The space a window is pinned to, from a `#space-<id>` hash. */
export function pinnedSpace(hash: string): string | null {
  const m = /^#space-(.+)$/.exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}
