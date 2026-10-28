//! The command layer: plain functions over a [`Vela`] handle, testable without a webview.
//! `tauri_cmds.rs` wraps each of them in a thin `#[tauri::command]`.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use vela_agents::HarnessInfo;
use vela_agents::manager::{AgentManager, AskRequest, Emit as EmitAgent, QuestionView};
use vela_agents::merge;
use vela_agents::notes::Note;
use vela_agents::proposals::{self, Proposal};
use vela_agents::registry::{self, LogEntry};
use vela_core::Vela;
use vela_core::checks;
use vela_core::commitplan::{self, GroupCommit};
use vela_core::config;
use vela_core::git::git;
use vela_core::links::{self, IssueConfig};
use vela_core::model::{
    Agent, AgentRole, AgentUsage, CommitGroup, CommitPlan, CommitRules, FileChange, Hunk,
    HunkState, Link, LinkSource, Problem, RepoChecks, RepoFiles, Space, Tier, UpNext,
};
use vela_core::{commit as core_commit, diff, files, paths, space, stage, status, store, upnext};

use crate::checkrun::{CheckRunner, EmitCheck};
use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// Results that are not in model.rs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub repo: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub repos: Vec<String>,
    pub branch: String,
    /// One entry per commit made by the composer; empty for a plain commit.
    #[serde(default)]
    pub commits: Vec<GroupCommit>,
}

fn load(vela: &Vela, id: &str) -> AppResult<Space> {
    Ok(store::load(vela, id)?)
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

/// Spaces that are not archived, oldest first.
pub fn list_spaces(vela: &Vela) -> AppResult<Vec<Space>> {
    Ok(store::list(vela)?
        .into_iter()
        .filter(|s| !s.archived)
        .collect())
}

/// Create a space with a branch and a worktree per repo path. `branch` and `base` left out
/// take the defaults: the `[spaces] branch` template, each repo's current branch.
pub fn create_space(
    vela: &Vela,
    name: &str,
    repos: &[String],
    branch: Option<&str>,
    base: Option<&str>,
) -> AppResult<Space> {
    Ok(space::create_with(
        vela,
        name,
        repos,
        &space::CreateOptions {
            branch: branch.map(str::to_string),
            base: base.map(str::to_string),
        },
    )?)
}

/// Add a repo (by path) to an existing space: one more worktree on the space branch.
pub fn add_repo_to_space(vela: &Vela, id: &str, path: &str) -> AppResult<Space> {
    let dir = expand_home(path.trim());
    Ok(space::add_repo(vela, id, &dir)?)
}

/// Remove a repo from a space (its worktree must be clean).
pub fn remove_repo_from_space(vela: &Vela, id: &str, repo: &str) -> AppResult<Space> {
    Ok(space::remove_repo(vela, id, repo)?)
}

/// Store the window of a space; None puts it back in the main window.
pub fn set_window(vela: &Vela, id: &str, window: Option<u32>) -> AppResult<Space> {
    let mut s = load(vela, id)?;
    s.window = window;
    store::save(vela, &s)?;
    Ok(s)
}

/// Window numbers are meaningless after a restart: no window is open yet.
pub fn clear_windows(vela: &Vela) -> AppResult<()> {
    for s in store::list(vela)? {
        if s.window.is_some() {
            set_window(vela, &s.id, None)?;
        }
    }
    Ok(())
}

/// Smallest window number above 1 that no space uses.
pub fn next_window(vela: &Vela) -> AppResult<u32> {
    let used: BTreeSet<u32> = store::list(vela)?.iter().filter_map(|s| s.window).collect();
    Ok((2..).find(|n| !used.contains(n)).unwrap_or(2))
}

// ---------------------------------------------------------------------------
// Status and hunks
// ---------------------------------------------------------------------------

pub fn status(vela: &Vela, id: &str) -> AppResult<Vec<FileChange>> {
    Ok(status::space_status(&load(vela, id)?)?)
}

fn rejected_file(vela: &Vela, id: &str) -> PathBuf {
    paths::spaces_dir(&vela.home).join(format!("{id}.rejected.json"))
}

/// Ids of the hunks the user rejected in this space.
pub fn rejected_ids(vela: &Vela, id: &str) -> AppResult<BTreeSet<String>> {
    match fs::read_to_string(rejected_file(vela, id)) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(e) => Err(e.into()),
    }
}

fn accepted_file(vela: &Vela, id: &str) -> PathBuf {
    paths::spaces_dir(&vela.home).join(format!("{id}.accepted.json"))
}

/// Ids of the proposals the user accepted: never offered again, even when the user changes
/// those lines afterwards.
pub fn accepted_ids(vela: &Vela, id: &str) -> AppResult<BTreeSet<String>> {
    match fs::read_to_string(accepted_file(vela, id)) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(e) => Err(e.into()),
    }
}

fn remember_accepted(vela: &Vela, id: &str, ids: &[String]) -> AppResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut all = accepted_ids(vela, id)?;
    all.extend(ids.iter().cloned());
    fs::create_dir_all(paths::spaces_dir(&vela.home))?;
    fs::write(accepted_file(vela, id), serde_json::to_string_pretty(&all)?)?;
    Ok(())
}

fn save_rejected(vela: &Vela, id: &str, ids: &BTreeSet<String>) -> AppResult<()> {
    fs::create_dir_all(paths::spaces_dir(&vela.home))?;
    fs::write(rejected_file(vela, id), serde_json::to_string_pretty(ids)?)?;
    Ok(())
}

// One refresh of the UI asks for the hunks, the notes and Up next at the same time, and each
// needs every diff of the space. They share one computation: concurrent calls wait for the
// one in flight, and its result is reused for a moment. Anything that changes the space drops
// it (`Invalidate` at the end of every write, the file watcher, agent events).

struct HunkSlot {
    at: Option<std::time::Instant>,
    hunks: Vec<Hunk>,
}

type Slots = std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<HunkSlot>>>;
static HUNK_SLOTS: std::sync::Mutex<Option<Slots>> = std::sync::Mutex::new(None);
const HUNK_TTL: std::time::Duration = std::time::Duration::from_millis(150);

fn hunk_slot(vela: &Vela, id: &str) -> std::sync::Arc<std::sync::Mutex<HunkSlot>> {
    let mut g = HUNK_SLOTS.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(Default::default)
        .entry(format!("{}\0{id}", vela.home.display()))
        .or_insert_with(|| {
            std::sync::Arc::new(std::sync::Mutex::new(HunkSlot {
                at: None,
                hunks: Vec::new(),
            }))
        })
        .clone()
}

/// Forget the cached hunks of a space.
pub fn invalidate_hunks(id: &str) {
    let suffix = format!("\0{id}");
    let slots: Vec<_> = HUNK_SLOTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|m| {
            m.iter()
                .filter(|(k, _)| k.ends_with(&suffix))
                .map(|(_, v)| v.clone())
                .collect()
        })
        .unwrap_or_default();
    for s in slots {
        s.lock().unwrap_or_else(|e| e.into_inner()).at = None;
    }
}

/// Drops the cached hunks when the write that holds it ends.
pub struct Invalidate<'a>(pub &'a str);

