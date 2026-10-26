// Mirrors crates/vela-core/src/model.rs. Keep the two files in sync: same names,
// camelCase fields, Rust enums as string unions, tagged enums with a `type` field,
// `Option<T>` as `T | null` (fields with `#[serde(default)]` are optional).

/** A space is one task: several repos, one worktree per repo, its agents and its stack. */
export interface Space {
  /** Slug, unique, used in paths and branch names. */
  id: string;
  name: string;
  /** Hex color, e.g. "#E8A14A". Drives the accent of the whole window. */
  color: string;
  /** Branch shared by every repo of the space, e.g. "feat/refunds". */
  branch: string;
  repos: SpaceRepo[];
  /** RFC 3339 timestamp. */
  createdAt: string;
  /** Window the space is shown in, null/absent when it lives in the main window. */
  window?: number | null;
  archived?: boolean;
  /** Links added by hand or pasted. Detected and repo links come from `Backend.links`. */
  links?: Link[];
}

export interface SpaceRepo {
  /** Short display name, defaults to the source directory name. */
  name: string;
  /** The user's original clone. */
  source: string;
  /** The worktree Vela created for this space. */
  worktree: string;
  /** Ref the branch was created from, e.g. "main". */
  base: string;
}

/** Status letter of one side (index or worktree) of a file change. */
export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

/** One file in `git status`, split the way VS Code shows it. */
export interface FileChange {
  repo: string;
  path: string;
  /** Original path for renames. */
  from?: string | null;
  /** Change recorded in the index (staged). */
  staged: ChangeKind | null;
  /** Change in the worktree not yet staged. */
  unstaged: ChangeKind | null;
}

export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  text: string;
  /** Line number in the old file, null for added lines. */
  old: number | null;
  /** Line number in the new file, null for deleted lines. */
  new: number | null;
}

/** Who produced a hunk. */
export type Origin =
  /** Edited by the user in the space worktree. */
  | { type: "you" }
  /** Proposed by an agent from its own worktree. */
  | { type: "agent"; agent: string };

export type HunkState = "pending" | "staged" | "rejected";

export interface Hunk {
  /** Stable id: hash of repo, path and the hunk's content lines (not its position). */
  id: string;
  repo: string;
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second "@@", often the enclosing function. */
  section: string;
  lines: DiffLine[];
  origin: Origin;
  state: HunkState;
}

export type AgentRole = "planner" | "developer" | "reviewer" | "tester" | "debugger";

export type AgentStatus = "working" | "waiting" | "done" | "failed";

/** A coding agent CLI running for a space, in its own worktree. */
export interface Agent {
  id: string;
  space: string;
  role: AgentRole;
  /** "claude", "codex", "opencode", "crush", or any configured command. */
  tool: string;
  /** Repo name → agent worktree path. Reviewers get none (read only). */
  worktrees: [string, string][];
  status: AgentStatus;
  summary: string;
}

/** One tool or service of the space stack. */
export interface StackItem {
  name: string;
  version: string | null;
  /** Where it was found: "mise.toml", ".tool-versions", "compose.yml", ... */
  source: string;
  kind: StackKind;
  state: StackState;
  /** Published ports for containers, e.g. ["5432"]. */
  ports?: string[];
}

export type StackKind = "runtime" | "container";

export type StackState = "ok" | "starting" | "stopped" | "missing" | "unknown";

/** What the "Up next" island shows. Computed by the core so every client agrees. */
export type UpNext =
  | { type: "agentQuestion"; agent: string; text: string }
  | { type: "review"; count: number }
  | { type: "commit"; repos: number; files: number }
  | { type: "nothing" };

// ---------------------------------------------------------------------------
// Links: the context of a space
// ---------------------------------------------------------------------------

export type LinkKind =
  | "issue"
  | "pullRequest"
  | "doc"
  | "design"
  | "error"
  | "dashboard"
  | "chat"
  | "environment"
  | "other";

