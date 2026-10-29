//! Bringing an agent's changes into your files: a three-way merge per file.
//!
//! The base is the file as the agent found it, "theirs" is the base with the changes it still
//! proposes (the ones you neither took nor rejected), "mine" is your file now. `git merge-file`
//! merges them: your edits next to the agent's are kept, and lines you both changed come back
//! as conflict markers to resolve, never as a patch that silently fails to apply.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use vela_core::model::Space;
use vela_core::{Error, Result};

use crate::proposals::Proposal;
use crate::registry::Entry;

/// Labels of the conflict markers: `<<<<<<< yours`, `>>>>>>> agent`.
pub const MINE: &str = "yours";
pub const THEIRS: &str = "agent";

/// A scratch directory, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "vela-merge-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// git outside any repository: the scratch directory never belongs to one.
fn bare_git(dir: &Path) -> Command {
    let mut c = Command::new("git");
    c.current_dir(dir)
        .env("GIT_CEILING_DIRECTORIES", dir.parent().unwrap_or(dir))
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}

/// Text content, or None for a binary file (NUL byte or not UTF-8).
pub fn text_of(bytes: Vec<u8>) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// What a file holds: absent, text or binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Content {
    Absent,
    Text(String),
    Binary(Vec<u8>),
}

impl Content {
    pub fn from_bytes(b: Option<Vec<u8>>) -> Self {
        match b {
            None => Content::Absent,
            Some(b) if b.contains(&0) => Content::Binary(b),
            Some(b) => match String::from_utf8(b) {
                Ok(s) => Content::Text(s),
                Err(e) => Content::Binary(e.into_bytes()),
            },
        }
    }
    pub fn read(path: &Path) -> Self {
        Self::from_bytes(fs::read(path).ok())
    }
    pub fn text(&self) -> Option<&str> {
        match self {
            Content::Text(s) => Some(s),
            _ => None,
        }
    }
    pub fn bytes(&self) -> &[u8] {
        match self {
            Content::Absent => &[],
            Content::Text(s) => s.as_bytes(),
            Content::Binary(b) => b,
        }
    }
    pub fn is_binary(&self) -> bool {
        matches!(self, Content::Binary(_))
    }
}

/// `git show <rev>:<path>` in `dir`; Absent when the path is not in that revision.
pub fn show(dir: &Path, rev: &str, path: &str) -> Content {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["show", &format!("{rev}:{path}")])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    match out {
        Ok(o) if o.status.success() => Content::from_bytes(Some(o.stdout)),
        _ => Content::Absent,
    }
}