impl Drop for Invalidate<'_> {
    fn drop(&mut self) {
        invalidate_hunks(self.0);
    }
}

/// Pending worktree hunks (origin You, minus the rejected ones) and the staged hunks.
pub fn hunks(vela: &Vela, id: &str) -> AppResult<Vec<Hunk>> {
    let slot = hunk_slot(vela, id);
    let mut g = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(at) = g.at
        && at.elapsed() < HUNK_TTL
    {
        return Ok(g.hunks.clone());
    }
    let fresh = compute_hunks(vela, id)?;
    g.hunks = fresh.clone();
    g.at = Some(std::time::Instant::now());
    Ok(fresh)
}

fn compute_hunks(vela: &Vela, id: &str) -> AppResult<Vec<Hunk>> {
    let space = load(vela, id)?;
    let rejected = rejected_ids(vela, id)?;
    let staged = diff::staged_hunks(&space)?;
    let mut out: Vec<Hunk> = diff::worktree_hunks(&space)?
        .into_iter()
        .filter(|h| !rejected.contains(&h.id) && !staged.iter().any(|s| s.id == h.id))
        .collect();
    out.extend(staged);
    // What the agents propose: their changes that are not in the worktree yet.
    out.extend(
        agent_proposals(vela, &space, &rejected, false)?
            .into_iter()
            .map(|p| p.hunk),
    );
    Ok(out)
}

/// The proposals of the agents of the space (see `vela_agents::proposals`).
fn agent_proposals(
    vela: &Vela,
    space: &Space,
    rejected: &BTreeSet<String>,
    with_rejected: bool,
) -> AppResult<Vec<Proposal>> {
    let entries = registry::load(vela, &space.id)?;
    if entries.iter().all(|e| e.agent.worktrees.is_empty()) {
        return Ok(Vec::new());
    }
    let accepted = accepted_ids(vela, &space.id)?;
    // Hidden either way: the accepted ones are skipped before any git call.
    let hide: BTreeSet<String>;
    let skip = if with_rejected {
        rejected
    } else {
        hide = rejected.union(&accepted).cloned().collect();
        &hide
    };
    let list: Vec<Proposal> = proposals::proposals(space, &entries, skip, with_rejected)?
        .into_iter()
        .filter(|p| !accepted.contains(&p.hunk.id))
        .collect();
    Ok(list)
}

fn find(list: Vec<Hunk>, hunk_id: &str) -> AppResult<Hunk> {
    list.into_iter()
        .find(|h| h.id == hunk_id)
        .ok_or_else(|| vela_core::Error::HunkNotFound(hunk_id.to_string()).into())
}

/// Stage one hunk (also what accepting a proposal does) and return it as staged.
pub fn stage_hunk(vela: &Vela, id: &str, hunk_id: &str) -> AppResult<Hunk> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    let Some(mut hunk) = diff::worktree_hunks(&space)?
        .into_iter()
        .find(|h| h.id == hunk_id)
    else {
        return accept_proposal(vela, id, hunk_id);
    };
    stage::stage_hunk(&space, hunk_id)?;
    let mut rejected = rejected_ids(vela, id)?;
    if rejected.remove(hunk_id) {
        save_rejected(vela, id, &rejected)?;
    }
    // Staging can split or merge hunks; hand back the staged version when it still exists.
    if let Some(h) = diff::staged_hunks(&space)?
        .into_iter()
        .find(|h| h.id == hunk_id)
    {
        return Ok(h);
    }
    hunk.state = HunkState::Staged;
    Ok(hunk)
}

/// Back to pending: unstage a staged hunk, or forget a rejection.
pub fn unstage_hunk(vela: &Vela, id: &str, hunk_id: &str) -> AppResult<Hunk> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    let mut rejected = rejected_ids(vela, id)?;
    if rejected.remove(hunk_id) {
        save_rejected(vela, id, &rejected)?;
        let mut h = match diff::worktree_hunks(&space)?
            .into_iter()
            .find(|h| h.id == hunk_id)
        {
            Some(h) => h,
            None => find(
                agent_proposals(vela, &space, &rejected, false)?
                    .into_iter()
                    .map(|p| p.hunk)
                    .collect(),
                hunk_id,
            )?,
        };
        h.state = HunkState::Pending;
        return Ok(h);
    }
    stage::unstage_hunk(&space, hunk_id)?;
    let mut h = find(diff::worktree_hunks(&space)?, hunk_id)?;
    h.state = HunkState::Pending;
    Ok(h)
}

/// Throw away one of your hunks, staged or not: its lines go back to HEAD (or the index).
pub fn discard_hunk(vela: &Vela, id: &str, hunk_id: &str) -> AppResult<()> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    stage::discard_hunk(&space, hunk_id)?;
    Ok(())
}

/// Hide a pending hunk for good: its id is stored in `spaces/<id>.rejected.json`.
pub fn reject_hunk(vela: &Vela, id: &str, hunk_id: &str) -> AppResult<Hunk> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    let mut rejected = rejected_ids(vela, id)?;
    let mut h = match diff::worktree_hunks(&space)?
        .into_iter()
        .find(|h| h.id == hunk_id)
    {
        Some(h) => h,
        None => find(
            agent_proposals(vela, &space, &rejected, false)?
                .into_iter()
                .map(|p| p.hunk)
                .collect(),
            hunk_id,
        )?,
    };
    if rejected.insert(hunk_id.to_string()) {
        save_rejected(vela, id, &rejected)?;
    }
    h.state = HunkState::Rejected;
    Ok(h)
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

fn forbidden(rel: &str) -> AppError {
    AppError::forbidden(format!("path is outside the space worktree: {rel}"))
}

/// Resolve `rel` inside the worktree of `repo`.
///
/// Absolute paths, `..`, anything under `.git` and symlinks that lead outside are refused.
/// The path need not exist yet (for writes): the deepest existing ancestor is canonicalized.
pub fn resolve_path(space: &Space, repo: &str, rel: &str) -> AppResult<PathBuf> {
    let r = space
        .repos
        .iter()
        .find(|r| r.name == repo)
        .ok_or_else(|| vela_core::Error::RepoNotFound(repo.to_string()))?;
    let root = fs::canonicalize(&r.worktree)?;
    let rel_path = Path::new(rel);
    let mut clean = PathBuf::new();
    for c in rel_path.components() {
        match c {
            Component::Normal(n) => clean.push(n),
            Component::CurDir => {}
            _ => return Err(forbidden(rel)),
        }
    }
    if clean.as_os_str().is_empty() || clean.starts_with(".git") {
        return Err(forbidden(rel));
    }
    let joined = root.join(&clean);
    // Walk up to the deepest entry that exists (a dangling symlink counts as existing).
    let mut cur = joined.as_path();
    while fs::symlink_metadata(cur).is_err() {
        cur = cur.parent().ok_or_else(|| forbidden(rel))?;
    }
    let canon = fs::canonicalize(cur).map_err(|_| forbidden(rel))?;
    if !canon.starts_with(&root) {
        return Err(forbidden(rel));
    }
    let rest = joined.strip_prefix(cur).map_err(|_| forbidden(rel))?;
    if rest.as_os_str().is_empty() {
        return Ok(canon);
    }
    Ok(canon.join(rest))
}

