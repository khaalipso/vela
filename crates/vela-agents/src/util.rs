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
