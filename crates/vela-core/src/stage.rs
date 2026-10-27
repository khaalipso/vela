//! Stage and unstage single hunks or whole files.

use std::path::Path;

use crate::diff::{staged_files, unstaged_files};
use crate::error::{Error, Result};
use crate::git::{git, git_with};
use crate::model::Space;

fn repo_dir<'a>(space: &'a Space, repo: &str) -> Result<&'a Path> {
    space
        .repos
        .iter()
        .find(|r| r.name == repo)
        .map(|r| Path::new(r.worktree.as_str()))
        .ok_or_else(|| Error::RepoNotFound(repo.to_string()))
}

fn apply(dir: &Path, extra: &[&str], patch: &str) -> Result<()> {
    let mut args = vec!["apply", "--cached"];
    args.extend_from_slice(extra);
    git_with(dir, &args, &[], Some(patch)).map_err(|e| match e {
        Error::Git { stderr, .. } => Error::PatchFailed(stderr),
        other => other,
    })?;
    Ok(())
}

/// Stage one unstaged hunk: a minimal patch (file header + that hunk) goes to
/// `git apply --cached`. Untracked files are added whole with `git add`.
pub fn stage_hunk(space: &Space, hunk_id: &str) -> Result<()> {
    for f in unstaged_files(space)? {
        for h in &f.hunks {
            if h.hunk.id != hunk_id {
                continue;
            }
            let dir = repo_dir(space, &f.repo)?;
            if h.untracked {
                git(dir, &["add", "--", &f.path])?;
            } else {
                apply(dir, &[], &format!("{}{}", f.header, h.raw))?;
            }
            return Ok(());
        }
    }
    Err(Error::HunkNotFound(hunk_id.to_string()))
}

/// Unstage one staged hunk with `git apply --cached -R`. A hunk that creates a
/// whole new file is unstaged with `git rm --cached` (the file turns untracked).
pub fn unstage_hunk(space: &Space, hunk_id: &str) -> Result<()> {
    for f in staged_files(space)? {
        for h in &f.hunks {
            if h.hunk.id != hunk_id {
                continue;
            }
            let dir = repo_dir(space, &f.repo)?;
            if f.is_new {
                git(dir, &["rm", "--cached", "-q", "-f", "--", &f.path])?;
            } else {
                apply(dir, &["-R"], &format!("{}{}", f.header, h.raw))?;
            }
            return Ok(());
        }
    }
    Err(Error::HunkNotFound(hunk_id.to_string()))
}

/// Stage several unstaged hunks with one diff of the space and one `git apply` per file.
/// Returns the ids that were not found among the unstaged hunks.
pub fn stage_hunks(space: &Space, hunk_ids: &[String]) -> Result<Vec<String>> {
    let mut missing: Vec<String> = hunk_ids.to_vec();
    for f in unstaged_files(space)? {
        let picked: Vec<_> = f
            .hunks
            .iter()
            .filter(|h| hunk_ids.contains(&h.hunk.id))
            .collect();
        if picked.is_empty() {
            continue;
        }
        missing.retain(|id| !picked.iter().any(|h| &h.hunk.id == id));
        let dir = repo_dir(space, &f.repo)?;
        if picked.iter().any(|h| h.untracked) {
            git(dir, &["add", "--", &f.path])?;
            continue;
        }
        let body: String = picked.iter().map(|h| h.raw.as_str()).collect();
        apply(dir, &[], &format!("{}{}", f.header, body))?;
    }
    Ok(missing)
}

/// Stage every change of several files: one `git add` per repo. A path that is neither on
/// disk nor known to git (nothing to stage) is skipped instead of failing the lot.
pub fn stage_files(space: &Space, files: &[(String, String)]) -> Result<()> {
    for (repo, paths) in by_repo(files) {
        let dir = repo_dir(space, &repo)?;
        let mut args = vec!["add", "-A", "--"];
        let known: Vec<&String> = paths
            .iter()
            .filter(|p| {
                dir.join(p).exists()
                    || git(dir, &["ls-files", "--", p]).is_ok_and(|o| !o.trim().is_empty())
            })
            .collect();
        if known.is_empty() {
            continue;
        }
        args.extend(known.iter().map(|p| p.as_str()));
        git(dir, &args)?;
    }
    Ok(())
}

