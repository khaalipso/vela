//! Creating, archiving and removing spaces.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::Vela;
use crate::error::{Error, Result};
use crate::git::git;
use crate::model::{Space, SpaceRepo};
use crate::{paths, store};

pub const PALETTE: [&str; 6] = [
    "#E8A14A", "#7DB8F5", "#C9A0F0", "#4ADE80", "#F0A3C0", "#9BD0C8",
];

/// Lowercase ascii, non alphanumerics become single dashes, max 40 chars.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.truncate(40);
    out.trim_end_matches('-').to_string()
}

/// RFC 3339 UTC timestamp of `t` ("2026-10-26T14:03:09Z").
pub fn rfc3339(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// A repo switched to the branch of the new space, to put back if a later repo fails.
struct Switched {
    source: PathBuf,
    /// Where the repo was: a branch name or a commit.
    previous: String,
    branch: String,
    /// The branch was made for this space (a rollback deletes it); an existing one is kept.
    made: bool,
}

fn rollback(switched: &[Switched]) {
    for s in switched.iter().rev() {
        let _ = git(&s.source, &["switch", "--quiet", &s.previous])
            .or_else(|_| git(&s.source, &["switch", "--quiet", "--detach", &s.previous]));
        if s.made {
            let _ = git(&s.source, &["branch", "-D", &s.branch]);
        }
    }
}

/// The repos at `path`: the repo it is in, else the repos directly inside it (a folder of
/// repos adds them all).
pub fn repos_in(path: &Path) -> Result<Vec<PathBuf>> {
    if let Ok(top) = git(path, &["rev-parse", "--show-toplevel"]) {
        return Ok(vec![PathBuf::from(top.trim())]);
    }
    let mut found: Vec<PathBuf> = fs::read_dir(path)
        .map_err(|_| Error::NotARepo(path.to_path_buf()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join(".git").exists())
        .filter_map(|p| p.canonicalize().ok())
        .collect();
    found.sort();
    if found.is_empty() {
        return Err(Error::NotARepo(path.to_path_buf()));
    }
    Ok(found)
}

/// What a new space is made from. Everything left out takes the default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateOptions {
    /// The ref new branches start from; defaults to each repo's current branch.
    pub base: Option<String>,
    /// A branch to switch the repos to. An existing local branch is used as it is; a remote
    /// one (`origin/<branch>`) gets a local branch tracking it; otherwise it is created from
    /// `base`. Left out, each repo stays on the branch it is on.
    pub branch: Option<String>,
    /// A branch for some repos instead of `branch`, in the order of the repo paths (None or
    /// empty: `branch`). Each repo of a space has its own branch.
    pub repo_branches: Vec<Option<String>>,
    /// The ticket of the task ("PAY-412"), for `{ticket}` in the template and the commits.
    pub ticket: Option<String>,
}

fn dir_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string())
}

/// Create a space on the repos at `repo_paths`: it works in them, on the branch they are on.
/// `base` only matters for a new branch (see [`create_with`]).
pub fn create<P: AsRef<Path>>(
    vela: &Vela,
    name: &str,
    repo_paths: &[P],
    base: Option<&str>,
) -> Result<Space> {
    create_with(
        vela,
        name,
        repo_paths,
        &CreateOptions {
            base: base.map(str::to_string),
            ..CreateOptions::default()
        },
    )
}

fn checked_branch(b: &str) -> Result<String> {
    if !crate::branches::is_valid(b) {
        return Err(Error::Invalid(format!("{b} is not a valid branch name")));
    }
    Ok(b.to_string())
}

/// Switch the clone `source` to `branch`: the existing local branch, a local branch tracking
/// the remote one, or a new branch from `base`. Uncommitted changes go along (git refuses when
/// they would be overwritten). True when the branch was made.
fn switch_to(source: &Path, branch: &str, base: &str) -> Result<bool> {
    if crate::git::head_branch(source).as_deref() == Some(branch) {
        return Ok(false);
    }
    let src = crate::branches::source_of(source, branch, base);
    let made = !matches!(src, crate::branches::Source::Local);
    match &src {
        crate::branches::Source::Local => git(source, &["switch", "--quiet", branch]),
        crate::branches::Source::Remote { upstream } => git(
            source,
            &["switch", "--quiet", "--track", "-c", branch, upstream],
        ),
        crate::branches::Source::New { base } => {
            git(source, &["switch", "--quiet", "-c", branch, base])
        }
    }?;
    Ok(made)
}

/// A branch checked out in another worktree cannot be switched to: say where.
fn refuse_if_checked_out_elsewhere(source: &Path, repo_name: &str, branch: &str) -> Result<()> {
    if let Some(path) = crate::branches::checked_out_in(source, branch)
        && Path::new(&path) != source
    {
        return Err(Error::Invalid(format!(
            "{branch} is checked out in {path} ({repo_name}): switch that checkout to another branch first"
        )));
    }
    Ok(())
}

