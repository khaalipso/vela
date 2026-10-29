//! Agents code in their own worktree. When a run ends well, Vela brings their work into your
//! files at once: no review of agent changes, the Review is what you check before you commit.
//!
//! Each file the agent changed since its base is merged three ways (the base, your file now,
//! the agent's file). A clean merge is written to your file. Then the agent's worktree takes
//! your files as they are now, which become its new base; a file that conflicts is written
//! there with its markers, for the agent to resolve in its next run. Vela asks it to (see
//! [`conflict_prompt`]), then applies again.

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use vela_core::git::git;
use vela_core::model::Space;
use vela_core::{Result, Vela, diff};

use crate::merge::{self, Content};
use crate::registry::{self, Entry};

/// Two agents ending together do not write your files at the same time.
static APPLYING: Mutex<()> = Mutex::new(());

/// What applying a run did, paths as `repo/path` when the space has several repos.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    /// Written to your files.
    pub files: Vec<String>,
    /// Files with conflict markers: left in the agent's worktree to resolve, or written to
    /// your files when `to_you`.
    pub conflicts: Vec<String>,
    pub to_you: bool,
}

fn write(path: &Path, c: &Content) -> Result<()> {
    match c {
        Content::Absent => {
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
        _ => {
            if let Some(p) = path.parent() {
                fs::create_dir_all(p)?;
            }
            fs::write(path, c.bytes())?;
        }
    }
    Ok(())
}

/// The files `dir` changed since the tree `base`, ignored files left out.
fn changed_since(dir: &Path, base: &str) -> Result<Vec<String>> {
    let tree = diff::snapshot_tree(dir)?;
    if tree == base {
        return Ok(Vec::new());
    }
    let out = git(
        dir,
        &[
            "-c",
            "core.quotepath=off",
            "diff-tree",
            "-r",
            "--name-only",
            "--no-renames",
            "-z",
            base,
            &tree,
        ],
    )?;
    Ok(out
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect())
}

/// Bring the work of an agent into your files (see the module doc). Its bases move to your
/// files as they are after it, so the next run starts from there. `to_you`: the agent already
/// tried to resolve its conflicts, the files with markers go to your files for you to finish.
pub fn apply(vela: &Vela, space: &Space, entry: &Entry, to_you: bool) -> Result<Applied> {
    let _g = APPLYING.lock().unwrap_or_else(|e| e.into_inner());
    let several = space.repos.len() > 1;
    let mut out = Applied {
        to_you,
        ..Applied::default()
    };
    let mut bases = entry.bases.clone();
    for (repo, wt) in &entry.agent.worktrees {
        let Some(user) = space.repos.iter().find(|r| &r.name == repo) else {
            continue;
        };
        let Some(base) = entry.bases.iter().find(|(r, _)| r == repo).map(|(_, b)| b) else {
            continue;
        };
        let (user_wt, agent_wt) = (Path::new(&user.worktree), Path::new(wt));
        if !agent_wt.is_dir() {
            continue;
        }
        let name = |p: &str| {
            if several {
                format!("{repo}/{p}")
            } else {
                p.to_string()
            }
        };
        let mut conflicted: Vec<(String, Content)> = Vec::new();
        for path in changed_since(agent_wt, base)? {
            let before = merge::show(agent_wt, base, &path);
            let theirs = Content::read(&agent_wt.join(&path));
            let mine = Content::read(&user_wt.join(&path));
            let mut side = merge::merge_side(&path, &mine, &before, &theirs)?;
            // Markers the agent left from an earlier conflict are still a conflict.
            if theirs.text().is_some_and(merge::has_markers) {
                side.conflicts = side.conflicts.max(1);
            }
            if side.conflicts > 0 && to_you {
                write(&user_wt.join(&path), &side.result)?;
                out.conflicts.push(name(&path));
            } else if side.conflicts > 0 {
                conflicted.push((path.clone(), side.result));
                out.conflicts.push(name(&path));
            } else {
                if side.result != mine {
                    write(&user_wt.join(&path), &side.result)?;
                }
                out.files.push(name(&path));
            }
        }
        // The agent goes on from your files, with its conflicts on top.
        let tree = crate::worktree::sync_to(user_wt, agent_wt)?;
        for (path, merged) in &conflicted {
            write(&agent_wt.join(path), merged)?;
        }
        if let Some((_, b)) = bases.iter_mut().find(|(r, _)| r == repo) {
            *b = tree;
        }
    }
    if bases != entry.bases {
        registry::update(vela, &space.id, &entry.agent.id, |e| e.bases = bases)?;
    }
    Ok(out)
}

/// What the agent is asked when its work conflicts with your edits.
pub fn conflict_prompt(files: &[String]) -> String {
    format!(
        "Your work was applied to the person's files, except where it conflicts with edits they \
         made meanwhile. Your worktree now holds their files, and these files hold conflict \
         markers (`<<<<<<< {}` is their version, `>>>>>>> {}` is yours): {}.\n\nResolve every \
         conflict so that both their change and yours still do what they were meant to, remove \
         all the markers, and check that the code builds. Then answer in one or two sentences, \
         in the language of the conversation so far, what you kept from each side.",
        merge::MINE,
        merge::THEIRS,
        files.join(", ")
    )
}