/// Apply a patch of one file (`from` before, `to` after) on `base`, in a scratch directory.
pub fn apply_patch(base: &Content, from: &str, to: &str, patch: &str) -> Result<Content> {
    let s = Scratch::new()?;
    if !matches!(base, Content::Absent) {
        let f = s.0.join(from);
        if let Some(p) = f.parent() {
            fs::create_dir_all(p)?;
        }
        fs::write(&f, base.bytes())?;
    }
    let mut c = bare_git(&s.0);
    c.args(["apply", "--whitespace=nowarn", "--recount", "-"]);
    c.stdin(Stdio::piped());
    let mut child = c.spawn()?;
    if let Some(mut pipe) = child.stdin.take() {
        use std::io::Write;
        let _ = pipe.write_all(patch.as_bytes());
    }
    let out = child.wait_with_output()?;
    if !out.status.success() {
        return Err(Error::PatchFailed(format!(
            "{to}: the agent's changes do not apply to the file it started from: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(Content::read(&s.0.join(to)))
}

/// `git merge-file`: the merged text and the number of conflicts.
pub fn merge3(mine: &str, base: &str, theirs: &str) -> Result<(String, usize)> {
    let s = Scratch::new()?;
    for (name, text) in [("mine", mine), ("base", base), ("theirs", theirs)] {
        fs::write(s.0.join(name), text)?;
    }
    let out = bare_git(&s.0)
        .args([
            "merge-file",
            "-p",
            "-L",
            MINE,
            "-L",
            "base",
            "-L",
            THEIRS,
            "mine",
            "base",
            "theirs",
        ])
        .output()?;
    let code = out.status.code().unwrap_or(-1);
    if code < 0 {
        return Err(Error::Invalid(format!(
            "git merge-file failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok((
        String::from_utf8_lossy(&out.stdout).into_owned(),
        code as usize,
    ))
}

/// What one agent's changes do to the file you have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Side {
    pub result: Content,
    pub conflicts: usize,
    /// A conflict that markers cannot show (a deleted or binary file).
    pub note: Option<String>,
}

/// Merge `theirs` (base + the agent's changes) into `mine`.
pub fn merge_side(path: &str, mine: &Content, base: &Content, theirs: &Content) -> Result<Side> {
    let clean = |result: Content| Side {
        result,
        conflicts: 0,
        note: None,
    };
    // Nothing of yours in the way: the agent's version as is.
    if mine == base {
        return Ok(clean(theirs.clone()));
    }
    // You already have exactly what the agent has.
    if mine == theirs || theirs == base {
        return Ok(clean(mine.clone()));
    }
    match (mine, base, theirs) {
        (Content::Text(m), Content::Text(_) | Content::Absent, Content::Text(t)) => {
            let b = base.text().unwrap_or("");
            let (text, n) = merge3(m, b, t)?;
            Ok(Side {
                result: Content::Text(text),
                conflicts: n,
                note: None,
            })
        }
        (_, _, Content::Absent) => Ok(Side {
            result: mine.clone(),
            conflicts: 0,
            note: Some(format!(
                "The agent deleted {path}, but you changed it since. Accepting keeps your file."
            )),
        }),
        (Content::Absent, _, _) => Ok(Side {
            result: theirs.clone(),
            conflicts: 0,
            note: Some(format!(
                "You deleted {path}, the agent changed it. Accepting brings the agent's version back."
            )),
        }),
        _ => Ok(Side {
            result: theirs.clone(),
            conflicts: 0,
            note: Some(format!(
                "{path} is binary and you both changed it. Accepting takes the agent's version."
            )),
        }),
    }
}

/// The file header of a patch: everything before the first `@@`.
fn header_of(patch: &str) -> &str {
    match patch.find("\n@@") {
        Some(i) => &patch[..=i],
        None => patch,
    }
}

fn body_of(patch: &str) -> &str {
    &patch[header_of(patch).len()..]
}

/// The path the file had before a rename (or the same path).
fn from_of(patch: &str, path: &str) -> String {
    header_of(patch)
        .lines()
        .find_map(|l| {
            l.strip_prefix("rename from ")
                .or_else(|| l.strip_prefix("copy from "))
        })
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

/// Every pending proposal of one file merged into your file, agent after agent.
#[derive(Debug, Clone)]
pub struct FileMerge {
    pub mine: Content,
    pub result: Content,
    pub conflicts: usize,
    pub notes: Vec<String>,
    /// Agents with proposals in the file, in order.
    pub agents: Vec<String>,
    /// Ids of the proposals merged.
    pub ids: Vec<String>,
}

/// Merge the proposals of one file (all of the same repo and path) into your worktree file.
pub fn merge_file(
    space: &Space,
    entries: &[Entry],
    repo: &str,
    path: &str,
    proposals: &[&Proposal],
) -> Result<FileMerge> {
    let user = space
        .repos
        .iter()
        .find(|r| r.name == repo)
        .ok_or_else(|| Error::RepoNotFound(repo.to_string()))?;
    let mine = Content::read(&Path::new(&user.worktree).join(path));
    let mut out = FileMerge {
        mine: mine.clone(),
        result: mine,
        conflicts: 0,
        notes: Vec::new(),
        agents: Vec::new(),
        ids: Vec::new(),
    };
    let mut agents: Vec<&str> = Vec::new();
    for p in proposals {
        if !agents.contains(&p.agent.as_str()) {
            agents.push(&p.agent);
        }
    }
    for agent in agents {
        let mine_of: Vec<&&Proposal> = proposals.iter().filter(|p| p.agent == agent).collect();
        let Some(entry) = entries.iter().find(|e| e.agent.id == agent) else {
            continue;
        };
        let Some(base_rev) = entry.bases.iter().find(|(r, _)| r == repo).map(|(_, b)| b) else {
            continue;
        };
        let Some(wt) = entry
            .agent
            .worktrees
            .iter()
            .find(|(r, _)| r == repo)
            .map(|(_, p)| p)
        else {
            continue;
        };
        let first = &mine_of[0].patch;
        let from = from_of(first, path);
        let base = show(Path::new(wt), base_rev, &from);
        let mut patch = header_of(first).to_string();
        for p in &mine_of {
            patch.push_str(body_of(&p.patch));
        }
        let theirs = apply_patch(&base, &from, path, &patch)?;
        let side = merge_side(path, &out.result, &base, &theirs)?;
        out.result = side.result;
        out.conflicts += side.conflicts;
        out.notes.extend(side.note);
        out.agents.push(agent.to_string());
        out.ids.extend(mine_of.iter().map(|p| p.hunk.id.clone()));
    }
    Ok(out)
}

/// Write a merge result to your worktree file (or delete it when the result is no file).
pub fn write_result(space: &Space, repo: &str, path: &str, result: &Content) -> Result<()> {
    let user = space
        .repos
        .iter()
        .find(|r| r.name == repo)
        .ok_or_else(|| Error::RepoNotFound(repo.to_string()))?;
    let file = Path::new(&user.worktree).join(path);
    match result {
        Content::Absent => {
            if file.exists() {
                fs::remove_file(&file)?;
            }
        }
        _ => {
            if let Some(p) = file.parent() {
                fs::create_dir_all(p)?;
            }
            fs::write(&file, result.bytes())?;
        }
    }
    Ok(())
}

/// Whether a text still holds conflict markers written by [`merge3`].
pub fn has_markers(text: &str) -> bool {
    let mut open = false;
    for l in text.lines() {
        if l == format!("<<<<<<< {MINE}") {
            open = true;
        } else if open && l == format!(">>>>>>> {THEIRS}") {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_edits_next_to_each_other() {
        let base = "1\n2\n3\n4\n5\n";
        let mine = "1\n2\nmine 3\n4\n5\n";
        let theirs = "1\nTWO\n3\nFOUR\n5\n";
        let (m, n) = merge3(mine, base, theirs).unwrap();
        // Adjacent lines changed on both sides: git reports one conflict.
        assert!(n <= 1, "{m}");
        let far_mine = "1\n2\n3\n4\nmine 5\n";
        let (m, n) = merge3(far_mine, "1\n2\n3\n4\n5\n", "ONE\n2\n3\n4\n5\n").unwrap();
        assert_eq!(n, 0);
        assert_eq!(m, "ONE\n2\n3\n4\nmine 5\n");
    }

    #[test]
    fn same_lines_give_markers() {
        let (m, n) = merge3("a\nX\nc\n", "a\nb\nc\n", "a\nY\nc\n").unwrap();
        assert_eq!(n, 1);
        assert!(has_markers(&m), "{m}");
    }

    #[test]
    fn applies_a_patch_on_a_base() {
        let base = Content::Text("a\nb\nc\n".into());
        let patch = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
        let out = apply_patch(&base, "f.txt", "f.txt", patch).unwrap();
        assert_eq!(out, Content::Text("a\nB\nc\n".into()));
    }

    #[test]
    fn deleted_by_agent_and_untouched_is_deleted() {
        let base = Content::Text("x\n".into());
        let s = merge_side("f", &base, &base, &Content::Absent).unwrap();
        assert_eq!(s.result, Content::Absent);
        assert!(s.note.is_none());
    }
}