/// Every file of every worktree: tracked and untracked, ignored files left out.
pub fn list_files(vela: &Vela, id: &str) -> AppResult<Vec<FileRef>> {
    let space = load(vela, id)?;
    let mut out = Vec::new();
    for r in &space.repos {
        let dir = Path::new(&r.worktree);
        let listing = git(
            dir,
            &[
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
        )?;
        let mut paths: Vec<&str> = listing.split('\0').filter(|p| !p.is_empty()).collect();
        paths.sort_unstable();
        paths.dedup();
        for p in paths {
            // Files deleted in the worktree are still listed by --cached.
            if fs::symlink_metadata(dir.join(p)).is_ok() {
                out.push(FileRef {
                    repo: r.name.clone(),
                    path: p.to_string(),
                });
            }
        }
    }
    Ok(out)
}

/// Every file of every repo of the space with its status, for the file tree.
pub fn space_files(vela: &Vela, id: &str) -> AppResult<Vec<RepoFiles>> {
    Ok(files::space_files(&load(vela, id)?)?)
}

/// Stage every change of one file.
pub fn stage_file(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<()> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    resolve_path(&space, repo, path)?;
    Ok(stage::stage_file(&space, repo, path)?)
}

/// Stage every change of several files, one git call per repo.
pub fn stage_files(vela: &Vela, id: &str, files: &[(String, String)]) -> AppResult<()> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    for (repo, path) in files {
        resolve_path(&space, repo, path)?;
    }
    Ok(stage::stage_files(&space, files)?)
}

/// Unstage every staged change of several files, one git call per repo.
pub fn unstage_files(vela: &Vela, id: &str, files: &[(String, String)]) -> AppResult<()> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    for (repo, path) in files {
        resolve_path(&space, repo, path)?;
    }
    Ok(stage::unstage_files(&space, files)?)
}

/// Unstage every staged change of one file.
pub fn unstage_file(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<()> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    resolve_path(&space, repo, path)?;
    Ok(stage::unstage_file(&space, repo, path)?)
}

pub fn read_file(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<String> {
    let space = load(vela, id)?;
    let full = resolve_path(&space, repo, path)?;
    let bytes = fs::read(&full)?;
    String::from_utf8(bytes)
        .map_err(|_| AppError::new("binary", format!("not a text file: {path}")))
}

pub fn write_file(vela: &Vela, id: &str, repo: &str, path: &str, content: &str) -> AppResult<()> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    let full = resolve_path(&space, repo, path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&full, content)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commit and up next
// ---------------------------------------------------------------------------

/// One commit per repo with staged changes, same message.
/// TODO(M4): run the gate first; `override_reason` becomes the `Vela-Override:` trailer.
pub fn commit(
    vela: &Vela,
    id: &str,
    message: &str,
    _override_reason: Option<&str>,
) -> AppResult<CommitResult> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    if message.trim().is_empty() {
        return Err(AppError::invalid("empty commit message"));
    }
    let skip = checks::commit_skip(vela, &space);
    let done = core_commit::commit_with(&space, message, Some(&skip))?;
    Ok(CommitResult {
        repos: done.into_iter().map(|(repo, _)| repo).collect(),
        branch: space.branch,
        commits: Vec::new(),
    })
}

/// Propose commits for the staged hunks: grouped, typed, scoped, with ticket footers.
pub fn commit_plan(vela: &Vela, id: &str) -> AppResult<CommitPlan> {
    let space = load(vela, id)?;
    let links = links::list_links(&space, &IssueConfig::from_env())?;
    Ok(commitplan::plan(&space, &links)?)
}

/// Check a message against the repo rules (`conventional` false only checks the basics).
pub fn validate_message(message: &str, rules: &CommitRules, conventional: bool) -> Vec<Problem> {
    commitplan::validate_for(message, rules, conventional)
}

/// Commit the groups in order. A non empty `override_reason` becomes a `Vela-Override:` footer.
/// TODO(M4): run the gate first.
pub fn commit_groups(
    vela: &Vela,
    id: &str,
    conventional: bool,
    groups: Vec<CommitGroup>,
    override_reason: Option<&str>,
) -> AppResult<CommitResult> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    let mut groups = groups;
    if let Some(reason) = override_reason.map(str::trim).filter(|r| !r.is_empty()) {
        for g in &mut groups {
            g.footers.push(format!("Vela-Override: {reason}"));
        }
    }
    let skip = checks::commit_skip(vela, &space);
    let commits = commitplan::commit_groups_with(&space, conventional, &groups, Some(&skip))?;
    let mut repos: Vec<String> = Vec::new();
    for c in &commits {
        if !repos.contains(&c.repo) {
            repos.push(c.repo.clone());
        }
    }
    Ok(CommitResult {
        repos,
        branch: space.branch,
        commits,
    })
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/// Every repo of the space with its checks: detected, custom, enabled or not, and the
/// status of the last run for the current staged set.
pub fn checks(vela: &Vela, runner: &CheckRunner, id: &str) -> AppResult<Vec<RepoChecks>> {
    Ok(runner.list(vela, &load(vela, id)?))
}

/// Start checks in the background (`ids` picks some, even disabled ones; none runs every
/// enabled check). Progress comes as `vela://check` events. `force` ignores the cache.
/// Returns the `(repo, id)` pairs started.
pub fn run_checks(
    vela: &Vela,
    runner: &std::sync::Arc<CheckRunner>,
    id: &str,
    ids: Option<&[String]>,
    force: bool,
    emit: &EmitCheck,
) -> AppResult<Vec<(String, String)>> {
    let space = load(vela, id)?;
    Ok(runner.run(vela, &space, ids, force, emit))
}

/// Output of the run in flight, or of the last run for the current staged set.
pub fn check_log(
    vela: &Vela,
    runner: &CheckRunner,
    id: &str,
    repo: &str,
    check: &str,
) -> AppResult<String> {
    let space = load(vela, id)?;
    if !space.repos.iter().any(|r| r.name == repo) {
        return Err(vela_core::Error::RepoNotFound(repo.to_string()).into());
    }
    Ok(runner.log(vela, &space, repo, check))
}

/// Turn a check on or off for this repo. Written to the repo local layer
/// (`VELA_HOME/repos/<repo>.toml`), never to the committed config.
pub fn set_check_enabled(
    vela: &Vela,
    id: &str,
    repo: &str,
    check: &str,
    enabled: bool,
) -> AppResult<()> {
    let space = load(vela, id)?;
    if !space.repos.iter().any(|r| r.name == repo) {
        return Err(vela_core::Error::RepoNotFound(repo.to_string()).into());
    }
    if check.is_empty() || check.contains(['.', '"', '\n']) {
        return Err(AppError::invalid(format!("bad check id: {check:?}")));
    }
    config::set_check_enabled(vela, repo, check, enabled)?;
    Ok(())
}

