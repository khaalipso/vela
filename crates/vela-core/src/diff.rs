//! Unified diff parsing and hunk collection.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::Result;
use crate::git::{git, git_with};
use crate::model::{DiffLine, Hunk, HunkState, LineKind, Origin, Space};

/// One file of a diff, with the raw header kept so single hunks can be re-applied.
#[derive(Debug, Clone)]
pub struct ParsedFile {
    pub repo: String,
    pub path: String,
    /// Original path for renames.
    pub from: Option<String>,
    /// Raw text from `diff --git` up to the first `@@`.
    pub header: String,
    pub is_new: bool,
    pub is_deleted: bool,
    pub hunks: Vec<ParsedHunk>,
}

#[derive(Debug, Clone)]
pub struct ParsedHunk {
    pub hunk: Hunk,
    /// Raw text: `@@` line, body and `\ No newline` markers.
    pub raw: String,
    /// Synthetic whole-file hunk of an untracked file (no raw patch).
    pub untracked: bool,
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv(hash: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *hash ^= u64::from(*b);
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
}

/// Stable hunk id: FNV-1a 64 (hex) of repo, path and only the `+`/`-` lines,
/// so it survives the hunk moving when lines are added above it.
pub fn hunk_id(repo: &str, path: &str, lines: &[DiffLine]) -> String {
    let mut h = FNV_OFFSET;
    fnv(&mut h, repo.as_bytes());
    fnv(&mut h, &[0]);
    fnv(&mut h, path.as_bytes());
    fnv(&mut h, &[0]);
    for l in lines {
        let sign: &[u8] = match l.kind {
            LineKind::Add => b"+",
            LineKind::Del => b"-",
            LineKind::Context => continue,
        };
        fnv(&mut h, sign);
        fnv(&mut h, l.text.as_bytes());
        fnv(&mut h, b"\n");
    }
    format!("{h:016x}")
}

/// Undo git's C-style quoting of a path (`"a\tb"`), and drop the `a/` `b/` prefix.
fn clean_path(raw: &str) -> Option<String> {
    let raw = raw.trim_end_matches('\t');
    if raw == "/dev/null" {
        return None;
    }
    let unquoted = if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        let inner = &raw.as_bytes()[1..raw.len() - 1];
        let mut out = Vec::new();
        let mut i = 0;
        while i < inner.len() {
            if inner[i] == b'\\' && i + 1 < inner.len() {
                i += 1;
                match inner[i] {
                    b'n' => out.push(b'\n'),
                    b't' => out.push(b'\t'),
                    c @ b'0'..=b'7' => {
                        let mut v = u32::from(c - b'0');
                        let mut n = 1;
                        while n < 3 && i + 1 < inner.len() && matches!(inner[i + 1], b'0'..=b'7') {
                            i += 1;
                            v = v * 8 + u32::from(inner[i] - b'0');
                            n += 1;
                        }
                        out.push(v as u8);
                    }
                    c => out.push(c),
                }
            } else {
                out.push(inner[i]);
            }
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    } else {
        raw.to_string()
    };
    Some(
        unquoted
            .strip_prefix("a/")
            .or_else(|| unquoted.strip_prefix("b/"))
            .map(str::to_string)
            .unwrap_or(unquoted),
    )
}

fn parse_range(s: &str) -> Option<(u32, u32)> {
    match s.split_once(',') {
        Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
        None => Some((s.parse().ok()?, 1)),
    }
}

/// `@@ -a,b +c,d @@ section` -> (a, b, c, d, section)
fn parse_hunk_header(l: &str) -> Option<(u32, u32, u32, u32, String)> {
    let rest = l.strip_prefix("@@ -")?;
    let (ranges, section) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let (os, ol) = parse_range(old)?;
    let (ns, nl) = parse_range(new)?;
    let section = section.strip_prefix(' ').unwrap_or(section);
    Some((os, ol, ns, nl, section.to_string()))
}

/// Parse unified diff text (as printed by `git diff`) into files and hunks.
///
/// Binary files and pure renames / mode changes yield a file with no hunks.
/// Hunk origin is [`Origin::You`]; callers override it for agent proposals.
pub fn parse_diff(repo: &str, text: &str, state: HunkState) -> Vec<ParsedFile> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut files: Vec<ParsedFile> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i];
        i += 1;
        if l.starts_with("diff --git ") {
            files.push(ParsedFile {
                repo: repo.to_string(),
                path: String::new(),
                from: None,
                header: format!("{l}\n"),
                is_new: false,
                is_deleted: false,
                hunks: Vec::new(),
            });
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };
        if let Some((os, ol, ns, nl, section)) = parse_hunk_header(l) {
            let mut raw = format!("{l}\n");
            let mut body = Vec::new();
            let (mut ro, mut rn) = (ol, nl);
            let (mut old_no, mut new_no) = (os, ns);
            while i < lines.len() {
                let c = lines[i];
                if c.starts_with('\\') {
                    raw.push_str(c);
                    raw.push('\n');
                    i += 1;
                    continue;
                }
                if ro == 0 && rn == 0 {
                    break;
                }
                let (kind, text) = match c.chars().next() {
                    Some('+') => (LineKind::Add, &c[1..]),
                    Some('-') => (LineKind::Del, &c[1..]),
                    Some(' ') => (LineKind::Context, &c[1..]),
                    // Editors sometimes strip the single space of an empty context line.
                    None if i + 1 < lines.len() => (LineKind::Context, ""),
                    _ => break,
                };
                let dl = match kind {
                    LineKind::Add => {
                        rn = rn.saturating_sub(1);
                        new_no += 1;
                        DiffLine {
                            kind,
                            text: text.to_string(),
                            old: None,
                            new: Some(new_no - 1),
                        }
                    }
                    LineKind::Del => {
                        ro = ro.saturating_sub(1);
                        old_no += 1;
                        DiffLine {
                            kind,
                            text: text.to_string(),
                            old: Some(old_no - 1),
                            new: None,
                        }
                    }
                    LineKind::Context => {
                        ro = ro.saturating_sub(1);
                        rn = rn.saturating_sub(1);
                        old_no += 1;
                        new_no += 1;
                        DiffLine {
                            kind,
                            text: text.to_string(),
                            old: Some(old_no - 1),
                            new: Some(new_no - 1),
                        }
                    }
                };
                body.push(dl);
                raw.push_str(c);
                raw.push('\n');
                i += 1;
            }
            let path = file.path.clone();
            file.hunks.push(ParsedHunk {
                hunk: Hunk {
                    id: hunk_id(repo, &path, &body),
                    repo: repo.to_string(),
                    path,
                    old_start: os,
                    old_lines: ol,
                    new_start: ns,
                    new_lines: nl,
                    section,
                    lines: body,
                    origin: Origin::You,
                    state,
                },
                raw,
                untracked: false,
            });
            continue;
        }
        if !file.hunks.is_empty() || l.is_empty() {
            continue;
        }
        // Still in the file header.
        file.header.push_str(l);
        file.header.push('\n');
        if let Some(p) = l.strip_prefix("--- ") {
            match clean_path(p) {
                Some(p) => {
                    if file.path.is_empty() {
                        file.path = p;
                    }
                }
                None => file.is_new = true,
            }
        } else if let Some(p) = l.strip_prefix("+++ ") {
            match clean_path(p) {
                Some(p) => file.path = p,
                None => file.is_deleted = true,
            }
        } else if let Some(p) = l.strip_prefix("rename from ") {
            file.from = Some(p.to_string());
        } else if let Some(p) = l.strip_prefix("rename to ") {
            file.path = p.to_string();
        } else if l.starts_with("new file mode") {
            file.is_new = true;
        } else if l.starts_with("deleted file mode") {
            file.is_deleted = true;
        }
    }
    // Fix hunk paths for files whose path was only known from rename lines.
    for f in &mut files {
        for h in &mut f.hunks {
            if h.hunk.path != f.path {
                h.hunk.path = f.path.clone();
                h.hunk.id = hunk_id(&f.repo, &f.path, &h.hunk.lines);
            }
        }
    }
    files
}

