//! The command layer: plain functions over a [`Vela`] handle, testable without a webview.
//! `tauri_cmds.rs` wraps each of them in a thin `#[tauri::command]`.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use vela_core::Vela;
use vela_core::commitplan::{self, GroupCommit};
use vela_core::git::git;
use vela_core::links::{self, IssueConfig};
use vela_core::model::{
    CommitGroup, CommitPlan, CommitRules, FileChange, Hunk, HunkState, Link, LinkSource, Problem,
    RepoFiles, Space, UpNext,
};
use vela_core::{commit as core_commit, diff, files, paths, space, stage, status, store, upnext};

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

/// Create a space with a branch and a worktree per repo path.
pub fn create_space(vela: &Vela, name: &str, repos: &[String]) -> AppResult<Space> {
    Ok(space::create(vela, name, repos, None)?)
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

fn save_rejected(vela: &Vela, id: &str, ids: &BTreeSet<String>) -> AppResult<()> {
    fs::create_dir_all(paths::spaces_dir(&vela.home))?;
    fs::write(rejected_file(vela, id), serde_json::to_string_pretty(ids)?)?;
    Ok(())
}

/// Pending worktree hunks (origin You, minus the rejected ones) and the staged hunks.
pub fn hunks(vela: &Vela, id: &str) -> AppResult<Vec<Hunk>> {
    let space = load(vela, id)?;
    let rejected = rejected_ids(vela, id)?;
    let staged = diff::staged_hunks(&space)?;
    let mut out: Vec<Hunk> = diff::worktree_hunks(&space)?
        .into_iter()
        .filter(|h| !rejected.contains(&h.id) && !staged.iter().any(|s| s.id == h.id))
        .collect();
    out.extend(staged);
    Ok(out)
}

fn find(list: Vec<Hunk>, hunk_id: &str) -> AppResult<Hunk> {
    list.into_iter()
        .find(|h| h.id == hunk_id)
        .ok_or_else(|| vela_core::Error::HunkNotFound(hunk_id.to_string()).into())
}

/// Stage one hunk (also what accepting a proposal does) and return it as staged.
pub fn stage_hunk(vela: &Vela, id: &str, hunk_id: &str) -> AppResult<Hunk> {
    let space = load(vela, id)?;
    let mut hunk = find(diff::worktree_hunks(&space)?, hunk_id)?;
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
    let space = load(vela, id)?;
    let mut rejected = rejected_ids(vela, id)?;
    if rejected.remove(hunk_id) {
        save_rejected(vela, id, &rejected)?;
        let mut h = find(diff::worktree_hunks(&space)?, hunk_id)?;
        h.state = HunkState::Pending;
        return Ok(h);
    }
    stage::unstage_hunk(&space, hunk_id)?;
    let mut h = find(diff::worktree_hunks(&space)?, hunk_id)?;
    h.state = HunkState::Pending;
    Ok(h)
}

/// Hide a pending hunk for good: its id is stored in `spaces/<id>.rejected.json`.
pub fn reject_hunk(vela: &Vela, id: &str, hunk_id: &str) -> AppResult<Hunk> {
    let space = load(vela, id)?;
    let mut h = find(diff::worktree_hunks(&space)?, hunk_id)?;
    let mut rejected = rejected_ids(vela, id)?;
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
    let space = load(vela, id)?;
    resolve_path(&space, repo, path)?;
    Ok(stage::stage_file(&space, repo, path)?)
}

/// Unstage every staged change of one file.
pub fn unstage_file(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<()> {
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
    let space = load(vela, id)?;
    if message.trim().is_empty() {
        return Err(AppError::invalid("empty commit message"));
    }
    let done = core_commit::commit(&space, message)?;
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
    let space = load(vela, id)?;
    let mut groups = groups;
    if let Some(reason) = override_reason.map(str::trim).filter(|r| !r.is_empty()) {
        for g in &mut groups {
            g.footers.push(format!("Vela-Override: {reason}"));
        }
    }
    let commits = commitplan::commit_groups(&space, conventional, &groups)?;
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
    Ok(upnext::up_next(pending, &changes, &[]))
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

/// Declares a repo by path (`~` expanded). It must be a git clone, not a Vela worktree.
pub fn declare_repo(vela: &Vela, path: &str) -> AppResult<Vec<String>> {
    let raw = path.trim();
    let expanded = match raw.strip_prefix("~") {
        Some(rest) => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default();
            home.join(rest.trim_start_matches('/'))
        }
        None => PathBuf::from(raw),
    };
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