/// Turn `checks.auto` on or off for this repo (repo local layer).
pub fn set_checks_auto(vela: &Vela, id: &str, repo: &str, auto: bool) -> AppResult<()> {
    let space = load(vela, id)?;
    if !space.repos.iter().any(|r| r.name == repo) {
        return Err(vela_core::Error::RepoNotFound(repo.to_string()).into());
    }
    config::set_local_value(vela, repo, &["checks", "auto"], toml::Value::Boolean(auto))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/// Stored, detected and repo links of the space.
pub fn list_links(vela: &Vela, id: &str) -> AppResult<Vec<Link>> {
    list_links_with(vela, id, &IssueConfig::from_env())
}

pub fn list_links_with(vela: &Vela, id: &str, cfg: &IssueConfig) -> AppResult<Vec<Link>> {
    Ok(links::list_links(&load(vela, id)?, cfg)?)
}

/// Add a link by hand (`source` "paste" for pasted URLs, anything else is manual).
pub fn add_link(
    vela: &Vela,
    id: &str,
    url: &str,
    title: Option<&str>,
    source: Option<&str>,
) -> AppResult<Link> {
    let mut space = load(vela, id)?;
    let source = if source == Some("paste") {
        LinkSource::Paste
    } else {
        LinkSource::Manual
    };
    let link = links::add_link_from(&mut space, url, title, source)?;
    store::save(vela, &space)?;
    Ok(link)
}

/// Remove a stored link. Detected and repo links come back unless their source changes.
pub fn remove_link(vela: &Vela, id: &str, link_id: &str) -> AppResult<()> {
    let mut space = load(vela, id)?;
    links::remove_link(&mut space, link_id)?;
    store::save(vela, &space)?;
    Ok(())
}

/// Only http and https URLs may be opened.
pub fn check_openable(url: &str) -> AppResult<&str> {
    let url = url.trim();
    if links::is_http_url(url) {
        Ok(url)
    } else {
        Err(AppError::invalid(format!(
            "only http and https links can be opened: {url}"
        )))
    }
}

/// A neutral starting point for the message. TODO(M4): drafted from the staged diff.
pub fn draft_commit(vela: &Vela, id: &str) -> AppResult<String> {
    Ok(load(vela, id)?.name)
}

pub fn up_next(vela: &Vela, id: &str) -> AppResult<UpNext> {
    let space = load(vela, id)?;
    let pending = hunks(vela, id)?
        .iter()
        .filter(|h| h.state == HunkState::Pending)
        .count();
    let changes = status::space_status(&space)?;
    let questions: Vec<(String, String)> = registry::load(vela, id)?
        .into_iter()
        .filter(|e| e.agent.status == vela_core::model::AgentStatus::Waiting)
        .filter_map(|e| Some((e.agent.id, e.agent.question?)))
        .collect();
    Ok(upnext::up_next(pending, &changes, &questions))
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/// Which harnesses are installed, with their versions.
pub fn harnesses(agents: &AgentManager) -> Vec<HarnessInfo> {
    agents.harnesses()
}

/// What a role gets when the request says nothing. Mirrors `RoleDefault` of the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleDefault {
    pub role: AgentRole,
    pub harness: String,
    pub tier: Tier,
    pub model: Option<String>,
}

/// Harness, tier and model of every role, from the layered config and what is installed.
pub fn agent_defaults(vela: &Vela, agents: &AgentManager, id: &str) -> AppResult<Vec<RoleDefault>> {
    let space = load(vela, id)?;
    Ok(agents
        .role_defaults(vela, &space)
        .into_iter()
        .map(|(role, r)| RoleDefault {
            role,
            harness: r.harness,
            tier: r.tier,
            model: r.model,
        })
        .collect())
}

/// The agents of the space, newest first. Runs cut short by a restart show as interrupted.
pub fn agents(vela: &Vela, agents: &AgentManager, id: &str) -> AppResult<Vec<Agent>> {
    load(vela, id)?;
    Ok(agents.list(vela, id)?)
}

/// Start an agent for a role. `harness` and `tier` override the role's defaults.
#[allow(clippy::too_many_arguments)]
pub fn ask_agent(
    vela: &Vela,
    agents: &std::sync::Arc<AgentManager>,
    id: &str,
    role: &str,
    prompt: &str,
    harness: Option<&str>,
    tier: Option<&str>,
    emit: &EmitAgent,
) -> AppResult<Agent> {
    let space = load(vela, id)?;
    let role =
        AgentRole::parse(role).ok_or_else(|| AppError::invalid(format!("unknown role: {role}")))?;
    let tier = match tier {
        None => None,
        Some(t) => Some(
            Tier::ALL
                .into_iter()
                .find(|x| x.as_str() == t)
                .ok_or_else(|| AppError::invalid(format!("unknown tier: {t}")))?,
        ),
    };
    let req = AskRequest {
        role,
        prompt: prompt.to_string(),
        harness: harness.map(str::to_string),
        tier,
    };
    Ok(agents.ask(vela, &space, req, emit)?)
}

/// Answer the question of an agent (a resumed run).
pub fn answer_agent(
    vela: &Vela,
    agents: &std::sync::Arc<AgentManager>,
    id: &str,
    agent: &str,
    text: &str,
    emit: &EmitAgent,
) -> AppResult<Agent> {
    let space = load(vela, id)?;
    Ok(agents.answer(vela, &space, agent, text, emit)?)
}

/// Kill a running agent. Returns whether it was running.
pub fn cancel_agent(agents: &AgentManager, id: &str, agent: &str) -> bool {
    agents.cancel(id, agent)
}

/// Everything the agent did and said, oldest first.
pub fn agent_log(
    vela: &Vela,
    agents: &AgentManager,
    id: &str,
    agent: &str,
) -> AppResult<Vec<LogEntry>> {
    Ok(agents.log(vela, id, agent)?)
}

/// The question an agent of the space waits on, if any.
pub fn question(vela: &Vela, agents: &AgentManager, id: &str) -> AppResult<Option<QuestionView>> {
    Ok(agents.question(vela, id)?)
}

/// Tokens and cost of every agent of the space.
pub fn agent_usage(vela: &Vela, id: &str) -> AppResult<AgentUsage> {
    Ok(registry::totals(&registry::load(vela, id)?))
}

/// Why each proposed hunk exists: the latest message of the agent that proposed it.
pub fn reasons(vela: &Vela, id: &str) -> AppResult<std::collections::HashMap<String, String>> {
    let space = load(vela, id)?;
    let rejected = rejected_ids(vela, id)?;
    let entries = registry::load(vela, id)?;
    let hunks: Vec<Hunk> = agent_proposals(vela, &space, &rejected, true)?
        .into_iter()
        .map(|p| p.hunk)
        .collect();
    Ok(proposals::reasons(&entries, &hunks))
}

/// Accept several hunks at once: your own are staged, the proposals of agents are applied to
/// your worktree and staged. One diff of the space for the lot. Returns what did not apply.
pub fn accept_hunks(vela: &Vela, id: &str, hunk_ids: &[String]) -> AppResult<Vec<String>> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    let mut rejected = rejected_ids(vela, id)?;
    let list = agent_proposals(vela, &space, &rejected, true)?;
    let picked: Vec<&Proposal> = list
        .iter()
        .filter(|p| hunk_ids.contains(&p.hunk.id))
        .collect();
    let mine: Vec<String> = hunk_ids
        .iter()
        .filter(|h| !picked.iter().any(|p| &p.hunk.id == *h))
        .cloned()
        .collect();
    stage::stage_hunks(&space, &mine)?;
    let mut failed = proposals::accept_many(&space, &picked)?;
    // What git apply refused (you changed lines next to them): a three-way merge of each file,
    // written when it is clean. Conflicts stay for the Review, which shows them.
    if !failed.is_empty() {
        let entries = registry::load(vela, id)?;
        let mut files: Vec<(String, String)> = Vec::new();
        for (fid, _) in &failed {
            if let Some(p) = picked.iter().find(|p| &p.hunk.id == fid) {
                let k = (p.hunk.repo.clone(), p.hunk.path.clone());
                if !files.contains(&k) {
                    files.push(k);
                }
            }
        }
        for (repo, path) in files {
            let list: Vec<&Proposal> = picked
                .iter()
                .copied()
                .filter(|p| {
                    p.hunk.repo == repo
                        && p.hunk.path == path
                        && failed.iter().any(|(f, _)| f == &p.hunk.id)
                })
                .collect();
            let m = merge::merge_file(&space, &entries, &repo, &path, &list)?;
            if m.conflicts > 0 || !m.notes.is_empty() {
                for (f, why) in failed.iter_mut() {
                    if m.ids.contains(f) {
                        *why = format!(
                            "{path}: you changed the same lines. Open it in the Review to resolve"
                        );
                    }
                }
                continue;
            }
            merge::write_result(&space, &repo, &path, &m.result)?;
            stage::stage_files(&space, &[(repo.clone(), path.clone())])?;
            failed.retain(|(f, _)| !m.ids.contains(f));
        }
    }
    let taken: Vec<String> = picked
        .iter()
        .map(|p| p.hunk.id.clone())
        .filter(|h| !failed.iter().any(|(f, _)| f == h))
        .collect();
    remember_accepted(vela, id, &taken)?;
    let before = rejected.len();
    rejected.retain(|r| !hunk_ids.contains(r) || failed.iter().any(|(f, _)| f == r));
    if rejected.len() != before {
        save_rejected(vela, id, &rejected)?;
    }
    Ok(failed.into_iter().map(|(_, why)| why).collect())
}

