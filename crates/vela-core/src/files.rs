//! The files of every worktree of a space, with their git status, for the file tree.

use std::collections::BTreeMap;
use std::path::Path;

use crate::error::Result;
use crate::git::git;
use crate::model::{ChangeKind, FileChange, RepoFiles, Space, TreeFile};
use crate::status::repo_status;

/// Entries kept per repo; the rest is dropped and `truncated` is set.
pub const MAX_FILES: usize = 200_000;

/// Files of one worktree: tracked and untracked (ignored ones left out), merged with
/// `changes`. The tree shows what is on disk: a file deleted from the worktree leaves it (the
/// Review lists the deletion).
pub fn tree_files(dir: &Path, changes: &[FileChange]) -> Result<(Vec<TreeFile>, bool)> {
    tree_files_capped(dir, changes, MAX_FILES)
}

fn tree_files_capped(
    dir: &Path,
    changes: &[FileChange],
    cap: usize,
) -> Result<(Vec<TreeFile>, bool)> {
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
    let truncated = paths.len() > cap;
    paths.truncate(cap);

    let mut map: BTreeMap<&str, TreeFile> = paths
        .into_iter()
        .map(|p| {
            (
                p,
                TreeFile {
                    path: p.to_string(),
                    staged: None,
                    unstaged: None,
                },
            )
        })
        .collect();
    for c in changes {
        let gone = c.unstaged == Some(ChangeKind::Deleted)
            || (c.staged == Some(ChangeKind::Deleted) && !dir.join(&c.path).exists());
        if gone {
            map.remove(c.path.as_str());
        } else if let Some(f) = map.get_mut(c.path.as_str()) {
            f.staged = c.staged;
            f.unstaged = c.unstaged;
        }
    }
    let mut files: Vec<TreeFile> = map.into_values().collect();
    files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path);
    Ok((files, truncated))
}

fn upstream_counts(dir: &Path) -> (Option<u32>, Option<u32>) {
    let Ok(out) = git(
        dir,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    ) else {
        return (None, None);
    };
    let mut it = out.split_whitespace().map(|n| n.parse::<u32>().ok());
    match (it.next().flatten(), it.next().flatten()) {
        (Some(behind), Some(ahead)) => (Some(ahead), Some(behind)),
        _ => (None, None),
    }
}