/// A unique short name for the repo at `top` among `taken`.
fn unique_name(top: &Path, taken: &[&str]) -> String {
    let stem = dir_name(top);
    let mut name = stem.clone();
    let mut n = 2;
    while taken.contains(&name.as_str()) {
        name = format!("{stem}-{n}");
        n += 1;
    }
    name
}

/// Create a space on the repos at `repo_paths` (a folder of repos gives each of them). The
/// space works in your clones: no copy. Repos stay on their branch unless `opts` names one,
/// then they are switched to it. If any repo fails, the ones switched so far go back.
pub fn create_with<P: AsRef<Path>>(
    vela: &Vela,
    name: &str,
    repo_paths: &[P],
    opts: &CreateOptions,
) -> Result<Space> {
    let base = opts.base.as_deref().filter(|b| !b.trim().is_empty());
    let id = slugify(name);
    if id.is_empty() {
        return Err(Error::InvalidName(name.to_string()));
    }
    if repo_paths.is_empty() {
        return Err(Error::NoRepos);
    }
    if store::exists(vela, &id) {
        return Err(Error::SpaceExists(id));
    }
    let ticket = match opts.ticket.as_deref() {
        Some(t) => clean_ticket(t)?,
        None => None,
    };
    let branch = match opts
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        Some(b) => Some(checked_branch(b)?),
        None => None,
    };
    // Validate everything before touching the disk.
    // (repo name, clone, base ref, branch to switch to)
    let mut sources: Vec<(String, PathBuf, String, Option<String>)> = Vec::new();
    for (i, p) in repo_paths.iter().enumerate() {
        let wanted = match opts
            .repo_branches
            .get(i)
            .and_then(|b| b.as_deref())
            .map(str::trim)
            .filter(|b| !b.is_empty())
        {
            Some(b) => Some(checked_branch(b)?),
            None => branch.clone(),
        };
        for top in repos_in(p.as_ref())? {
            if sources.iter().any(|(_, t, ..)| *t == top) {
                continue;
            }
            let base_ref = match base {
                Some(b) => b.to_string(),
                None => current_ref(&top)?,
            };
            let taken: Vec<&str> = sources.iter().map(|(n, ..)| n.as_str()).collect();
            let repo_name = unique_name(&top, &taken);
            sources.push((repo_name, top, base_ref, wanted.clone()));
        }
    }
    for (repo_name, source, _, b) in &sources {
        if let Some(b) = b {
            refuse_if_checked_out_elsewhere(source, repo_name, b)?;
        }
    }
    let mut switched: Vec<Switched> = Vec::new();
    let mut repos = Vec::new();
    for (repo_name, source, base_ref, wanted) in &sources {
        if let Some(b) = wanted {
            let previous = current_ref(source)?;
            match switch_to(source, b, base_ref) {
                Ok(made) => switched.push(Switched {
                    source: source.clone(),
                    previous,
                    branch: b.clone(),
                    made,
                }),
                Err(e) => {
                    rollback(&switched);
                    return Err(e);
                }
            }
        }
        let on = crate::git::head_branch(source).unwrap_or_else(|| base_ref.clone());
        let path = source.to_string_lossy().into_owned();
        repos.push(SpaceRepo {
            name: repo_name.clone(),
            source: path.clone(),
            worktree: path,
            base: base_ref.clone(),
            branch: on,
        });
    }

    let count = store::list(vela).map(|l| l.len()).unwrap_or(0);
    let space = Space {
        id,
        name: name.to_string(),
        color: PALETTE[count % PALETTE.len()].to_string(),
        branch: branch.unwrap_or_else(|| repos[0].branch.clone()),
        repos,
        created_at: rfc3339(SystemTime::now()),
        window: None,
        archived: false,
        links: Vec::new(),
        ticket,
    };
    let saved = fs::create_dir_all(paths::space_root(&vela.home, &space.id))
        .map_err(Error::from)
        .and_then(|()| store::save(vela, &space));
    if let Err(e) = saved {
        rollback(&switched);
        return Err(e);
    }
    Ok(space)
}