/// Apply a proposal of an agent to your worktree and stage it.
pub fn accept_proposal(vela: &Vela, id: &str, hunk_id: &str) -> AppResult<Hunk> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    let rejected = rejected_ids(vela, id)?;
    let list = agent_proposals(vela, &space, &rejected, true)?;
    let p = list
        .iter()
        .find(|p| p.hunk.id == hunk_id)
        .ok_or_else(|| vela_core::Error::HunkNotFound(hunk_id.to_string()))?;
    let hunk = proposals::accept(&space, p)?;
    remember_accepted(vela, id, &[hunk_id.to_string()])?;
    let mut rejected = rejected;
    if rejected.remove(hunk_id) {
        save_rejected(vela, id, &rejected)?;
    }
    Ok(hunk)
}

/// The commit graph and branch state of each repo of the space (Git view).
pub fn git_history(vela: &Vela, id: &str) -> AppResult<Vec<vela_core::history::RepoHistory>> {
    Ok(vela_core::history::space_history(&load(vela, id)?, 120)?)
}

// ---------------------------------------------------------------------------
// Review, file by file
// ---------------------------------------------------------------------------

/// One file as the Review shows it: your file now, the file you get when you accept, and the
/// file at the last commit. Accepting writes `result` (or what you made of it) and stages it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileReview {
    pub repo: String,
    pub path: String,
    /// Your file now; None when it does not exist.
    pub mine: Option<String>,
    /// Your file with every pending proposal merged in (conflict markers where you both changed
    /// the same lines); None when accepting deletes the file.
    pub result: Option<String>,
    /// The file at the last commit; None when it is new.
    pub head: Option<String>,
    pub conflicts: usize,
    /// Conflicts markers cannot show (a deleted or binary file).
    pub notes: Vec<String>,
    /// Agents with proposals in the file.
    pub agents: Vec<String>,
    /// A side is binary: no text to show.
    pub binary: bool,
}

fn file_proposals(vela: &Vela, space: &Space, repo: &str, path: &str) -> AppResult<Vec<Proposal>> {
    let rejected = rejected_ids(vela, &space.id)?;
    Ok(agent_proposals(vela, space, &rejected, false)?
        .into_iter()
        .filter(|p| p.hunk.repo == repo && p.hunk.path == path)
        .collect())
}

fn merge_of(vela: &Vela, space: &Space, repo: &str, path: &str) -> AppResult<merge::FileMerge> {
    let list = file_proposals(vela, space, repo, path)?;
    let entries = registry::load(vela, &space.id)?;
    let refs: Vec<&Proposal> = list.iter().collect();
    Ok(merge::merge_file(space, &entries, repo, path, &refs)?)
}

/// What accepting one file gives, for the Review to show before anything is written.
pub fn review_file(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<FileReview> {
    let space = load(vela, id)?;
    resolve_path(&space, repo, path)?;
    let wt = space
        .repos
        .iter()
        .find(|r| r.name == repo)
        .map(|r| PathBuf::from(&r.worktree))
        .ok_or_else(|| vela_core::Error::RepoNotFound(repo.to_string()))?;
    let m = merge_of(vela, &space, repo, path)?;
    let head = merge::show(&wt, "HEAD", path);
    let binary = m.mine.is_binary() || m.result.is_binary() || head.is_binary();
    Ok(FileReview {
        repo: repo.to_string(),
        path: path.to_string(),
        mine: m.mine.text().map(str::to_string),
        result: m.result.text().map(str::to_string),
        head: head.text().map(str::to_string),
        conflicts: m.conflicts,
        notes: m.notes,
        agents: m.agents,
        binary,
    })
}

/// Accept one file: write `content` (what you made of the result in the Review) or the merged
/// result as it is, mark its proposals decided, and stage the file. Refused while conflict
/// markers are left, so nothing half merged is ever staged.
pub fn accept_file(
    vela: &Vela,
    id: &str,
    repo: &str,
    path: &str,
    content: Option<&str>,
) -> AppResult<()> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    resolve_path(&space, repo, path)?;
    let m = merge_of(vela, &space, repo, path)?;
    let result = match content {
        Some(text) => merge::Content::Text(text.to_string()),
        None if m.conflicts > 0 => {
            return Err(vela_core::Error::Invalid(format!(
                "{path}: {} with your edits. Resolve them in the Review first",
                plural(m.conflicts, "conflict")
            ))
            .into());
        }
        None => m.result.clone(),
    };
    if result.text().is_some_and(merge::has_markers) {
        return Err(vela_core::Error::Invalid(format!(
            "{path} still has conflict markers (<<<<<<< yours … >>>>>>> agent). Keep one side of each first"
        ))
        .into());
    }
    if !m.ids.is_empty() || content.is_some() {
        merge::write_result(&space, repo, path, &result)?;
    }
    remember_accepted(vela, id, &m.ids)?;
    stage::stage_files(&space, &[(repo.to_string(), path.to_string())])?;
    Ok(())
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

/// Accept several files as they are. Files with conflicts are left for you, with the reason.
pub fn accept_files(vela: &Vela, id: &str, files: &[(String, String)]) -> AppResult<Vec<String>> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    let rejected = rejected_ids(vela, id)?;
    let all = agent_proposals(vela, &space, &rejected, false)?;
    let entries = registry::load(vela, id)?;
    let mut skipped = Vec::new();
    let mut taken: Vec<String> = Vec::new();
    let mut stage_list: Vec<(String, String)> = Vec::new();
    for (repo, path) in files {
        resolve_path(&space, repo, path)?;
        let list: Vec<&Proposal> = all
            .iter()
            .filter(|p| &p.hunk.repo == repo && &p.hunk.path == path)
            .collect();
        if !list.is_empty() {
            let m = merge::merge_file(&space, &entries, repo, path, &list)?;
            if m.conflicts > 0 {
                skipped.push(format!(
                    "{path}: {} with your edits",
                    plural(m.conflicts, "conflict")
                ));
                continue;
            }
            merge::write_result(&space, repo, path, &m.result)?;
            taken.extend(m.ids);
        }
        stage_list.push((repo.clone(), path.clone()));
    }
    remember_accepted(vela, id, &taken)?;
    stage::stage_files(&space, &stage_list)?;
    Ok(skipped)
}

