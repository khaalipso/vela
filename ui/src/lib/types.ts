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