/// A ticket as stored: trimmed, the key of a tracker URL ("…/browse/PAY-412" gives "PAY-412"),
/// None when empty.
pub fn clean_ticket(ticket: &str) -> Result<Option<String>> {
    let t = ticket.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if t.starts_with("http://") || t.starts_with("https://") {
        if let Some(k) = crate::links::detect_keys(t).into_iter().last() {
            return Ok(Some(k));
        }
        return Err(Error::Invalid(format!("no ticket key in {t}")));
    }
    if t.chars().count() > 64 || t.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(Error::Invalid(format!(
            "{t} is not a ticket: one word such as PAY-412"
        )));
    }
    // "pay-412" is a Jira key typed fast.
    let upper = t.to_ascii_uppercase();
    if crate::links::detect_keys(&upper)
        .first()
        .map(String::as_str)
        == Some(upper.as_str())
    {
        return Ok(Some(upper));
    }
    Ok(Some(t.to_string()))
}

/// Set or clear (empty) the ticket of a space.
pub fn set_ticket(vela: &Vela, id: &str, ticket: &str) -> Result<Space> {
    let mut space = store::load(vela, id)?;
    space.ticket = clean_ticket(ticket)?;
    store::save(vela, &space)?;
    Ok(space)
}

fn current_ref(repo: &Path) -> Result<String> {
    let branch = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = branch.trim();
    if branch == "HEAD" {
        // Detached: pin the commit.
        Ok(git(repo, &["rev-parse", "HEAD"])?.trim().to_string())
    } else {
        Ok(branch.to_string())
    }
}

/// Flag a space as archived (worktrees stay on disk).
pub fn archive(vela: &Vela, id: &str) -> Result<Space> {
    let mut space = store::load(vela, id)?;
    space.archived = true;
    store::save(vela, &space)?;
    Ok(space)
}

/// Bring an archived space back.
pub fn unarchive(vela: &Vela, id: &str) -> Result<Space> {
    let mut space = store::load(vela, id)?;
    space.archived = false;
    store::save(vela, &space)?;
    Ok(space)
}

/// Change the display name. The id, the branch and the worktree paths stay as they are.
pub fn rename(vela: &Vela, id: &str, name: &str) -> Result<Space> {
    let name = name.trim();
    if name.is_empty() || name.chars().any(char::is_control) {
        return Err(Error::InvalidName(name.to_string()));
    }
    let mut space = store::load(vela, id)?;
    space.name = name.to_string();
    store::save(vela, &space)?;
    Ok(space)
}

/// `#RRGGBB`, upper or lower case.
pub fn is_hex_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Change the accent color of a space (`#RRGGBB`).
pub fn set_color(vela: &Vela, id: &str, color: &str) -> Result<Space> {
    let color = color.trim();
    if !is_hex_color(color) {
        return Err(Error::Invalid(format!("not a #RRGGBB color: {color}")));
    }
    let mut space = store::load(vela, id)?;
    space.color = color.to_ascii_uppercase();
    store::save(vela, &space)?;
    Ok(space)
}

/// Remove a space: the agents' worktrees and branches, and what Vela kept for it. Your clones
/// and their branches stay as they are. (An older space in a Vela worktree loses that worktree;
/// its branch goes when fully merged.)
pub fn remove(vela: &Vela, id: &str) -> Result<()> {
    let space = store::load(vela, id)?;
    let agents_dir = paths::space_root(&vela.home, id).join(".agents");
    for repo in &space.repos {
        let source = Path::new(&repo.source);
        // The agents' worktrees (under the space directory) and their branches
        // `<branch>--<agent>`: their work only ever reached you as proposals.
        if let Ok(list) = git(source, &["worktree", "list", "--porcelain"]) {
            for wt in list.lines().filter_map(|l| l.strip_prefix("worktree ")) {
                if Path::new(wt).starts_with(&agents_dir) {
                    let _ = git(source, &["worktree", "remove", "--force", wt]);
                }
            }
        }
        // `<branch>--<agent>` is how they were named before.
        let ours = format!("refs/heads/{}", paths::agent_branch(id, "*"));
        let old = format!("refs/heads/{}--*", repo.branch);
        if let Ok(refs) = git(
            source,
            &["for-each-ref", "--format=%(refname:short)", &ours, &old],
        ) {
            for b in refs.lines().map(str::trim).filter(|b| !b.is_empty()) {
                let _ = git(source, &["branch", "-D", b]);
            }
        }
        if !repo.is_clone() {
            if Path::new(&repo.worktree).exists() {
                git(source, &["worktree", "remove", "--force", &repo.worktree])?;
            }
            // `-d` refuses unmerged branches, which is what we want.
            let _ = git(source, &["branch", "-d", &repo.branch]);
        }
        let _ = git(source, &["worktree", "prune"]);
    }
    let _ = fs::remove_dir_all(paths::space_root(&vela.home, id));
    crate::page::delete(vela, id);
    store::delete(vela, id)
}

/// Add a repo to an existing space (see [`add_repo_on`]).
pub fn add_repo(vela: &Vela, id: &str, repo_path: &Path) -> Result<Space> {
    add_repo_on(vela, id, repo_path, None)
}

