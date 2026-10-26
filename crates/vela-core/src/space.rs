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

struct Created {
    source: PathBuf,
    worktree: PathBuf,
    branch: String,
}

fn rollback(created: &[Created], root: &Path) {
    for c in created.iter().rev() {
        let wt = c.worktree.to_string_lossy();
        let _ = git(&c.source, &["worktree", "remove", "--force", wt.as_ref()]);
        let _ = git(&c.source, &["branch", "-D", &c.branch]);
        let _ = git(&c.source, &["worktree", "prune"]);
    }
    let _ = fs::remove_dir_all(root);
}

fn dir_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string())
}

/// Create a space: branch `feat/<slug>` and one worktree per repo.
///
/// `base` is the ref to branch from; defaults to each repo's current branch.
/// If any repo fails, worktrees and branches created so far are removed.
pub fn create<P: AsRef<Path>>(
    vela: &Vela,
    name: &str,
    repo_paths: &[P],
    base: Option<&str>,
) -> Result<Space> {
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
    // Validate everything before touching the disk.
    let mut sources: Vec<(String, PathBuf, String)> = Vec::new();
    for p in repo_paths {
        let p = p.as_ref();
        let top = git(p, &["rev-parse", "--show-toplevel"])
            .map_err(|_| Error::NotARepo(p.to_path_buf()))?;
        let top = PathBuf::from(top.trim());
        let base_ref = match base {
            Some(b) => b.to_string(),
            None => current_ref(&top)?,
        };
        let stem = dir_name(&top);
        let mut repo_name = stem.clone();
        let mut n = 2;
        while sources
            .iter()
            .any(|(existing, _, _)| *existing == repo_name)
        {
            repo_name = format!("{stem}-{n}");
            n += 1;
        }
        sources.push((repo_name, top, base_ref));
    }

    let branch = format!("feat/{id}");
    let root = paths::space_root(&vela.home, &id);
    fs::create_dir_all(&root)?;
    let mut created: Vec<Created> = Vec::new();
    let mut repos = Vec::new();
    for (repo_name, source, base_ref) in &sources {
        let worktree = paths::space_worktree(&vela.home, &id, repo_name);
        let wt = worktree.to_string_lossy();
        match git(
            source,
            &["worktree", "add", "-b", &branch, wt.as_ref(), base_ref],
        ) {
            Ok(_) => created.push(Created {
                source: source.clone(),
                worktree: worktree.clone(),
                branch: branch.clone(),
            }),
            Err(e) => {
                rollback(&created, &root);
                return Err(e);
            }
        }
        repos.push(SpaceRepo {
            name: repo_name.clone(),
            source: source.to_string_lossy().into_owned(),
            worktree: worktree.to_string_lossy().into_owned(),
            base: base_ref.clone(),
        });
    }

    let count = store::list(vela).map(|l| l.len()).unwrap_or(0);
    let space = Space {
        id,
        name: name.to_string(),
        color: PALETTE[count % PALETTE.len()].to_string(),
        branch,
        repos,
        created_at: rfc3339(SystemTime::now()),
        window: None,
        archived: false,
        links: Vec::new(),
    };
    if let Err(e) = store::save(vela, &space) {
        rollback(&created, &root);
        return Err(e);
    }
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

/// Remove worktrees (forced), delete the branch where fully merged, delete the toml.
pub fn remove(vela: &Vela, id: &str) -> Result<()> {
    let space = store::load(vela, id)?;
    for repo in &space.repos {
        let source = Path::new(&repo.source);
        if Path::new(&repo.worktree).exists() {
            git(source, &["worktree", "remove", "--force", &repo.worktree])?;
        }
        let _ = git(source, &["worktree", "prune"]);
        // `-d` refuses unmerged branches, which is what we want.
        let _ = git(source, &["branch", "-d", &space.branch]);
    }
    let _ = fs::remove_dir_all(paths::space_root(&vela.home, id));
    store::delete(vela, id)
}

/// Add a repo to an existing space: a worktree on the space branch, created from the
/// repo's current branch (or the existing space branch if the repo already has it).
pub fn add_repo(vela: &Vela, id: &str, repo_path: &Path) -> Result<Space> {
    let mut space = store::load(vela, id)?;
    let top = git(repo_path, &["rev-parse", "--show-toplevel"])
        .map_err(|_| Error::NotARepo(repo_path.to_path_buf()))?;
    let top = PathBuf::from(top.trim());
    let top_s = top.to_string_lossy().into_owned();
    if space.repos.iter().any(|r| r.source == top_s) {
        return Err(Error::Invalid(format!(
            "{} is already in this space",
            dir_name(&top)
        )));
    }
    let stem = dir_name(&top);
    let mut repo_name = stem.clone();
    let mut n = 2;
    while space.repos.iter().any(|r| r.name == repo_name) {
        repo_name = format!("{stem}-{n}");
        n += 1;
    }
    let base_ref = current_ref(&top)?;
    let worktree = paths::space_worktree(&vela.home, &space.id, &repo_name);
    let wt = worktree.to_string_lossy().into_owned();
    let has_branch = git(
        &top,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{}", space.branch),
        ],
    )
    .is_ok();
    if has_branch {
        git(&top, &["worktree", "add", &wt, &space.branch])?;
    } else {
        git(
            &top,
            &["worktree", "add", "-b", &space.branch, &wt, &base_ref],
        )?;
    }
    space.repos.push(SpaceRepo {
        name: repo_name,
        source: top_s,
        worktree: wt,
        base: base_ref,
    });
    store::save(vela, &space)?;
    Ok(space)
}

/// Remove a repo from a space. Its worktree is removed; git refuses when it has
/// uncommitted changes, so nothing is lost. The branch is kept.
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
    git(Path::new(&r.source), &["worktree", "remove", &r.worktree])?;
    space.repos.remove(i);
    store::save(vela, &space)?;
    Ok(space)
}
