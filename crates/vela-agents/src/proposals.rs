//! Proposals: what the agents changed, offered to the user hunk by hunk.
//!
//! The proposals of an agent are the changes in its worktree since the commit it started at
//! (committed or not). Comparing with the user's worktree instead would offer to undo the
//! user's own uncommitted edits, which the agent never saw. A hunk is hidden once it is
//! already in the user's worktree (accepted, or typed by hand) or rejected.
//!
//! Accepting applies the hunk to the user's worktree with `git apply`, then stages it.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use vela_core::git::git_with;
use vela_core::model::{Hunk, HunkState, Origin, Space};
use vela_core::{Error, Result, diff, stage};

use crate::registry::Entry;

/// A hunk an agent proposes, with the patch that applies it.
#[derive(Debug, Clone)]
pub struct Proposal {
    pub hunk: Hunk,
    pub agent: String,
    /// File header + hunk, ready for `git apply`.
    pub patch: String,
}

fn apply_args(extra: &[&'static str]) -> Vec<&'static str> {
    let mut a = vec!["apply", "--whitespace=nowarn"];
    a.extend_from_slice(extra);
    a
}

fn runs(dir: &Path, extra: &[&'static str], patch: &str) -> bool {
    git_with(dir, &apply_args(extra), &[], Some(patch)).is_ok()
}

/// The proposals of every agent that has worktrees. `rejected` hunks are left out unless
/// `with_rejected` (to undo a rejection).
pub fn proposals(
    space: &Space,
    entries: &[Entry],
    rejected: &BTreeSet<String>,
    with_rejected: bool,
) -> Result<Vec<Proposal>> {
    let mut out: Vec<Proposal> = Vec::new();
    for e in entries {
        for (repo, path) in &e.agent.worktrees {
            let Some(base) = e.bases.iter().find(|(r, _)| r == repo).map(|(_, b)| b) else {
                continue;
            };
            let Some(user) = space.repos.iter().find(|r| &r.name == repo) else {
                continue;
            };
            if !Path::new(path).is_dir() {
                continue;
            }
            let user_wt = Path::new(&user.worktree);
            for file in diff::changes_since(Path::new(path), base, repo)? {
                for ph in file.hunks {
                    let patch = format!("{}{}", file.header, ph.raw);
                    // Already in the user's worktree: the patch reverses cleanly.
                    if runs(user_wt, &["--check", "-R"], &patch) {
                        continue;
                    }
                    let mut hunk = ph.hunk;
                    if out.iter().any(|p| p.hunk.id == hunk.id) {
                        continue;
                    }
                    if rejected.contains(&hunk.id) {
                        if !with_rejected {
                            continue;
                        }
                        hunk.state = HunkState::Rejected;
                    }
                    hunk.origin = Origin::Agent {
                        agent: e.agent.id.clone(),
                    };
                    out.push(Proposal {
                        hunk,
                        agent: e.agent.id.clone(),
                        patch,
                    });
                }
            }
        }
    }
    Ok(out)
}

/// Apply a proposal to the user's worktree and stage it. Returns the hunk as staged (the
/// staged version when git kept the same hunk id, else the proposal marked staged).
pub fn accept(space: &Space, p: &Proposal) -> Result<Hunk> {
    let user = space
        .repos
        .iter()
        .find(|r| r.name == p.hunk.repo)
        .ok_or_else(|| Error::RepoNotFound(p.hunk.repo.clone()))?;
    let dir = Path::new(&user.worktree);
    git_with(dir, &apply_args(&[]), &[], Some(&p.patch)).map_err(|e| match e {
        Error::Git { stderr, .. } => Error::PatchFailed(format!(
            "{} does not apply to your worktree (you changed the same lines): {stderr}",
            p.hunk.path
        )),
        other => other,
    })?;
    let mut hunk = p.hunk.clone();
    match stage::stage_hunk(space, &hunk.id) {
        Ok(()) => {
            hunk.state = HunkState::Staged;
            if let Some(h) = diff::staged_hunks(space)?
                .into_iter()
                .find(|h| h.id == hunk.id)
            {
                hunk = Hunk {
                    origin: hunk.origin.clone(),
                    ..h
                };
            }
        }
        // Git merged the hunk with edits of the user next to it: applied, not staged.
        Err(Error::HunkNotFound(_)) => hunk.state = HunkState::Pending,
        Err(e) => return Err(e),
    }
    Ok(hunk)
}

/// Accept several proposals: each patch goes to your worktree, then the ones that applied
/// are staged together. Returns the proposals that did not apply, with the reason.
pub fn accept_many(space: &Space, list: &[&Proposal]) -> Result<Vec<(String, String)>> {
    let mut applied: Vec<String> = Vec::new();
    let mut failed: Vec<(String, String)> = Vec::new();
    for p in list {
        let Some(user) = space.repos.iter().find(|r| r.name == p.hunk.repo) else {
            failed.push((
                p.hunk.id.clone(),
                format!("{} is not in this space", p.hunk.repo),
            ));
            continue;
        };
        match git_with(
            Path::new(&user.worktree),
            &apply_args(&[]),
            &[],
            Some(&p.patch),
        ) {
            Ok(_) => applied.push(p.hunk.id.clone()),
            Err(_) => failed.push((
                p.hunk.id.clone(),
                format!(
                    "{} does not apply (you changed the same lines)",
                    p.hunk.path
                ),
            )),
        }
    }
    // A hunk git merged with your edits next to it stays applied but not staged.
    stage::stage_hunks(space, &applied)?;
    Ok(failed)
}

/// Why each proposed hunk exists: the latest message of its author, one line.
pub fn reasons(entries: &[Entry], hunks: &[Hunk]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for h in hunks {
        if let Origin::Agent { agent } = &h.origin
            && let Some(e) = entries.iter().find(|e| &e.agent.id == agent)
            && !e.agent.summary.is_empty()
        {
            out.insert(h.id.clone(), e.agent.summary.clone());
        }
    }
    out
}
