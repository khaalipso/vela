//! Multi-repo commit.

use std::path::Path;

use crate::error::{Error, Result};
use crate::git::git;
use crate::model::Space;

/// Asked before each commit with the repo name and its worktree. A trailer line
/// (`Vela-Checks: ...`) means the hooks already passed on this exact tree: the commit then
/// runs with `--no-verify` and carries the trailer.
pub type HookSkip<'a> = &'a dyn Fn(&str, &Path) -> Option<String>;

/// Add a trailer line to a message: in the existing trailer block when there is one,
/// else in a new paragraph.
pub fn append_trailer(message: &str, trailer: &str) -> String {
    let msg = message.trim_end();
    let mut paragraphs = msg.rsplitn(2, "\n\n");
    let last = paragraphs.next().unwrap_or("");
    let has_body_before = paragraphs.next().is_some();
    let is_trailer = |l: &str| {
        l.split_once(": ").is_some_and(|(k, _)| {
            !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
    };
    if has_body_before && !last.is_empty() && last.lines().all(is_trailer) {
        format!("{msg}\n{trailer}\n")
    } else {
        format!("{msg}\n\n{trailer}\n")
    }
}

/// Commit every repo that has staged changes with the same message.
///
/// Returns `(repo, sha)` per commit. Clean repos are skipped. If a commit fails
/// midway (a hook, say) the error is returned and earlier commits stay.
pub fn commit(space: &Space, message: &str) -> Result<Vec<(String, String)>> {
    commit_with(space, message, None)
}

/// [`commit`], skipping the hooks of the repos where `skip` says they already passed.
pub fn commit_with(
    space: &Space,
    message: &str,
    skip: Option<HookSkip>,
) -> Result<Vec<(String, String)>> {
    let mut done = Vec::new();
    for r in &space.repos {
        let dir = Path::new(&r.worktree);
        if git(dir, &["diff", "--cached", "--name-only"])?
            .trim()
            .is_empty()
        {
            continue;
        }
        match skip.and_then(|f| f(&r.name, dir)) {
            Some(trailer) => {
                let msg = append_trailer(message, &trailer);
                git(dir, &["commit", "-q", "--no-verify", "-m", &msg])?;
            }
            None => {
                git(dir, &["commit", "-q", "-m", message])?;
            }
        }
        let sha = git(dir, &["rev-parse", "HEAD"])?.trim().to_string();
        done.push((r.name.clone(), sha));
    }
    if done.is_empty() {
        return Err(Error::NothingToCommit);
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailer_joins_the_footer_block() {
        assert_eq!(
            append_trailer("feat: x\n\nbody", "Vela-Checks: a"),
            "feat: x\n\nbody\n\nVela-Checks: a\n"
        );
        assert_eq!(
            append_trailer("feat: x\n\nbody\n\nRefs: PAY-1\n", "Vela-Checks: a"),
            "feat: x\n\nbody\n\nRefs: PAY-1\nVela-Checks: a\n"
        );
        assert_eq!(append_trailer("fix: y", "T: 1"), "fix: y\n\nT: 1\n");
        // A subject that looks like a trailer is not one.
        assert_eq!(append_trailer("Note: x", "T: 1"), "Note: x\n\nT: 1\n");
    }
}
