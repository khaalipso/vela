//! `git status` as [`FileChange`]s.

use std::path::Path;

use crate::error::{Error, Result};
use crate::git::git;
use crate::model::{ChangeKind, FileChange, Space};

fn kind(c: char) -> Option<ChangeKind> {
    match c {
        'A' | 'C' => Some(ChangeKind::Added),
        'M' | 'T' => Some(ChangeKind::Modified),
        'D' => Some(ChangeKind::Deleted),
        'R' => Some(ChangeKind::Renamed),
        _ => None,
    }
}

fn xy(field: &str, rec: &str) -> Result<(Option<ChangeKind>, Option<ChangeKind>)> {
    let mut it = field.chars();
    match (it.next(), it.next()) {
        (Some(x), Some(y)) => Ok((kind(x), kind(y))),
        _ => Err(Error::Parse(format!("status record: {rec:?}"))),
    }
}

/// Parse `git status --porcelain=v2 -z --untracked-files=all` output.
pub fn parse_porcelain_v2(repo: &str, out: &str) -> Result<Vec<FileChange>> {
    let mut changes = Vec::new();
    let mut records = out.split('\0').filter(|r| !r.is_empty());
    while let Some(rec) = records.next() {
        let bad = || Error::Parse(format!("status record: {rec:?}"));
        let change = |path: &str, from: Option<&str>, s, u| FileChange {
            repo: repo.to_string(),
            path: path.to_string(),
            from: from.map(str::to_string),
            staged: s,
            unstaged: u,
        };
        match rec.chars().next() {
            Some('1') => {
                let parts: Vec<&str> = rec.splitn(9, ' ').collect();
                if parts.len() < 9 {
                    return Err(bad());
                }
                let (s, u) = xy(parts[1], rec)?;
                changes.push(change(parts[8], None, s, u));
            }
            Some('2') => {
                let parts: Vec<&str> = rec.splitn(10, ' ').collect();
                if parts.len() < 10 {
                    return Err(bad());
                }
                let from = records.next().ok_or_else(bad)?;
                let (s, u) = xy(parts[1], rec)?;
                changes.push(change(parts[9], Some(from), s, u));
            }
            Some('u') => {
                let parts: Vec<&str> = rec.splitn(11, ' ').collect();
                if parts.len() < 11 {
                    return Err(bad());
                }
                changes.push(change(parts[10], None, None, Some(ChangeKind::Conflicted)));
            }
            Some('?') => {
                let path = rec.get(2..).ok_or_else(bad)?;
                changes.push(change(path, None, None, Some(ChangeKind::Untracked)));
            }
            // '!' ignored files and '#' headers are not changes.
            _ => {}
        }
    }
    Ok(changes)
}

/// Status of one worktree directory.
pub fn repo_status(repo: &str, dir: &Path) -> Result<Vec<FileChange>> {
    let out = git(
        dir,
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    )?;
    parse_porcelain_v2(repo, &out)
}

/// Status of every repo of the space.
pub fn space_status(space: &Space) -> Result<Vec<FileChange>> {
    let mut all = Vec::new();
    for r in &space.repos {
        all.extend(repo_status(&r.name, Path::new(&r.worktree))?);
    }
    Ok(all)
}