/// Parse a unified diff into flat hunks.
pub fn parse_unified(repo: &str, text: &str, state: HunkState) -> Vec<Hunk> {
    parse_diff(repo, text, state)
        .into_iter()
        .flat_map(|f| f.hunks.into_iter().map(|h| h.hunk))
        .collect()
}

const DIFF_ARGS: [&str; 7] = [
    "-c",
    "core.quotepath=off",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

fn diff_text(dir: &Path, staged: bool) -> Result<String> {
    let mut args: Vec<&str> = DIFF_ARGS.to_vec();
    args.push("-U3");
    args.push("-M");
    if staged {
        args.push("--cached");
    }
    git(dir, &args)
}

/// Whole-file Added hunks for untracked files (binary and empty files are skipped).
fn untracked_files(repo: &str, dir: &Path) -> Result<Vec<ParsedFile>> {
    let out = git(dir, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut files = Vec::new();
    for rel in out.split('\0').filter(|p| !p.is_empty()) {
        let full = dir.join(rel);
        let Ok(meta) = fs::symlink_metadata(&full) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Ok(bytes) = fs::read(&full) else {
            continue;
        };
        if bytes.is_empty() || bytes.contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let mut parts: Vec<&str> = text.split('\n').collect();
        if parts.last() == Some(&"") {
            parts.pop();
        }
        let lines: Vec<DiffLine> = parts
            .iter()
            .enumerate()
            .map(|(n, t)| DiffLine {
                kind: LineKind::Add,
                text: t.trim_end_matches('\r').to_string(),
                old: None,
                new: Some(n as u32 + 1),
            })
            .collect();
        let count = lines.len() as u32;
        files.push(ParsedFile {
            repo: repo.to_string(),
            path: rel.to_string(),
            from: None,
            header: String::new(),
            is_new: true,
            is_deleted: false,
            hunks: vec![ParsedHunk {
                hunk: Hunk {
                    id: hunk_id(repo, rel, &lines),
                    repo: repo.to_string(),
                    path: rel.to_string(),
                    old_start: 0,
                    old_lines: 0,
                    new_start: 1,
                    new_lines: count,
                    section: String::new(),
                    lines,
                    origin: Origin::You,
                    state: HunkState::Pending,
                },
                raw: String::new(),
                untracked: true,
            }],
        });
    }
    Ok(files)
}

/// Files with unstaged changes (plus untracked files) of every repo of the space.
pub(crate) fn unstaged_files(space: &Space) -> Result<Vec<ParsedFile>> {
    let mut all = Vec::new();
    for r in &space.repos {
        let dir = Path::new(&r.worktree);
        all.extend(parse_diff(
            &r.name,
            &diff_text(dir, false)?,
            HunkState::Pending,
        ));
        all.extend(untracked_files(&r.name, dir)?);
    }
    Ok(all)
}

/// Files with staged changes (index against HEAD) of every repo of the space.
pub(crate) fn staged_files(space: &Space) -> Result<Vec<ParsedFile>> {
    let mut all = Vec::new();
    for r in &space.repos {
        all.extend(parse_diff(
            &r.name,
            &diff_text(Path::new(&r.worktree), true)?,
            HunkState::Staged,
        ));
    }
    Ok(all)
}

fn flatten(files: Vec<ParsedFile>) -> Vec<Hunk> {
    files
        .into_iter()
        .flat_map(|f| f.hunks.into_iter().map(|h| h.hunk))
        .collect()
}

/// Unstaged hunks (state Pending, origin You), untracked files as one Added hunk each.
pub fn worktree_hunks(space: &Space) -> Result<Vec<Hunk>> {
    Ok(flatten(unstaged_files(space)?))
}

/// Staged hunks (`git diff --cached`, state Staged).
pub fn staged_hunks(space: &Space) -> Result<Vec<Hunk>> {
    Ok(flatten(staged_files(space)?))
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Snapshot the working files of `dir` (honouring .gitignore) as a tree object,
/// through a throwaway index so the real index is never touched.
fn snapshot_tree(dir: &Path) -> Result<String> {
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let index: PathBuf =
        std::env::temp_dir().join(format!("vela-index-{}-{n}", std::process::id()));
    let envs = [("GIT_INDEX_FILE", index.as_path())];
    let result = git_with(dir, &["add", "-A", "--", "."], &envs, None)
        .and_then(|_| git_with(dir, &["write-tree"], &envs, None));
    let _ = fs::remove_file(&index);
    Ok(result?.trim().to_string())
}

/// Hunks that turn the files of worktree `a` into those of worktree `b`.
///
/// Both directories must be worktrees (or clones sharing objects) of the same
/// repo: each is snapshotted as a tree through a temporary index and the trees
/// are compared with `git diff-tree`. This is preferred over `git diff --no-index`,
/// which would also compare `.git` files and ignore `.gitignore`. The repo name
/// is the directory name of `b`. Hunks are state Pending, origin You; the caller
/// sets `Origin::Agent`.
pub fn diff_between(repo_dir_a: &Path, repo_dir_b: &Path) -> Result<Vec<Hunk>> {
    let ta = snapshot_tree(repo_dir_a)?;
    let tb = snapshot_tree(repo_dir_b)?;
    let mut args: Vec<&str> = vec!["-c", "core.quotepath=off", "diff-tree", "-p", "-r"];
    args.extend([
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-U3",
        "-M",
    ]);
    args.push(&ta);
    args.push(&tb);
    let text = git(repo_dir_a, &args)?;
    let repo = repo_dir_b
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(parse_unified(&repo, &text, HunkState::Pending))
}

/// What the files of `dir` (committed or not, `.gitignore` honoured) changed since the
/// commit `base`, with the raw patch of every hunk so it can be applied elsewhere.
/// Hunks are state Pending, origin You; the caller sets `Origin::Agent`.
pub fn changes_since(dir: &Path, base: &str, repo: &str) -> Result<Vec<ParsedFile>> {
    let tree = snapshot_tree(dir)?;
    let text = git(
        dir,
        &[
            "-c",
            "core.quotepath=off",
            "diff-tree",
            "-p",
            "-r",
            "--no-color",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "-U3",
            "-M",
            base,
            &tree,
        ],
    )?;
    Ok(parse_diff(repo, &text, HunkState::Pending))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_HUNKS: &str = "\
diff --git a/src/a.rs b/src/a.rs
index 111..222 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,4 +1,4 @@ fn main() {
 one
-two
+TWO
 three
 four
@@ -20,3 +20,4 @@ fn other() {
 x
 y
+z
 w
diff --git a/b.txt b/b.txt
new file mode 100644
index 0000000..333
--- /dev/null
+++ b/b.txt
@@ -0,0 +1,2 @@
+hello
+world
";

    #[test]
    fn multiple_files_and_hunks() {
        let files = parse_diff("r", TWO_HUNKS, HunkState::Pending);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/a.rs");
        assert_eq!(files[0].hunks.len(), 2);
        let h = &files[0].hunks[0].hunk;
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (1, 4, 1, 4)
        );
        assert_eq!(h.section, "fn main() {");
        assert_eq!(h.lines.len(), 5);
        assert_eq!(h.lines[1].kind, LineKind::Del);
        assert_eq!(h.lines[1].old, Some(2));
        assert_eq!(h.lines[1].new, None);
        assert_eq!(h.lines[2].new, Some(2));
        assert!(files[1].is_new);
        assert_eq!(files[1].hunks[0].hunk.lines.len(), 2);
        assert!(files[0].header.ends_with("+++ b/src/a.rs\n"));
    }

    #[test]
    fn no_newline_marker_is_not_a_line() {
        let d = "\
diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
";
        let files = parse_diff("r", d, HunkState::Pending);
        let h = &files[0].hunks[0];
        assert_eq!(h.hunk.lines.len(), 2);
        assert!(h.raw.contains("\\ No newline"));
        assert_eq!(h.raw.matches("No newline").count(), 2);
    }

    #[test]
    fn deleted_file() {
        let d = "\
diff --git a/gone b/gone
deleted file mode 100644
index 111..0000000
--- a/gone
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
";
        let files = parse_diff("r", d, HunkState::Pending);
        assert!(files[0].is_deleted);
        assert_eq!(files[0].path, "gone");
        assert_eq!(files[0].hunks[0].hunk.lines.len(), 2);
    }

    #[test]
    fn pure_rename_and_rename_with_edit() {
        let d = "\
diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
diff --git a/x.txt b/y.txt
similarity index 80%
rename from x.txt
rename to y.txt
index 1..2 100644
--- a/x.txt
+++ b/y.txt
@@ -1,2 +1,2 @@
 keep
-a
+b
";
        let files = parse_diff("r", d, HunkState::Staged);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].from.as_deref(), Some("old.txt"));
        assert!(files[0].hunks.is_empty());
        assert_eq!(files[1].path, "y.txt");
        assert_eq!(files[1].from.as_deref(), Some("x.txt"));
        assert_eq!(files[1].hunks[0].hunk.path, "y.txt");
        assert_eq!(files[1].hunks[0].hunk.state, HunkState::Staged);
    }

    #[test]
    fn binary_is_skipped() {
        let d = "\
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
diff --git a/t b/t
--- a/t
+++ b/t
@@ -1 +1 @@
-a
+b
";
        let hunks = parse_unified("r", d, HunkState::Pending);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].path, "t");
    }

    #[test]
    fn id_ignores_position_and_context() {
        let a = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n c\n-x\n+y\n d\n";
        let b = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -40,3 +40,3 @@\n q\n-x\n+y\n r\n";
        let ha = parse_unified("r", a, HunkState::Pending);
        let hb = parse_unified("r", b, HunkState::Pending);
        assert_eq!(ha[0].id, hb[0].id);
        assert_eq!(ha[0].id.len(), 16);
        let other = parse_unified("other", a, HunkState::Pending);
        assert_ne!(ha[0].id, other[0].id);
    }

    #[test]
    fn crlf_content_is_preserved() {
        let d = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\r\n+b\r\n";
        let h = parse_unified("r", d, HunkState::Pending);
        assert_eq!(h[0].lines[0].text, "a\r");
    }

    #[test]
    fn quoted_path() {
        let d = "diff --git \"a/t\\tab\" \"b/t\\tab\"\n--- \"a/t\\tab\"\n+++ \"b/t\\tab\"\n@@ -1 +1 @@\n-a\n+b\n";
        let h = parse_unified("r", d, HunkState::Pending);
        assert_eq!(h[0].path, "t\tab");
    }
}
