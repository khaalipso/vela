//! The history of each repo of a space, for the Git view: the commit graph of the space branch
//! and its base (as `git log --graph` draws it), how far the branch is from its base and from
//! its upstream, and what is not committed yet.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::git::git;
use crate::model::Space;

/// One line of the graph: the drawing on the left, and the commit when the line has one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphLine {
    /// The graph characters (`*`, `|`, `/`, `\`, spaces) of `git log --graph`.
    pub graph: String,
    /// Short hash; empty on a line that only continues the drawing.
    pub hash: String,
    pub subject: String,
    pub author: String,
    /// "3 hours ago".
    pub when: String,
    /// Branches and tags pointing at the commit (`HEAD -> feat/x`, `origin/main`, `tag: v1`).
    pub refs: Vec<String>,
    /// The commit is on the space branch and not on its base: it is the work of the space.
    pub mine: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoHistory {
    pub repo: String,
    pub branch: String,
    /// What the branch is compared with: `origin/main`, else the local `main` or `master`.
    pub base: Option<String>,
    /// Commits of the branch not on the base, and of the base not on the branch.
    pub ahead: u32,
    pub behind: u32,
    /// Against `@{upstream}`; None when the branch was never pushed.
    pub unpushed: Option<u32>,
    pub unpulled: Option<u32>,
    /// What the branch changes since it left the base.
    pub files: u32,
    pub added: u32,
    pub removed: u32,
    /// Files with changes not committed (staged or not).
    pub uncommitted: u32,
    pub stashes: u32,
    pub lines: Vec<GraphLine>,
}

const SEP: char = '\u{1f}';

fn base_of(dir: &Path, branch: &str) -> Option<String> {
    if let Ok(r) = git(dir, &["rev-parse", "--abbrev-ref", "origin/HEAD"]) {
        let r = r.trim();
        if !r.is_empty() && r != "origin/HEAD" {
            return Some(r.to_string());
        }
    }
    for b in ["origin/main", "origin/master", "main", "master"] {
        if b != branch && git(dir, &["rev-parse", "--verify", "-q", b]).is_ok() {
            return Some(b.to_string());
        }
    }
    None
}

fn counts(dir: &Path, range: &str) -> Option<(u32, u32)> {
    let out = git(dir, &["rev-list", "--left-right", "--count", range]).ok()?;
    let mut it = out.split_whitespace().map(|n| n.parse::<u32>().ok());
    Some((it.next()??, it.next()??))
}

/// Parse `git log --graph` lines written with the format of [`repo_history`].
pub fn parse_graph(text: &str, mine: &HashSet<String>) -> Vec<GraphLine> {
    text.lines()
        .map(|l| match l.split_once(SEP) {
            None => GraphLine {
                graph: l.trim_end().to_string(),
                hash: String::new(),
                subject: String::new(),
                author: String::new(),
                when: String::new(),
                refs: Vec::new(),
                mine: false,
            },
            Some((graph, rest)) => {
                let mut f = rest.split(SEP);
                let hash = f.next().unwrap_or("").to_string();
                let subject = f.next().unwrap_or("").to_string();
                let author = f.next().unwrap_or("").to_string();
                let when = f.next().unwrap_or("").to_string();
                let refs = f
                    .next()
                    .unwrap_or("")
                    .split(", ")
                    .map(str::trim)
                    .filter(|r| !r.is_empty())
                    .map(str::to_string)
                    .collect();
                GraphLine {
                    graph: graph.trim_end().to_string(),
                    mine: mine.contains(&hash),
                    hash,
                    subject,
                    author,
                    when,
                    refs,
                }
            }
        })
        .collect()
}

