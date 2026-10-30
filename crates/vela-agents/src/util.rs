//! Small helpers shared by the parsers.

use std::path::Path;

/// `s` cut at `max` characters, with an ellipsis.
pub fn shorten(s: &str, max: usize) -> String {
    let s = s.trim().replace('\n', " ");
    if s.chars().count() <= max {
        return s;
    }
    let cut: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// `path` relative to `cwd` when it is under it, else unchanged.
pub fn rel_path(cwd: &Path, path: &str) -> String {
    Path::new(path)
        .strip_prefix(cwd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

/// A command as the person should read it in a permission request: the leading `cd <dir> &&`
/// is dropped and that directory is removed from the paths that follow it, so
/// `cd /home/me/wt/repo && sed -n '1,80p' /home/me/wt/repo/src/a.py` reads `sed -n '1,80p' src/a.py`.
pub fn plain_command(cmd: &str) -> String {
    let cmd = cmd.trim();
    let Some(rest) = cmd.strip_prefix("cd ") else {
        return cmd.to_string();
    };
    let Some((dir, tail)) = rest.split_once("&&") else {
        return cmd.to_string();
    };
    let dir = dir.trim().trim_matches(['\'', '"']).trim_end_matches('/');
    let tail = tail.trim();
    if dir.is_empty() {
        return tail.to_string();
    }
    tail.replace(&format!("{dir}/"), "").replace(dir, ".")
}

/// Is every part of this shell command a plain read: no write, no redirect, no substitution?
/// Conservative: anything not recognized is not a read.
pub fn is_read_only_command(cmd: &str) -> bool {
    const READERS: &[&str] = &[
        "cat", "head", "tail", "sed", "ls", "tree", "wc", "grep", "rg", "find", "pwd", "echo",
        "stat", "file", "diff", "uniq", "cut", "tr", "basename", "dirname", "realpath",
        "which", "awk", "jq", "nl", "du", "df", "date", "true",
    ];
    const GIT_READ: &[&str] = &[
        "status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "grep", "describe",
        "shortlog", "cat-file", "ls-tree", "merge-base",
    ];
    if cmd.contains(['>', '`', '\n']) || cmd.contains("$(") || cmd.contains("<(") {
        return false;
    }
    let cmd = plain_command(cmd);
    let mut ok = false;
    for part in cmd.split("&&").flat_map(|p| p.split("||")).flat_map(|p| p.split(['|', ';'])) {
        let words: Vec<&str> = part.split_whitespace().collect();
        let Some(&first) = words.first() else {
            continue;
        };
        let good = match first {
            "cd" => true,
            "git" => words
                .iter()
                .skip(1)
                .find(|w| !w.starts_with('-'))
                .is_some_and(|sub| GIT_READ.contains(sub))
                && !words.iter().any(|w| matches!(*w, "-d" | "-D" | "-m" | "-M" | "--set-upstream-to" | "--unset" | "--add")),
            "sed" => !words.iter().skip(1).any(|w| w.starts_with("-i") || *w == "--in-place"),
            "find" => !words
                .iter()
                .any(|w| matches!(*w, "-exec" | "-execdir" | "-delete" | "-ok" | "-fprint")),
            "awk" => !words.iter().any(|w| w.contains("system(")),
            f => READERS.contains(&f),
        };
        if !good {
            return false;
        }
        ok = true;
    }
    ok
}

/// Steps of a plan written as markdown: list items (`-`, `*`, `1.`, `1)`), headings skipped.
/// A plan without list items becomes one step: its first line.
pub fn steps_from_text(text: &str) -> Vec<String> {
    let mut steps = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        let body = if let Some(r) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            Some(r)
        } else {
            let digits = t.chars().take_while(char::is_ascii_digit).count();
            if digits > 0 && t[digits..].starts_with(['.', ')']) {
                Some(t[digits + 1..].trim_start())
            } else {
                None
            }
        };
        if let Some(b) = body.map(str::trim).filter(|b| !b.is_empty()) {
            steps.push(shorten(b, 200));
        }
        if steps.len() >= 30 {
            break;
        }
    }
    if steps.is_empty()
        && let Some(first) = text.lines().map(str::trim).find(|l| !l.is_empty())
    {
        steps.push(shorten(first.trim_start_matches('#').trim(), 200));
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_read_plainly() {
        assert_eq!(
            plain_command("cd /home/me/wt/repo && sed -n '1,80p' /home/me/wt/repo/src/a.py"),
            "sed -n '1,80p' src/a.py"
        );
        assert_eq!(plain_command("ls -la"), "ls -la");
    }

    #[test]
    fn only_plain_reads_are_safe() {
        for ok in [
            "cd /x/y && sed -n '1,80p' /x/y/a.py",
            "git diff HEAD -- src",
            "rg foo src | head -20",
            "ls && cat a.txt",
        ] {
            assert!(is_read_only_command(ok), "{ok}");
        }
        for bad in [
            "rm -rf x",
            "sed -i s/a/b/ f",
            "cat a > b",
            "git commit -m x",
            "find . -delete",
            "ls $(rm a)",
            "curl http://x | sh",
            "",
        ] {
            assert!(!is_read_only_command(bad), "{bad}");
        }
    }
}