/// Files of every repo of the space.
pub fn space_files(space: &Space) -> Result<Vec<RepoFiles>> {
    let mut out = Vec::new();
    for r in &space.repos {
        let dir = Path::new(&r.worktree);
        let changes = repo_status(&r.name, dir)?;
        let (files, truncated) = tree_files(dir, &changes)?;
        let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|b| b.trim().to_string())
            .ok()
            .filter(|b| !b.is_empty() && b != "HEAD")
            .unwrap_or_else(|| r.branch.clone());
        let (ahead, behind) = upstream_counts(dir);
        out.push(RepoFiles {
            repo: r.name.clone(),
            branch,
            worktree: r.worktree.clone(),
            ahead,
            behind,
            files,
            truncated,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SpaceRepo;
    use std::fs;
    use std::path::PathBuf;

    fn sh(dir: &Path, args: &[&str]) {
        let o = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?}");
    }

    fn write(dir: &Path, rel: &str, c: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, c).unwrap();
    }

    fn repo(tmp: &Path) -> (PathBuf, Space) {
        let dir = tmp.join("api");
        fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q", "-b", "main"]);
        sh(&dir, &["config", "user.name", "T"]);
        sh(&dir, &["config", "user.email", "t@e.com"]);
        sh(&dir, &["config", "commit.gpgsign", "false"]);
        write(&dir, ".gitignore", "dist/\n*.log\n");
        write(&dir, "src/a.ts", "a\n");
        write(&dir, "src/b.ts", "b\n");
        write(&dir, "src/old.ts", "old\n");
        write(&dir, "README.md", "r\n");
        sh(&dir, &["add", "-A"]);
        sh(&dir, &["commit", "-q", "-m", "init"]);
        let space = Space {
            id: "t".into(),
            name: "T".into(),
            color: "#fff".into(),
            branch: "feat/t".into(),
            repos: vec![SpaceRepo {
                name: "api".into(),
                source: dir.to_string_lossy().into(),
                worktree: dir.to_string_lossy().into(),
                base: "main".into(),
                branch: String::new(),
            }],
            created_at: String::new(),
            window: None,
            archived: false,
            links: vec![],
            ticket: None,
        };
        (dir, space)
    }

    fn find<'a>(r: &'a RepoFiles, p: &str) -> Option<&'a TreeFile> {
        r.files.iter().find(|f| f.path == p)
    }

    #[test]
    fn ignored_excluded_untracked_included() {
        let tmp = tempfile::tempdir().unwrap();
        let (dir, space) = repo(tmp.path());
        write(&dir, "dist/out.js", "x");
        write(&dir, "debug.log", "x");
        write(&dir, "src/new.ts", "n");
        let r = &space_files(&space).unwrap()[0];
        assert!(find(r, "dist/out.js").is_none());
        assert!(find(r, "debug.log").is_none());
        let n = find(r, "src/new.ts").unwrap();
        assert_eq!(n.unstaged, Some(ChangeKind::Untracked));
        assert_eq!(n.staged, None);
        assert!(!r.truncated);
        assert_eq!(r.branch, "main");
        assert_eq!(r.ahead, None);
        let paths: Vec<&str> = r.files.iter().map(|f| f.path.as_str()).collect();
        let mut sorted = paths.clone();
        sorted.sort_unstable();
        assert_eq!(paths, sorted);
    }

    #[test]
    fn status_is_merged_staged_and_unstaged() {
        let tmp = tempfile::tempdir().unwrap();
        let (dir, space) = repo(tmp.path());
        write(&dir, "src/a.ts", "a2\n");
        sh(&dir, &["add", "src/a.ts"]);
        write(&dir, "src/a.ts", "a3\n");
        write(&dir, "src/b.ts", "b2\n");
        let r = &space_files(&space).unwrap()[0];
        let a = find(r, "src/a.ts").unwrap();
        assert_eq!(a.staged, Some(ChangeKind::Modified));
        assert_eq!(a.unstaged, Some(ChangeKind::Modified));
        let b = find(r, "src/b.ts").unwrap();
        assert_eq!((b.staged, b.unstaged), (None, Some(ChangeKind::Modified)));
        let c = find(r, "README.md").unwrap();
        assert_eq!((c.staged, c.unstaged), (None, None));
    }

    #[test]
    fn deleted_files_leave_the_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let (dir, space) = repo(tmp.path());
        fs::remove_file(dir.join("src/old.ts")).unwrap();
        fs::remove_file(dir.join("src/b.ts")).unwrap();
        sh(&dir, &["rm", "--cached", "-q", "src/b.ts"]);
        // A new file staged, then deleted from disk.
        write(&dir, "src/new.ts", "n\n");
        sh(&dir, &["add", "src/new.ts"]);
        fs::remove_file(dir.join("src/new.ts")).unwrap();
        let r = &space_files(&space).unwrap()[0];
        assert!(find(r, "src/old.ts").is_none());
        assert!(find(r, "src/b.ts").is_none());
        assert!(find(r, "src/new.ts").is_none());
    }

    #[test]
    fn unicode_and_spaces_in_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let (dir, space) = repo(tmp.path());
        write(&dir, "docs/é à.md", "x");
        let r = &space_files(&space).unwrap()[0];
        assert!(find(r, "docs/é à.md").is_some());
    }

    #[test]
    fn listing_is_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let (dir, _) = repo(tmp.path());
        let (files, truncated) = tree_files_capped(&dir, &[], 3).unwrap();
        assert!(truncated);
        assert_eq!(files.len(), 3);
    }
}