/// Reject what the agents propose in one file; your own edits are never touched.
pub fn reject_file(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<usize> {
    let _inv = Invalidate(id);
    let space = load(vela, id)?;
    let list = file_proposals(vela, &space, repo, path)?;
    let mut rejected = rejected_ids(vela, id)?;
    rejected.extend(list.iter().map(|p| p.hunk.id.clone()));
    save_rejected(vela, id, &rejected)?;
    Ok(list.len())
}

// ---------------------------------------------------------------------------
// Repos on disk
// ---------------------------------------------------------------------------

/// Roots from `VELA_REPO_ROOTS` (colon separated), default `~/Work`.
pub fn repo_roots_from_env() -> Vec<PathBuf> {
    roots_from(
        std::env::var("VELA_REPO_ROOTS").ok().as_deref(),
        std::env::var_os("HOME").map(PathBuf::from),
    )
}

pub fn roots_from(env: Option<&str>, home: Option<PathBuf>) -> Vec<PathBuf> {
    match env.filter(|v| !v.trim().is_empty()) {
        Some(v) => v
            .split(':')
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .collect(),
        None => home.map(|h| vec![h.join("Work")]).unwrap_or_default(),
    }
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut v: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            !n.starts_with('.') && n != "node_modules" && n != "target"
        })
        .map(|e| e.path())
        .collect();
    v.sort();
    v
}

/// Directories holding a `.git` directory, two levels below each root.
/// Hidden directories, `node_modules`, `target` and Vela's own worktrees are skipped.
pub fn scan_repos(roots: &[PathBuf], vela_home: &Path) -> Vec<String> {
    let own = fs::canonicalize(vela_home).unwrap_or_else(|_| vela_home.to_path_buf());
    let mut out = BTreeSet::new();
    for root in roots {
        for d1 in subdirs(root) {
            let mut candidates = vec![(d1.clone(), 1)];
            let mut i = 0;
            while i < candidates.len() {
                let (dir, level) = candidates[i].clone();
                i += 1;
                if fs::canonicalize(&dir).is_ok_and(|c| c.starts_with(&own)) {
                    continue;
                }
                if dir.join(".git").is_dir() {
                    out.insert(dir.to_string_lossy().into_owned());
                } else if level < 2 {
                    candidates.extend(subdirs(&dir).into_iter().map(|d| (d, level + 1)));
                }
            }
        }
    }
    out.into_iter().collect()
}

/// Repos the user declared by path, kept in `VELA_HOME/repos.json`.
fn declared_path(vela: &Vela) -> PathBuf {
    vela.home.join("repos.json")
}

pub fn declared_repos(vela: &Vela) -> Vec<String> {
    fs::read_to_string(declared_path(vela))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| Path::new(p).join(".git").exists())
        .collect()
}

/// Declared repos first (most recent first), then the ones found under the repo roots.
pub fn list_repos(vela: &Vela) -> AppResult<Vec<String>> {
    let mut out = declared_repos(vela);
    for r in scan_repos(&repo_roots_from_env(), &vela.home) {
        if !out.contains(&r) {
            out.push(r);
        }
    }
    Ok(out)
}

/// Where new repos go by default: the first repo root (`~/Work` unless `VELA_REPO_ROOTS` says otherwise).
pub fn default_repo_parent() -> String {
    repo_roots_from_env()
        .into_iter()
        .next()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Creates a new git repo `<parent>/<name>` on branch `main` with a README and a first
/// commit (a worktree needs a commit to branch from), then declares it.
/// Returns the repo path.
pub fn create_repo(vela: &Vela, parent: &str, name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty()
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(char::is_control)
    {
        return Err(AppError::invalid(format!("invalid repo name: {name:?}")));
    }
    let parent = expand_home(parent.trim());
    if parent.as_os_str().is_empty() {
        return Err(AppError::invalid("pick a folder for the new repo"));
    }
    let dir = parent.join(name);
    if dir.exists() {
        return Err(AppError::invalid(format!(
            "{} already exists",
            dir.display()
        )));
    }
    fs::create_dir_all(&dir).map_err(|e| AppError::new("io", e.to_string()))?;
    let run = || -> AppResult<()> {
        git(&dir, &["init", "-q", "-b", "main"])?;
        fs::write(dir.join("README.md"), format!("# {name}\n"))
            .map_err(|e| AppError::new("io", e.to_string()))?;
        git(&dir, &["add", "README.md"])?;
        git(&dir, &["commit", "-q", "-m", "chore: initial commit"])?;
        Ok(())
    };
    if let Err(e) = run() {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    let path = fs::canonicalize(&dir)
        .unwrap_or(dir)
        .to_string_lossy()
        .into_owned();
    declare_repo(vela, &path)?;
    Ok(path)
}

fn expand_home(raw: &str) -> PathBuf {
    match raw.strip_prefix('~') {
        Some(rest) => std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join(rest.trim_start_matches('/')),
        None => PathBuf::from(raw),
    }
}

/// Declares a repo by path (`~` expanded). It must be a git clone, not a Vela worktree.
pub fn declare_repo(vela: &Vela, path: &str) -> AppResult<Vec<String>> {
    let raw = path.trim();
    let expanded = expand_home(raw);
    let dir = fs::canonicalize(&expanded)
        .map_err(|_| AppError::invalid(format!("folder not found: {raw}")))?;
    if !dir.join(".git").exists() {
        return Err(AppError::invalid(format!("not a git repo: {raw}")));
    }
    let own = fs::canonicalize(&vela.home).unwrap_or_else(|_| vela.home.clone());
    if dir.starts_with(&own) {
        return Err(AppError::invalid(
            "this folder is a Vela worktree, pick the original clone",
        ));
    }
    let dir = dir.to_string_lossy().into_owned();
    let mut list = declared_repos(vela);
    list.retain(|p| p != &dir);
    list.insert(0, dir);
    fs::create_dir_all(&vela.home).map_err(|e| AppError::new("io", e.to_string()))?;
    let json =
        serde_json::to_string_pretty(&list).map_err(|e| AppError::new("io", e.to_string()))?;
    fs::write(declared_path(vela), json).map_err(|e| AppError::new("io", e.to_string()))?;
    list_repos(vela)
}

// ---------------------------------------------------------------------------
// Tier settings: model and reasoning effort of each tier, per harness (global layer)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TierSetting {
    pub tier: Tier,
    /// None: the harness default model.
    pub model: Option<String>,
    /// None: the harness default effort.
    pub effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTiers {
    pub harness: String,
    pub label: String,
    pub available: bool,
    pub tiers: Vec<TierSetting>,
    /// Model names to suggest (free text is fine too).
    pub models: Vec<String>,
    /// The efforts the harness accepts.
    pub efforts: Vec<String>,
    /// Where the settings are written.
    pub file: Option<String>,
}

/// Efforts each harness accepts (`claude --effort`, codex `model_reasoning_effort`,
/// opencode `--variant`).
pub fn efforts_of(harness: &str) -> Vec<String> {
    let v: &[&str] = match harness {
        "claude" => &["low", "medium", "high", "xhigh", "max"],
        "codex" => &["minimal", "low", "medium", "high", "xhigh"],
        "opencode" => &["minimal", "low", "medium", "high", "max"],
        _ => &[],
    };
    v.iter().map(|s| s.to_string()).collect()
}

/// Model lists, by harness: `opencode models` takes a second or more.
type ModelCache = std::collections::HashMap<String, (std::time::Instant, Vec<String>)>;
static MODELS: std::sync::Mutex<Option<ModelCache>> = std::sync::Mutex::new(None);

/// The models to suggest for a harness, cached for ten minutes.
pub fn agent_models(agents: &AgentManager, harness: &str) -> Vec<String> {
    const TTL: std::time::Duration = std::time::Duration::from_secs(600);
    if let Some((at, list)) = MODELS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(harness).cloned()))
        && at.elapsed() < TTL
    {
        return list;
    }
    let bin = agents
        .harnesses()
        .into_iter()
        .find(|h| h.name == harness)
        .and_then(|h| h.path);
    let list = models_of(harness, bin.as_deref());
    if let Ok(mut g) = MODELS.lock() {
        g.get_or_insert_with(Default::default).insert(
            harness.to_string(),
            (std::time::Instant::now(), list.clone()),
        );
    }
    list
}

