//! Multi-repo commit.

use std::path::Path;

use crate::error::{Error, Result};
use crate::git::git;
use crate::model::Space;

/// Commit every repo that has staged changes with the same message.
///
/// Returns `(repo, sha)` per commit. Clean repos are skipped. If a commit fails
/// midway (a hook, say) the error is returned and earlier commits stay.
pub fn commit(space: &Space, message: &str) -> Result<Vec<(String, String)>> {
    let mut done = Vec::new();
    for r in &space.repos {
        let dir = Path::new(&r.worktree);
        if git(dir, &["diff", "--cached", "--name-only"])?
            .trim()
            .is_empty()
        {
            continue;
        }
        git(dir, &["commit", "-q", "-m", message])?;
        let sha = git(dir, &["rev-parse", "HEAD"])?.trim().to_string();
        done.push((r.name.clone(), sha));
    }
    if done.is_empty() {
        return Err(Error::NothingToCommit);
    }
    Ok(done)
}
