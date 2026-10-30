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
    /// The branch the space was created with, e.g. "feat/refunds": what a repo added later
    /// gets by default. Each repo has its own branch in [`SpaceRepo::branch`].
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
    /// The issue the task is about, e.g. "PAY-412": the `Refs:` footer of its commits, a
    /// label of its agents, `{ticket}` in the branch template.
    #[serde(default)]
    pub ticket: Option<String>,
}

impl Space {
    /// Older spaces had one branch for every repo: give each repo that branch. Then read the
    /// branch each repo is on now.
    pub fn normalize(&mut self) {
        for r in &mut self.repos {
            if r.branch.trim().is_empty() {
                r.branch = self.branch.clone();
            }
            if let Some(b) = crate::git::head_branch(std::path::Path::new(&r.worktree)) {
                r.branch = b;
            }
        }
    }

    pub fn repo(&self, name: &str) -> Option<&SpaceRepo> {
        self.repos.iter().find(|r| r.name == name)
    }

    /// The branch of a repo of the space (the space branch for an unknown repo).
    pub fn branch_of(&self, repo: &str) -> &str {
        self.repo(repo)
            .map(|r| r.branch.as_str())
            .filter(|b| !b.is_empty())
            .unwrap_or(&self.branch)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRepo {
    /// Short display name, defaults to the source directory name.
    pub name: String,
    /// The user's clone.
    pub source: String,
    /// Where the space works: the clone itself. Spaces made before Vela worked in your
    /// clones point to a worktree under `VELA_HOME/worktrees` (see [`SpaceRepo::is_clone`]).
    pub worktree: String,
    /// Ref the branch was created from, e.g. "main".
    pub base: String,
    /// The branch checked out where the space works, read again from git on every load:
    /// switch branches in another editor and the space follows.
    #[serde(default)]
    pub branch: String,
}

impl SpaceRepo {
    /// The space works in the user's clone (false: an older space, in a Vela worktree).
    pub fn is_clone(&self) -> bool {
        self.worktree == self.source
    }
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
    /// Reads the request and the code as a product manager: scope, user stories, edge cases.
    Product,
    /// Reads the code as a security reviewer: threats, unsafe patterns, secrets.
    Security,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
    Working,
    /// Asked a question and waits for the answer.
    Waiting,
    Done,
    Failed,
    /// Was running when Vela stopped: the process is gone, the worktree is kept.
    Interrupted,
}

/// What a request needs, not which model: each harness maps a tier to a model in config.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    High,
    Medium,
    Low,
}

impl Tier {
    pub const ALL: [Tier; 3] = [Tier::High, Tier::Medium, Tier::Low];

    pub fn as_str(self) -> &'static str {
        match self {
            Tier::High => "high",
            Tier::Medium => "medium",
            Tier::Low => "low",
        }
    }

    /// One step up (`delta` 1) or down (-1), stopping at the ends.
    pub fn shift(self, delta: i32) -> Tier {
        let i = Tier::ALL.iter().position(|t| *t == self).unwrap_or(1) as i32;
        Tier::ALL[(i - delta).clamp(0, 2) as usize]
    }
}

impl AgentRole {
    pub const ALL: [AgentRole; 7] = [
        AgentRole::Developer,
        AgentRole::Reviewer,
        AgentRole::Tester,
        AgentRole::Planner,
        AgentRole::Debugger,
        AgentRole::Product,
        AgentRole::Security,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            AgentRole::Planner => "planner",
            AgentRole::Developer => "developer",
            AgentRole::Reviewer => "reviewer",
            AgentRole::Tester => "tester",
            AgentRole::Debugger => "debugger",
            AgentRole::Product => "product",
            AgentRole::Security => "security",
        }
    }

    pub fn parse(s: &str) -> Option<AgentRole> {
        Some(match s {
            "planner" => AgentRole::Planner,
            "developer" => AgentRole::Developer,
            "reviewer" => AgentRole::Reviewer,
            "tester" => AgentRole::Tester,
            "debugger" => AgentRole::Debugger,
            "product" => AgentRole::Product,
            "security" => AgentRole::Security,
            _ => return None,
        })
    }
}