fn models_of(harness: &str, bin: Option<&str>) -> Vec<String> {
    match harness {
        "claude" => ["opus", "sonnet", "haiku"].map(String::from).to_vec(),
        // `opencode models` lists provider/model for every configured provider.
        "opencode" => bin
            .and_then(|b| {
                std::process::Command::new(b)
                    .arg("models")
                    .stdin(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .output()
                    .ok()
            })
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|l| l.contains('/') && !l.contains(' '))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The tier settings of every harness Vela drives, from the global config.
pub fn agent_tiers(agents: &AgentManager) -> Vec<HarnessTiers> {
    let dir = agents.config_dir();
    let cfg = config::load_global(dir).config.agents;
    let installed = agents.harnesses();
    vela_agents::tiers::HARNESSES
        .iter()
        .map(|h| {
            let info = installed.iter().find(|i| i.name == *h);
            let models = cfg.tiers.get(*h);
            let efforts = cfg.effort.get(*h);
            HarnessTiers {
                harness: h.to_string(),
                label: vela_agents::tiers::harness_label(h).to_string(),
                available: info.is_some_and(|i| i.available),
                tiers: Tier::ALL
                    .into_iter()
                    .map(|t| TierSetting {
                        tier: t,
                        model: models.and_then(|m| m.get(t)).map(str::to_string),
                        effort: efforts.and_then(|m| m.get(t)).map(str::to_string),
                    })
                    .collect(),
                // Cheap ones now; opencode's list comes from `agent_models`.
                models: if *h == "opencode" {
                    Vec::new()
                } else {
                    models_of(h, None)
                },
                efforts: efforts_of(h),
                file: dir.map(|d| config::global_file(d).to_string_lossy().into_owned()),
            }
        })
        .collect()
}

/// Set the model and effort of one tier of a harness. Empty or None goes back to the default.
pub fn set_agent_tier(
    agents: &AgentManager,
    harness: &str,
    tier: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> AppResult<()> {
    if !vela_agents::tiers::HARNESSES.contains(&harness) {
        return Err(AppError::invalid(format!("unknown harness: {harness}")));
    }
    if !Tier::ALL.iter().any(|t| t.as_str() == tier) {
        return Err(AppError::invalid(format!("unknown tier: {tier}")));
    }
    let dir = agents
        .config_dir()
        .ok_or_else(|| AppError::invalid("no config directory (set XDG_CONFIG_HOME or HOME)"))?;
    let val = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| toml::Value::String(s.to_string()))
    };
    if let Some(e) = effort.map(str::trim).filter(|e| !e.is_empty())
        && !efforts_of(harness).iter().any(|x| x == e)
    {
        return Err(AppError::invalid(format!(
            "{e} is not an effort {} knows ({})",
            vela_agents::tiers::harness_label(harness),
            efforts_of(harness).join(", ")
        )));
    }
    config::set_global_value(dir, &["agents", "tiers", harness, tier], val(model))?;
    config::set_global_value(dir, &["agents", "effort", harness, tier], val(effort))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Reviewer notes
// ---------------------------------------------------------------------------

/// The notes of the reviewer and security agents, tied to the hunks they fall in.
pub fn notes(vela: &Vela, agents: &AgentManager, id: &str) -> AppResult<Vec<Note>> {
    let space = load(vela, id)?;
    let entries = agents.entries(vela, id)?;
    let mut entries = entries;
    entries.reverse();
    let all = hunks(vela, id)?;
    Ok(vela_agents::notes::notes(vela, &space, &entries, &all))
}

/// `F`: send a note to the agent that wrote the hunk (or a new developer agent) for a fix.
pub fn ask_fix(
    vela: &Vela,
    agents: &std::sync::Arc<AgentManager>,
    id: &str,
    note_id: &str,
    emit: &EmitAgent,
) -> AppResult<Agent> {
    let space = load(vela, id)?;
    let note = notes(vela, agents, id)?
        .into_iter()
        .find(|n| n.id == note_id)
        .ok_or_else(|| AppError::invalid("this note is gone"))?;
    if note.busy {
        return Err(AppError::invalid("a fix is already on its way"));
    }
    let author = hunks(vela, id)?
        .into_iter()
        .find(|h| !note.hunk_id.is_empty() && h.id == note.hunk_id)
        .and_then(|h| match h.origin {
            vela_core::model::Origin::Agent { agent } => Some(agent),
            _ => None,
        });
    Ok(agents.ask_fix(vela, &space, &note, author.as_deref(), emit)?)
}

// ---------------------------------------------------------------------------
// Review comments
// ---------------------------------------------------------------------------

/// The comment threads of the space, with the answers of their agents.
pub fn comments(
    vela: &Vela,
    agents: &AgentManager,
    id: &str,
) -> AppResult<Vec<vela_agents::comments::CommentView>> {
    load(vela, id)?;
    let entries = agents.entries(vela, id)?;
    Ok(vela_agents::comments::views(vela, id, &entries))
}

/// Where a new comment goes and what it says.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewComment {
    pub repo: String,
    pub path: String,
    pub line: u32,
    #[serde(default)]
    pub hunk_id: String,
    pub text: String,
    /// "reviewer" or "developer".
    pub role: AgentRole,
}

/// A comment on a line: an agent answers it (a developer may also change the code).
pub fn add_comment(
    vela: &Vela,
    agents: &std::sync::Arc<AgentManager>,
    id: &str,
    c: &NewComment,
    emit: &EmitAgent,
) -> AppResult<()> {
    let space = load(vela, id)?;
    resolve_path(&space, &c.repo, &c.path)?;
    let hunk = if c.hunk_id.is_empty() {
        None
    } else {
        hunks(vela, id)?.into_iter().find(|h| h.id == c.hunk_id)
    };
    let code: String = hunk
        .as_ref()
        .map(|h| {
            h.lines
                .iter()
                .map(|l| {
                    let s = match l.kind {
                        vela_core::model::LineKind::Add => "+",
                        vela_core::model::LineKind::Del => "-",
                        _ => " ",
                    };
                    format!("{s}{}\n", l.text)
                })
                .collect()
        })
        .unwrap_or_default();
    let author = hunk.and_then(|h| match h.origin {
        vela_core::model::Origin::Agent { agent } => Some(agent),
        _ => None,
    });
    agents.comment(
        vela,
        &space,
        (&c.repo, &c.path, c.line, &c.hunk_id),
        &code,
        &c.text,
        c.role,
        author.as_deref(),
        emit,
    )?;
    Ok(())
}

/// The user answers in a thread.
pub fn reply_comment(
    vela: &Vela,
    agents: &std::sync::Arc<AgentManager>,
    id: &str,
    thread: &str,
    text: &str,
    emit: &EmitAgent,
) -> AppResult<()> {
    let space = load(vela, id)?;
    Ok(agents.reply_comment(vela, &space, thread, text, emit)?)
}

/// Close a thread, or open it again.
pub fn resolve_comment(vela: &Vela, id: &str, thread: &str, resolved: bool) -> AppResult<()> {
    load(vela, id)?;
    let mut list = vela_agents::comments::load(vela, id);
    let t = list
        .iter_mut()
        .find(|t| t.id == thread)
        .ok_or_else(|| AppError::invalid("this comment is gone"))?;
    t.resolved = resolved;
    Ok(vela_agents::comments::save(vela, id, &list)?)
}

/// Delete a thread (the agent and its work stay).
pub fn delete_comment(vela: &Vela, id: &str, thread: &str) -> AppResult<()> {
    load(vela, id)?;
    let mut list = vela_agents::comments::load(vela, id);
    list.retain(|t| t.id != thread);
    Ok(vela_agents::comments::save(vela, id, &list)?)
}

/// `Y` on a note: mark it resolved (or open again).
pub fn resolve_note(vela: &Vela, id: &str, note_id: &str, resolved: bool) -> AppResult<()> {
    load(vela, id)?;
    let mut st = vela_agents::notes::load_state(vela, id);
    if resolved {
        st.resolved.insert(note_id.to_string());
    } else {
        st.resolved.remove(note_id);
        st.fixers.remove(note_id);
    }
    vela_agents::notes::save_state(vela, id, &st)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Agent prompts: the brief each role gets before the request (global layer)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RolePrompt {
    pub role: AgentRole,
    /// The built in brief.
    pub default: String,
    /// The user's brief from the global config, None when the default is used.
    pub custom: Option<String>,
    /// The roles that report notes get the NOTE format appended.
    pub notes: bool,
}

pub fn agent_prompts(agents: &AgentManager) -> Vec<RolePrompt> {
    let cfg = config::load_global(agents.config_dir()).config.agents;
    AgentRole::ALL
        .into_iter()
        .map(|r| RolePrompt {
            role: r,
            default: vela_agents::manager::role_brief(r).to_string(),
            custom: cfg
                .prompts
                .get(r.as_str())
                .filter(|p| !p.trim().is_empty())
                .cloned(),
            notes: vela_agents::notes::reports_notes(r),
        })
        .collect()
}

/// Set the brief of a role; None or blank goes back to the built in one.
pub fn set_agent_prompt(agents: &AgentManager, role: &str, text: Option<&str>) -> AppResult<()> {
    let role =
        AgentRole::parse(role).ok_or_else(|| AppError::invalid(format!("unknown role: {role}")))?;
    let dir = agents
        .config_dir()
        .ok_or_else(|| AppError::invalid("no config directory (set XDG_CONFIG_HOME or HOME)"))?;
    let value = text
        .map(str::trim)
        .filter(|t| !t.is_empty() && *t != vela_agents::manager::role_brief(role))
        .map(|t| toml::Value::String(t.to_string()));
    config::set_global_value(dir, &["agents", "prompts", role.as_str()], value)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

/// The branches of a repo (a path, `~` allowed): local ones newest first, then remote ones.
pub fn repo_branches(path: &str) -> AppResult<Vec<vela_core::branches::BranchInfo>> {
    let p = expand_home(path);
    Ok(vela_core::branches::list(&p)?)
}

/// The branch template and what it gives for `name`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchNaming {
    pub template: String,
    pub preview: String,
}

pub fn branch_naming(dir: Option<&Path>, name: &str) -> BranchNaming {
    let template = config::load_global(dir)
        .config
        .spaces
        .branch
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| vela_core::branches::DEFAULT_TEMPLATE.to_string());
    let preview = vela_core::branches::render(
        &template,
        if name.trim().is_empty() {
            "my task"
        } else {
            name
        },
    );
    BranchNaming { template, preview }
}

/// Save the branch template of new spaces (empty: back to `feat/{slug}`).
pub fn set_branch_template(dir: Option<&Path>, template: &str) -> AppResult<BranchNaming> {
    let dir =
        dir.ok_or_else(|| AppError::invalid("no config directory (set XDG_CONFIG_HOME or HOME)"))?;
    let t = template.trim();
    let value = (!t.is_empty() && t != vela_core::branches::DEFAULT_TEMPLATE)
        .then(|| toml::Value::String(t.to_string()));
    config::set_global_value(dir, &["spaces", "branch"], value)?;
    Ok(branch_naming(Some(dir), "my task"))
}

/// Rename the branch of a space (and of its agents) in every repo.
pub fn rename_branch(vela: &Vela, id: &str, branch: &str) -> AppResult<Space> {
    let _inv = Invalidate(id);
    Ok(vela_core::branches::rename(vela, id, branch)?)
}

/// Push the branch of the space in every repo (`git push -u origin <branch>`). Returns the
/// repos pushed; the first failure stops with its message.
pub fn push_branch(vela: &Vela, id: &str) -> AppResult<Vec<String>> {
    let space = load(vela, id)?;
    let mut done = Vec::new();
    for r in &space.repos {
        let wt = Path::new(&r.worktree);
        git(wt, &["push", "-u", "origin", &space.branch])
            .map_err(|e| AppError::new("git", format!("{}: push failed: {e}", r.name)))?;
        done.push(r.name.clone());
    }
    Ok(done)
}
