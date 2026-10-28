//! Agent worktrees: `VELA_HOME/worktrees/<space>/.agents/<agent>/<repo>`, on the branch
//! `<space-branch>--<agent>`, created from the commit the user's worktree is on, then filled with
//! the user's files as they are (uncommitted edits and new files included): an agent works on
//! what you see, so what it proposes merges with your edits.

use std::fs;
use std::path::{Path, PathBuf};

use vela_core::git::git;
use vela_core::model::Space;
use vela_core::{Error, Result, Vela, paths};

/// One repo of an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tree {
    pub repo: String,
    pub path: PathBuf,
    /// The tree the agent started from (your files when it was created); proposals are the
    /// changes since.
    pub base: String,
}

pub fn branch_name(space: &Space, agent: &str) -> String {
    format!("{}--{agent}", space.branch)
}

/// `worktrees/<space>/.agents/<agent>`
pub fn agent_root(vela: &Vela, space: &Space, agent: &str) -> PathBuf {
    paths::space_root(&vela.home, &space.id)
        .join(".agents")
        .join(agent)
}

/// A worktree and branch per repo. Everything created so far is removed when one repo fails.
pub fn create(vela: &Vela, space: &Space, agent: &str) -> Result<Vec<Tree>> {
    let branch = branch_name(space, agent);
    let mut made: Vec<Tree> = Vec::new();
    for r in &space.repos {
        let user_wt = Path::new(&r.worktree);
        let step = || -> Result<Tree> {
            let base = git(user_wt, &["rev-parse", "HEAD"])?.trim().to_string();
            let path = paths::agent_worktree(&vela.home, &space.id, agent, &r.name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let p = path.to_string_lossy().into_owned();
            git(user_wt, &["worktree", "add", "-b", &branch, &p, &base])?;
            let base = sync_to(user_wt, &path)?;
            Ok(Tree {
                repo: r.name.clone(),
                path,
                base,
            })
        };
        match step() {
            Ok(t) => made.push(t),
            Err(e) => {
                remove_trees(space, &made, &branch);
                let _ = fs::remove_dir_all(agent_root(vela, space, agent));
                return Err(e);
            }
        }
    }
    Ok(made)
}

/// Put the user's files as they are now (tracked, modified and new, ignored ones left out) in
/// an agent worktree, index included, so the agent's own `git diff` shows only its work.
/// Returns the tree the agent starts from.
pub fn sync_to(user_wt: &Path, agent_wt: &Path) -> Result<String> {
    let tree = vela_core::diff::snapshot_tree(user_wt)?;
    git(agent_wt, &["read-tree", "-u", "--reset", &tree])?;
    Ok(tree)
}

fn remove_trees(space: &Space, trees: &[Tree], branch: &str) {
    for t in trees {
        let Some(r) = space.repos.iter().find(|r| r.name == t.repo) else {
            continue;
        };
        let user_wt = Path::new(&r.worktree);
        let _ = git(
            user_wt,
            &["worktree", "remove", "--force", &t.path.to_string_lossy()],
        );
        let _ = git(user_wt, &["branch", "-D", branch]);
        let _ = git(user_wt, &["worktree", "prune"]);
    }
}

/// Remove the worktrees and branches of an agent, and its directory.
pub fn remove(vela: &Vela, space: &Space, agent: &str, trees: &[(String, String)]) -> Result<()> {
    let list: Vec<Tree> = trees
        .iter()
        .map(|(repo, path)| Tree {
            repo: repo.clone(),
            path: PathBuf::from(path),
            base: String::new(),
        })
        .collect();
    remove_trees(space, &list, &branch_name(space, agent));
    let root = agent_root(vela, space, agent);
    if root.exists() {
        fs::remove_dir_all(&root).map_err(Error::from)?;
    }
    Ok(())
}

/// Where an agent runs: its only repo worktree, or the directory that holds all of them.
pub fn run_dir(vela: &Vela, space: &Space, agent: &str, trees: &[(String, String)]) -> PathBuf {
    match trees {
        [(_, p)] => PathBuf::from(p),
        _ => agent_root(vela, space, agent),
    }
}

/// Where a read only agent runs: the user's worktree (one repo) or the space directory.
pub fn read_only_dir(vela: &Vela, space: &Space) -> PathBuf {
    match space.repos.as_slice() {
        [r] => PathBuf::from(&r.worktree),
        _ => paths::space_root(&vela.home, &space.id),
    }
}