/// Tokens and cost an agent used, summed over its runs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Dollars, as reported by the harness (0 when it does not report one).
    pub cost_usd: f64,
}

/// A coding agent CLI running for a space, in its own worktree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub space: String,
    pub role: AgentRole,
    /// The harness: "claude", "codex" or "opencode".
    pub tool: String,
    /// Repo name → agent worktree path. Reviewers get none (read only).
    pub worktrees: Vec<(String, String)>,
    pub status: AgentStatus,
    /// One line: the latest message of the agent, or the question it asks.
    pub summary: String,
    /// Model passed to the harness, None when the harness default is used.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub tier: Option<Tier>,
    /// Session id of the harness, used to resume the conversation.
    #[serde(default)]
    pub session: Option<String>,
    /// What the user asked.
    #[serde(default)]
    pub prompt: String,
    /// Full text of the latest message (streams while the agent works).
    #[serde(default)]
    pub last_message: String,
    /// Steps of the plan the agent announced, if any.
    #[serde(default)]
    pub plan: Vec<String>,
    /// The question the agent waits on, and its options.
    #[serde(default)]
    pub question: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub usage: AgentUsage,
    /// RFC 3339.
    #[serde(default)]
    pub started: String,
    #[serde(default)]
    pub finished: Option<String>,
    /// What the agent does right now while it works, e.g. "Bash: cargo test".
    #[serde(default)]
    pub activity: String,
    /// RFC 3339 time of its last event: how long it has been quiet.
    #[serde(default)]
    pub last_event: Option<String>,
    /// One or two words to find the conversation again ("refunds", "PAY-412").
    #[serde(default)]
    pub labels: Vec<String>,
    /// A short title of the conversation, from the Vela model.
    #[serde(default)]
    pub title: Option<String>,
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
    /// The ticket of the space.
    Ticket,
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

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

/// One file of a worktree with its git status, for the file tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeFile {
    /// Path relative to the worktree root, `/` separated.
    pub path: String,
    /// Change recorded in the index (staged).
    pub staged: Option<ChangeKind>,
    /// Change in the worktree not yet staged.
    pub unstaged: Option<ChangeKind>,
}

/// Every file of one repo of a space.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFiles {
    pub repo: String,
    pub branch: String,
    pub worktree: String,
    /// Commits ahead of / behind the upstream, None without an upstream.
    #[serde(default)]
    pub ahead: Option<u32>,
    #[serde(default)]
    pub behind: Option<u32>,
    /// Sorted by path.
    pub files: Vec<TreeFile>,
    /// The listing was cut at [`crate::files::MAX_FILES`].
    pub truncated: bool,
}

/// A problem found by `commitplan::validate`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// "header", "type", "scope", "subject" or "body".
    pub field: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Checks: hooks, tests, lint and types run on the staged set
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckKind {
    Hook,
    Test,
    Lint,
    Types,
    Custom,
}

/// When a check runs by itself: when the staged set changes, or only on request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckWhen {
    Staged,
    Manual,
}

/// What the Checks panel shows for one check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Idle,
    Running,
    Pass,
    Fail,
    Skipped,
    /// The tool the command needs is not on PATH.
    Missing,
    Disabled,
}

/// One check of one repo, with its last known result for the current staged set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckEntry {
    pub repo: String,
    pub id: String,
    pub name: String,
    pub kind: CheckKind,
    pub command: String,
    /// Optional checks (tests) are off until the user turns them on.
    pub optional: bool,
    pub enabled: bool,
    pub missing: bool,
    /// Where it comes from: a file name such as `.pre-commit-config.yaml`, or `config`.
    pub source: String,
    pub when: CheckWhen,
    pub status: CheckStatus,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    /// The result was served from the cache.
    #[serde(default)]
    pub cached: bool,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub timed_out: bool,
}

/// The checks of one repo of the space, plus the effective `checks.auto`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoChecks {
    pub repo: String,
    pub auto: bool,
    pub checks: Vec<CheckEntry>,
    /// Problems found in the config files (unknown keys, bad syntax).
    #[serde(default)]
    pub warnings: Vec<String>,
}