/// Add the repos at `repo_path` (a repo, or a folder of repos) to a space. They stay on their
/// branch, or are switched to `branch` (an existing local or remote branch, else a new one from
/// where the repo is). Repos already in the space are skipped; none new is an error.
pub fn add_repo_on(vela: &Vela, id: &str, repo_path: &Path, branch: Option<&str>) -> Result<Space> {
    let mut space = store::load(vela, id)?;
    let branch = match branch.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => Some(checked_branch(b)?),
        None => None,
    };
    let tops: Vec<PathBuf> = repos_in(repo_path)?
        .into_iter()
        .filter(|t| {
            let t = t.to_string_lossy();
            !space.repos.iter().any(|r| r.source == t)
        })
        .collect();
    if tops.is_empty() {
        return Err(Error::Invalid(format!(
            "{} is already in this space",
            dir_name(repo_path)
        )));
    }
    for top in &tops {
        let taken: Vec<&str> = space.repos.iter().map(|r| r.name.as_str()).collect();
        let repo_name = unique_name(top, &taken);
        let base_ref = current_ref(top)?;
        if let Some(b) = &branch {
            refuse_if_checked_out_elsewhere(top, &repo_name, b)?;
            switch_to(top, b, &base_ref)?;
        }
        let path = top.to_string_lossy().into_owned();
        space.repos.push(SpaceRepo {
            name: repo_name,
            branch: crate::git::head_branch(top).unwrap_or_else(|| base_ref.clone()),
            source: path.clone(),
            worktree: path,
            base: base_ref,
        });
    }
    store::save(vela, &space)?;
    Ok(space)
}

/// Remove a repo from a space. Your clone is not touched. (An older space in a Vela worktree:
/// that worktree is removed, and git refuses when it has uncommitted changes.)
pub fn remove_repo(vela: &Vela, id: &str, repo: &str) -> Result<Space> {
    let mut space = store::load(vela, id)?;
    let i = space
        .repos
        .iter()
        .position(|r| r.name == repo)
        .ok_or_else(|| Error::RepoNotFound(repo.to_string()))?;
    if space.repos.len() == 1 {
        return Err(Error::Invalid(
            "a space needs at least one repo; remove the space instead".to_string(),
        ));
    }
    let r = &space.repos[i];
    if !r.is_clone() {
        git(Path::new(&r.source), &["worktree", "remove", &r.worktree])?;
    }
    space.repos.remove(i);
    store::save(vela, &space)?;
    Ok(space)
}

/// Bring a repo of an older space, still in a Vela worktree, into your clone: its uncommitted
/// work (new files included) is carried over, the worktree goes, and the clone is switched to
/// the branch. The clone must have no uncommitted changes.
pub fn move_into_clone(vela: &Vela, id: &str, repo: &str) -> Result<Space> {
    let mut space = store::load(vela, id)?;
    let i = space
        .repos
        .iter()
        .position(|r| r.name == repo)
        .ok_or_else(|| Error::RepoNotFound(repo.to_string()))?;
    let r = space.repos[i].clone();
    if r.is_clone() {
        return Ok(space);
    }
    let source = Path::new(&r.source);
    let wt = Path::new(&r.worktree);
    if !git(source, &["status", "--porcelain"])?.trim().is_empty() {
        return Err(Error::Invalid(format!(
            "{} has uncommitted changes: commit or stash them first",
            r.source
        )));
    }
    if wt.exists() {
        let branch = crate::git::head_branch(wt).unwrap_or_else(|| r.branch.clone());
        // The stash is shared by every worktree of a repo: it carries the work across.
        let dirty = !git(wt, &["status", "--porcelain"])?.trim().is_empty();
        if dirty {
            let msg = format!("vela: {} moved into {}", space.id, r.source);
            git(wt, &["stash", "push", "--include-untracked", "-m", &msg])?;
        }
        let restore = |e: Error| {
            if dirty {
                let _ = git(wt, &["stash", "pop", "--index"]);
            }
            e
        };
        git(source, &["worktree", "remove", &r.worktree]).map_err(restore)?;
        if let Err(e) = git(source, &["switch", "--quiet", &branch]) {
            let _ = git(source, &["worktree", "add", &r.worktree, &branch]);
            return Err(restore(e));
        }
        if dirty && let Err(e) = git(source, &["stash", "pop", "--index"]) {
            return Err(Error::Invalid(format!(
                "{} is on {branch}, but the uncommitted work did not apply cleanly: it is kept in `git stash list` ({e})",
                r.source
            )));
        }
    }
    space.repos[i].worktree = r.source.clone();
    space.normalize();
    store::save(vela, &space)?;
    Ok(space)
}
