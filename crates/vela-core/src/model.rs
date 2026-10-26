//! The shared contract between the core, the CLI and the UI.
//!
//! Every type here is serialized to JSON for the UI (camelCase). The TypeScript
//! mirror lives in `ui/src/lib/types.ts` and must stay in sync with this file.

use serde::{Deserialize, Serialize};

/// A space is one task: several repos, one worktree per repo, its agents and its stack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    /// Slug, unique, used in paths and branch names.
    pub id: String,
    pub name: String,
    /// Hex color, e.g. "#E8A14A". Drives the accent of the whole window.
    pub color: String,
    /// Branch shared by every repo of the space, e.g. "feat/refunds".
    pub branch: String,
    pub repos: Vec<SpaceRepo>,
    /// RFC 3339 timestamp.
    pub created_at: String,
    /// Window the space is shown in, None when it lives in the main window.
    #[serde(default)]
    pub window: Option<u32>,
    #[serde(default)]
    pub archived: bool,
    /// Links added by hand or pasted. Detected and repo links are computed by
    /// [`crate::links::list_links`], never stored here.
    #[serde(default)]
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRepo {
    /// Short display name, defaults to the source directory name.
    pub name: String,
    /// The user's original clone.
    pub source: String,
    /// The worktree Vela created for this space.
    pub worktree: String,
    /// Ref the branch was created from, e.g. "main".
    pub base: String,
}

/// Status letter of one side (index or worktree) of a file change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

/// One file in `git status`, split the way VS Code shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub repo: String,
    pub path: String,
    /// Original path for renames.
    #[serde(default)]
    pub from: Option<String>,
    /// Change recorded in the index (staged).
    pub staged: Option<ChangeKind>,
    /// Change in the worktree not yet staged.
    pub unstaged: Option<ChangeKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub text: String,
    /// Line number in the old file, None for added lines.
    pub old: Option<u32>,
    /// Line number in the new file, None for deleted lines.
    pub new: Option<u32>,
}

/// Who produced a hunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Origin {
    /// Edited by the user in the space worktree.
    You,
    /// Proposed by an agent from its own worktree.
    Agent { agent: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HunkState {
    Pending,
    Staged,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// Stable id: hash of repo, path and the hunk's content lines (not its position).
    pub id: String,
    pub repo: String,
    pub path: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Text after the second "@@", often the enclosing function.
    pub section: String,
    pub lines: Vec<DiffLine>,
    pub origin: Origin,
    pub state: HunkState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentRole {
    Planner,
    Developer,
    Reviewer,
    Tester,
    Debugger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
    Working,
    Waiting,
    Done,
    Failed,
}

/// A coding agent CLI running for a space, in its own worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub space: String,
    pub role: AgentRole,
    /// "claude", "codex", "opencode", "crush", or any configured command.
    pub tool: String,
    /// Repo name → agent worktree path. Reviewers get none (read only).
    pub worktrees: Vec<(String, String)>,
    pub status: AgentStatus,
    pub summary: String,
}

/// One tool or service of the space stack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackItem {
    pub name: String,
    pub version: Option<String>,
    /// Where it was found: "mise.toml", ".tool-versions", "compose.yml", ...
    pub source: String,
    pub kind: StackKind,
    pub state: StackState,
    /// Published ports for containers, e.g. ["5432"].
    #[serde(default)]
    pub ports: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StackKind {
    Runtime,
    Container,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StackState {
    Ok,
    Starting,
    Stopped,
    Missing,
    Unknown,
}

/// What the "Up next" island shows. Computed by the core so every client agrees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum UpNext {
    AgentQuestion { agent: String, text: String },
    Review { count: u32 },
    Commit { repos: u32, files: u32 },
    Nothing,
}

// ---------------------------------------------------------------------------
// Links: the context of a space
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Issue,
    PullRequest,
    Doc,
    Design,
    Error,
    Dashboard,
    Chat,
    Environment,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Jira,
    Linear,
    Github,
    Gitlab,
    Sentry,
    Figma,
    Notion,
    Confluence,
    GoogleDocs,
    Grafana,
    Datadog,
    Slack,
    Url,
}

/// Where a link came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkSource {
    /// Typed in the links sheet.
    Manual,
    /// Issue key found in the branch name.
    Branch,
    /// Issue key or `#123` found in a commit subject.
    Commit,
    /// A URL pasted in the app.
    Paste,
    /// Listed in `<repo>/.vela/links.toml`.
    Repo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    /// Stable id: hash of the url, or of the key when there is no url.
    pub id: String,
    pub kind: LinkKind,
    pub provider: Provider,
    /// Empty for an issue key found without a configured tracker URL.
    pub url: String,
    pub title: String,
    /// Issue key such as "PAY-412" or "acme/api#12".
    #[serde(default)]
    pub key: Option<String>,
    pub source: LinkSource,
    /// Summary fetched through MCP. TODO(M2).
    #[serde(default)]
    pub summary: Option<String>,
}

// ---------------------------------------------------------------------------
// Commit composer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitType {
    Feat,
    Fix,
    Refactor,
    Perf,
    Test,
    Docs,
    Style,
    Build,
    Ci,
    Chore,
    Revert,
}

/// What a repo asks of its commit messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRules {
    /// Allowed types (`type-enum`).
    pub types: Vec<String>,
    /// Allowed scopes (`scope-enum`); empty means any scope.
    pub scopes: Vec<String>,
    /// `header-max-length`.
    pub header_max: u32,
}

/// One commit proposed by the composer: the hunks it takes and its message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitGroup {
    pub id: String,
    pub repo: String,
    pub kind: CommitType,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub breaking: bool,
    #[serde(default)]
    pub breaking_reason: Option<String>,
    pub subject: String,
    #[serde(default)]
    pub body: String,
    /// Trailer lines such as `Refs: PAY-412`.
    #[serde(default)]
    pub footers: Vec<String>,
    /// Ids of the staged hunks this commit takes.
    pub hunks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPlan {
    /// Whether the repo uses conventional commits (history or commitlint).
    pub conventional: bool,
    pub rules: CommitRules,
    pub groups: Vec<CommitGroup>,
}

/// A problem found by `commitplan::validate`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// "header", "type", "scope", "subject" or "body".
    pub field: String,
    pub message: String,
}
