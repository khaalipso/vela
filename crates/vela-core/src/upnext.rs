//! The "Up next" island, computed once for every client.

use crate::error::Result;
use crate::model::{FileChange, Space, UpNext};
use crate::{diff, status};

/// Pure choice of the single most useful action.
///
/// Priority: an agent question, then hunks to review, then a commit, else nothing.
/// `questions` holds `(agent, text)` pairs (agents arrive in M2).
pub fn up_next(
    pending_hunks: usize,
    changes: &[FileChange],
    questions: &[(String, String)],
) -> UpNext {
    if let Some((agent, text)) = questions.first() {
        return UpNext::AgentQuestion {
            agent: agent.clone(),
            text: text.clone(),
        };
    }
    if pending_hunks > 0 {
        return UpNext::Review {
            count: pending_hunks as u32,
        };
    }
    let staged: Vec<&FileChange> = changes.iter().filter(|c| c.staged.is_some()).collect();
    if !staged.is_empty() {
        let mut repos: Vec<&str> = staged.iter().map(|c| c.repo.as_str()).collect();
        repos.sort_unstable();
        repos.dedup();
        return UpNext::Commit {
            repos: repos.len() as u32,
            files: staged.len() as u32,
        };
    }
    UpNext::Nothing
}

/// [`up_next`] for a live space (no agent questions yet).
pub fn space_up_next(space: &Space) -> Result<UpNext> {
    let pending = diff::worktree_hunks(space)?.len();
    let changes = status::space_status(space)?;
    Ok(up_next(pending, &changes, &[]))
}