/// The history of one worktree, `limit` commits at most.
pub fn repo_history(repo: &str, dir: &Path, limit: usize) -> Result<RepoHistory> {
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    let base = base_of(dir, &branch);
    let has_commits = git(dir, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
    let (behind, ahead) = base
        .as_ref()
        .and_then(|b| counts(dir, &format!("{b}...HEAD")))
        .unwrap_or((0, 0));
    let up = counts(dir, "@{upstream}...HEAD");
    let mine: HashSet<String> = match &base {
        Some(b) => git(dir, &["log", "--format=%h", &format!("{b}..HEAD")])
            .map(|o| o.lines().map(str::to_string).collect())
            .unwrap_or_default(),
        None => HashSet::new(),
    };
    let (mut files, mut added, mut removed) = (0, 0, 0);
    if let Some(b) = &base
        && let Ok(out) = git(dir, &["diff", "--numstat", &format!("{b}...HEAD")])
    {
        for l in out.lines() {
            let mut it = l.split('\t');
            files += 1;
            added += it.next().and_then(|n| n.parse::<u32>().ok()).unwrap_or(0);
            removed += it.next().and_then(|n| n.parse::<u32>().ok()).unwrap_or(0);
        }
    }
    let uncommitted = git(dir, &["status", "--porcelain"])
        .map(|o| o.lines().filter(|l| !l.is_empty()).count() as u32)
        .unwrap_or(0);
    let stashes = git(dir, &["stash", "list"])
        .map(|o| o.lines().count() as u32)
        .unwrap_or(0);
    let lines = if has_commits {
        let fmt = format!("--format={SEP}%h{SEP}%s{SEP}%an{SEP}%ar{SEP}%D");
        let n = format!("-n{limit}");
        let mut args = vec![
            "log",
            "--graph",
            "--date-order",
            "--decorate=short",
            "--color=never",
            fmt.as_str(),
            n.as_str(),
            "HEAD",
        ];
        if let Some(b) = &base {
            args.push(b.as_str());
        }
        parse_graph(&git(dir, &args)?, &mine)
    } else {
        Vec::new()
    };
    Ok(RepoHistory {
        repo: repo.to_string(),
        branch,
        base,
        ahead,
        behind,
        unpushed: up.map(|(_, a)| a),
        unpulled: up.map(|(b, _)| b),
        files,
        added,
        removed,
        uncommitted,
        stashes,
        lines,
    })
}

/// The history of every repo of a space.
pub fn space_history(space: &Space, limit: usize) -> Result<Vec<RepoHistory>> {
    space
        .repos
        .iter()
        .map(|r| repo_history(&r.name, Path::new(&r.worktree), limit))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) {
        let o = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?}");
    }

    #[test]
    fn graph_of_a_branch_with_its_base() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        sh(d, &["init", "-q", "-b", "main"]);
        sh(d, &["config", "user.name", "T"]);
        sh(d, &["config", "user.email", "t@e.c"]);
        sh(d, &["config", "commit.gpgsign", "false"]);
        fs::write(d.join("a"), "1\n").unwrap();
        sh(d, &["add", "-A"]);
        sh(d, &["commit", "-qm", "init"]);
        sh(d, &["checkout", "-qb", "feat/x"]);
        fs::write(d.join("a"), "1\n2\n").unwrap();
        sh(d, &["commit", "-qam", "feat: two"]);
        sh(d, &["checkout", "-q", "main"]);
        fs::write(d.join("b"), "b\n").unwrap();
        sh(d, &["add", "-A"]);
        sh(d, &["commit", "-qm", "chore: b"]);
        sh(d, &["checkout", "-q", "feat/x"]);
        fs::write(d.join("c"), "c\n").unwrap();

        let h = repo_history("api", d, 50).unwrap();
        assert_eq!(h.branch, "feat/x");
        assert_eq!(h.base.as_deref(), Some("main"));
        assert_eq!((h.ahead, h.behind), (1, 1));
        assert_eq!((h.files, h.added, h.removed), (1, 1, 0));
        assert_eq!(h.uncommitted, 1);
        assert_eq!(h.unpushed, None);
        let commits: Vec<_> = h.lines.iter().filter(|l| !l.hash.is_empty()).collect();
        assert_eq!(commits.len(), 3);
        let mine: Vec<_> = commits
            .iter()
            .filter(|l| l.mine)
            .map(|l| l.subject.as_str())
            .collect();
        assert_eq!(mine, ["feat: two"]);
        assert!(
            commits
                .iter()
                .any(|l| l.refs.iter().any(|r| r.contains("feat/x")))
        );
        assert!(commits.iter().all(|l| l.graph.contains('*')));
    }
}