/// Unstage every staged change of several files: one `git restore` per repo.
pub fn unstage_files(space: &Space, files: &[(String, String)]) -> Result<()> {
    for (repo, paths) in by_repo(files) {
        let mut args = vec!["restore", "--staged", "--"];
        args.extend(paths.iter().map(String::as_str));
        git(repo_dir(space, &repo)?, &args)?;
    }
    Ok(())
}

fn by_repo(files: &[(String, String)]) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for (repo, path) in files {
        match out.iter_mut().find(|(r, _)| r == repo) {
            Some((_, v)) => v.push(path.clone()),
            None => out.push((repo.clone(), vec![path.clone()])),
        }
    }
    out
}

/// Stage every change of one file (including deletion and untracked).
pub fn stage_file(space: &Space, repo: &str, path: &str) -> Result<()> {
    git(repo_dir(space, repo)?, &["add", "-A", "--", path])?;
    Ok(())
}

/// Unstage every staged change of one file.
pub fn unstage_file(space: &Space, repo: &str, path: &str) -> Result<()> {
    git(repo_dir(space, repo)?, &["restore", "--staged", "--", path])?;
    Ok(())
}

fn apply_worktree(dir: &Path, extra: &[&str], patch: &str) -> Result<()> {
    let mut args = vec!["apply"];
    args.extend_from_slice(extra);
    git_with(dir, &args, &[], Some(patch)).map_err(|e| match e {
        Error::Git { stderr, .. } => Error::PatchFailed(stderr),
        other => other,
    })?;
    Ok(())
}

/// Throw away one hunk: its lines go back to what they were.
///
/// - An unstaged hunk is reversed in the worktree (`git apply -R`).
/// - A staged hunk is reversed in the worktree and in the index, so it is gone from both. When
///   the worktree changed the same lines since, nothing is touched and an error says so.
///
/// A new file is refused: deleting a file is not a hunk revert (use discard or delete).
pub fn discard_hunk(space: &Space, hunk_id: &str) -> Result<()> {
    for f in unstaged_files(space)? {
        for h in &f.hunks {
            if h.hunk.id != hunk_id {
                continue;
            }
            if h.untracked {
                return Err(Error::Invalid(format!(
                    "{} is a new file: delete it or discard the file instead",
                    f.path
                )));
            }
            let dir = repo_dir(space, &f.repo)?;
            let patch = format!("{}{}", f.header, h.raw);
            apply_worktree(dir, &["-R", "--check"], &patch)?;
            return apply_worktree(dir, &["-R"], &patch);
        }
    }
    for f in staged_files(space)? {
        for h in &f.hunks {
            if h.hunk.id != hunk_id {
                continue;
            }
            if f.is_new {
                return Err(Error::Invalid(format!(
                    "{} is a new file: delete it or discard the file instead",
                    f.path
                )));
            }
            let dir = repo_dir(space, &f.repo)?;
            let patch = format!("{}{}", f.header, h.raw);
            // Both sides must take the reverse patch before either is changed.
            apply_worktree(dir, &["-R", "--check"], &patch).map_err(|_| {
                Error::Invalid(
                    "these lines changed again in your worktree since they were staged: \
                     unstage the hunk first"
                        .to_string(),
                )
            })?;
            apply(dir, &["-R", "--check"], &patch)?;
            apply_worktree(dir, &["-R"], &patch)?;
            return apply(dir, &["-R"], &patch);
        }
    }
    Err(Error::HunkNotFound(hunk_id.to_string()))
}