export type Provider =
  | "jira"
  | "linear"
  | "github"
  | "gitlab"
  | "sentry"
  | "figma"
  | "notion"
  | "confluence"
  | "googleDocs"
  | "grafana"
  | "datadog"
  | "slack"
  | "url";

/** Where a link came from. */
export type LinkSource = "manual" | "branch" | "commit" | "paste" | "repo";

export interface Link {
  /** Stable id: hash of the url, or of the key when there is no url. */
  id: string;
  kind: LinkKind;
  provider: Provider;
  /** Empty for an issue key found without a configured tracker URL. */
  url: string;
  title: string;
  /** Issue key such as "PAY-412" or "acme/api#12". */
  key?: string | null;
  source: LinkSource;
  /** Summary fetched through MCP. TODO(M2). */
  summary?: string | null;
}

// ---------------------------------------------------------------------------
// Commit composer
// ---------------------------------------------------------------------------

export type CommitType =
  | "feat"
  | "fix"
  | "refactor"
  | "perf"
  | "test"
  | "docs"
  | "style"
  | "build"
  | "ci"
  | "chore"
  | "revert";

/** What a repo asks of its commit messages. */
export interface CommitRules {
  /** Allowed types (`type-enum`). */
  types: string[];
  /** Allowed scopes (`scope-enum`); empty means any scope. */
  scopes: string[];
  /** `header-max-length`. */
  headerMax: number;
}

/** One commit proposed by the composer: the hunks it takes and its message. */
export interface CommitGroup {
  id: string;
  repo: string;
  kind: CommitType;
  scope?: string | null;
  breaking?: boolean;
  breakingReason?: string | null;
  subject: string;
  body?: string;
  /** Trailer lines such as `Refs: PAY-412`. */
  footers?: string[];
  /** Ids of the staged hunks this commit takes (`f:...` for a file without hunks, e.g. a pure rename). */
  hunks: string[];
}

export interface CommitPlan {
  /** Whether the repo uses conventional commits (history or commitlint). */
  conventional: boolean;
  rules: CommitRules;
  groups: CommitGroup[];
}

/** A problem found when validating a message. */
export interface Problem {
  /** "header", "type", "scope", "subject" or "body". */
  field: string;
  message: string;
}

/** One commit made by `commitGroups`. */
export interface GroupCommit {
  group: string;
  repo: string;
  sha: string;
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

/** One file of a worktree with its git status, for the file tree. */
export interface TreeFile {
  /** Path relative to the worktree root, `/` separated. */
  path: string;
  /** Change recorded in the index (staged). */
  staged: ChangeKind | null;
  /** Change in the worktree not yet staged. */
  unstaged: ChangeKind | null;
}

/** Every file of one repo of a space. */
export interface RepoFiles {
  repo: string;
  branch: string;
  worktree: string;
  /** Commits ahead of / behind the upstream, null without an upstream. */
  ahead?: number | null;
  behind?: number | null;
  /** Sorted by path. */
  files: TreeFile[];
  /** The listing was cut at 200 000 entries. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Checks: hooks, tests, lint and types run on the staged set
// ---------------------------------------------------------------------------

export type CheckKind = "hook" | "test" | "lint" | "types" | "custom";
export type CheckWhen = "staged" | "manual";
export type CheckStatus = "idle" | "running" | "pass" | "fail" | "skipped" | "missing" | "disabled";

/** One check of one repo, with the status of its last run for the current staged set. */
export interface CheckEntry {
  repo: string;
  id: string;
  name: string;
  kind: CheckKind;
  command: string;
  /** Optional checks (tests) are off until the user turns them on. */
  optional: boolean;
  enabled: boolean;
  missing: boolean;
  source: string;
  when: CheckWhen;
  status: CheckStatus;
  durationMs?: number | null;
  cached?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
}

export interface RepoChecks {
  repo: string;
  auto: boolean;
  checks: CheckEntry[];
  warnings?: string[];
}
