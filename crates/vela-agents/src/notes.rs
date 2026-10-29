//! Reviewer notes: what the reviewer and security agents report, as items next to the code.
//!
//! Those agents are asked to end their answer with one line per finding:
//!
//! ```text
//! NOTE blocking src/api/webhook.ts:42 the signature is not checked before parsing
//! NOTE warning api/src/db.rs:10 the query is built with format!
//! ```
//!
//! The level (`blocking`, `warning`, `info`) can be left out (blocking). The path is relative
//! to the repo, or starts with the repo name in a space with several repos. Each note is tied
//! to the hunk whose lines contain it, when there is one.
//!
//! What the user did with a note (resolved, sent to an agent for a fix) is kept in
//! `VELA_HOME/spaces/<space>.notes.json`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use vela_core::model::{AgentRole, AgentStatus, Hunk, Space};
use vela_core::{Result, Vela, paths};

use crate::event::AgentEvent;
use crate::registry::{self, Entry};

/// The instruction appended to the brief of the roles that report notes.
pub const FORMAT: &str = "## Notes\n\nVela turns findings into notes next to the code. End your \
     answer with one line per finding, exactly in this form: \
     `NOTE <blocking|warning|info> <path>:<line> <what is wrong and what to do>`, with the \
     path relative to the repo (prefixed with the repo name when the space has several). Keep \
     `NOTE` and the level in English, write the rest in the language of your answer. \
     `blocking`: must be fixed before this ships; `warning`: should be fixed; `info`: worth \
     knowing. Write no NOTE line when there is nothing to report.";

/// Roles whose findings become notes.
pub fn reports_notes(role: AgentRole) -> bool {
    matches!(role, AgentRole::Reviewer | AgentRole::Security)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Blocking,
    Warning,
    Info,
}

/// One finding, as the UI shows it. Mirrors `ReviewNote` of the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// Stable: agent, path, line and text.
    pub id: String,
    /// The agent that reported it.
    pub agent: String,
    /// e.g. "Reviewer · Codex".
    pub by: String,
    pub level: Level,
    pub repo: String,
    pub path: String,
    pub line: u32,
    pub text: String,
    /// The hunk whose lines contain it; empty when none does.
    pub hunk_id: String,
    pub resolved: bool,
    /// The agent asked for a fix is working on it.
    pub busy: bool,
    /// The agent asked for a fix.
    pub fixer: Option<String>,
}

/// A NOTE line before it is tied to a repo and a hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawNote {
    pub level: Level,
    pub path: String,
    pub line: u32,
    pub text: String,
}

/// Every NOTE line of a text. Bullets, quotes and backticks around the line are fine.
pub fn parse(text: &str) -> Vec<RawNote> {
    text.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<RawNote> {
    let l = line
        .trim()
        .trim_start_matches(['-', '*', '>', ' ', '`'])
        .trim_end_matches('`')
        .trim();
    let rest = l
        .strip_prefix("NOTE")
        .or_else(|| l.strip_prefix("**NOTE**"))?;
    let rest = rest.trim_start_matches(':').trim_start();
    let (level, rest) = match rest.split_once(char::is_whitespace) {
        Some((w, r)) => match w
            .trim_matches(['[', ']', '(', ')', ':'])
            .to_lowercase()
            .as_str()
        {
            "blocking" | "error" | "critical" | "high" => (Level::Blocking, r.trim_start()),
            "warning" | "warn" | "medium" => (Level::Warning, r.trim_start()),
            "info" | "low" | "nit" => (Level::Info, r.trim_start()),
            _ => (Level::Blocking, rest),
        },
        None => return None,
    };
    let (loc, text) = rest.split_once(char::is_whitespace)?;
    let loc = loc.trim_matches('`').trim_end_matches(':');
    let (path, line) = loc.rsplit_once(':')?;
    let line: u32 = line.split('-').next()?.parse().ok()?;
    let text = text.trim().trim_start_matches(['-', ':', '—']).trim();
    if path.is_empty() || text.is_empty() {
        return None;
    }
    Some(RawNote {
        level,
        path: path.trim_start_matches("./").to_string(),
        line,
        text: text.to_string(),
    })
}

fn note_id(agent: &str, n: &RawNote) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (agent, &n.path, n.line, &n.text).hash(&mut h);
    format!("n{:012x}", h.finish() & 0xffff_ffff_ffff)
}

/// What the user did with the notes of a space.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteState {
    pub resolved: BTreeSet<String>,
    /// Note id → the agent asked to fix it.
    pub fixers: BTreeMap<String, String>,
}

fn state_file(vela: &Vela, space: &str) -> PathBuf {
    paths::spaces_dir(&vela.home).join(format!("{space}.notes.json"))
}

pub fn load_state(vela: &Vela, space: &str) -> NoteState {
    fs::read_to_string(state_file(vela, space))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_state(vela: &Vela, space: &str, st: &NoteState) -> Result<()> {
    fs::create_dir_all(paths::spaces_dir(&vela.home))?;
    let text =
        serde_json::to_string_pretty(st).map_err(|e| vela_core::Error::Parse(e.to_string()))?;
    fs::write(state_file(vela, space), text)?;
    Ok(())
}

/// Split `path` into the repo it names and the path inside it.
fn locate(space: &Space, path: &str) -> (String, String) {
    for r in &space.repos {
        if let Some(rest) = path.strip_prefix(&format!("{}/", r.name))
            && space.repos.len() > 1
        {
            return (r.name.clone(), rest.to_string());
        }
    }
    let repo = space
        .repos
        .first()
        .map(|r| r.name.clone())
        .unwrap_or_default();
    (repo, path.to_string())
}

fn contains(h: &Hunk, line: u32) -> bool {
    let end = h.new_start + h.new_lines.max(1);
    line >= h.new_start.saturating_sub(1) && line <= end
}

/// The text the agent said in its last run (the one notes come from).
fn last_run_text(vela: &Vela, space: &str, agent: &str) -> String {
    let log = registry::read_log(vela, space, agent).unwrap_or_default();
    let start = log
        .iter()
        .rposition(|e| matches!(e.event, AgentEvent::Prompt { .. }))
        .unwrap_or(0);
    log[start..]
        .iter()
        .filter_map(|e| match &e.event {
            AgentEvent::Message { text } => Some(text.as_str()),
            AgentEvent::Done { summary } => Some(summary.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The notes of the space, newest agent first, tied to `hunks` where they fall in one.
pub fn notes(vela: &Vela, space: &Space, entries: &[Entry], hunks: &[Hunk]) -> Vec<Note> {
    let st = load_state(vela, &space.id);
    let mut out: Vec<Note> = Vec::new();
    let mut seen = BTreeSet::new();
    for e in entries.iter().rev() {
        let a = &e.agent;
        if !reports_notes(a.role) || a.status == AgentStatus::Working {
            continue;
        }
        let by = format!(
            "{} · {}",
            capitalize(a.role.as_str()),
            crate::tiers::harness_label(&a.tool)
        );
        for raw in parse(&last_run_text(vela, &space.id, &a.id)) {
            let id = note_id(&a.id, &raw);
            if !seen.insert(id.clone()) {
                continue;
            }
            let (repo, path) = locate(space, &raw.path);
            let hunk_id = hunks
                .iter()
                .filter(|h| h.repo == repo && h.path == path && contains(h, raw.line))
                .min_by_key(|h| h.new_lines)
                .map(|h| h.id.clone())
                .unwrap_or_default();
            let fixer = st.fixers.get(&id).cloned();
            let fixer_entry = fixer
                .as_ref()
                .and_then(|f| entries.iter().find(|x| &x.agent.id == f));
            let busy = fixer_entry.is_some_and(|x| x.agent.status == AgentStatus::Working);
            let fixed = fixer_entry.is_some_and(|x| x.agent.status == AgentStatus::Done);
            out.push(Note {
                resolved: st.resolved.contains(&id) || fixed,
                id,
                agent: a.id.clone(),
                by: by.clone(),
                level: raw.level,
                repo,
                path,
                line: raw.line,
                text: raw.text,
                hunk_id,
                busy,
                fixer,
            });
        }
    }
    out
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// The prompt sent to the agent asked to fix a note.
pub fn fix_prompt(n: &Note) -> String {
    format!(
        "The {} left this note on {}:{} ({}):\n{}\n\nFix it. Change only what the note asks for. Answer in the language of the note.",
        n.by.to_lowercase(),
        n.path,
        n.line,
        match n.level {
            Level::Blocking => "blocking",
            Level::Warning => "warning",
            Level::Info => "info",
        },
        n.text
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_note_lines_in_many_shapes() {
        let t = "Looks fine overall.\n\
                 NOTE blocking src/a.ts:42 the signature is not checked\n\
                 - NOTE warning `src/b.rs:7` query built with format!\n\
                 NOTE src/c.py:3: missing escape\n\
                 NOTE nothing here\n\
                 not a NOTE line\n";
        let n = parse(t);
        assert_eq!(n.len(), 3, "{n:?}");
        assert_eq!(n[0].level, Level::Blocking);
        assert_eq!(n[0].path, "src/a.ts");
        assert_eq!(n[0].line, 42);
        assert_eq!(n[0].text, "the signature is not checked");
        assert_eq!(n[1].level, Level::Warning);
        assert_eq!(n[1].path, "src/b.rs");
        assert_eq!(n[2].level, Level::Blocking);
        assert_eq!(n[2].text, "missing escape");
    }

    #[test]
    fn ids_are_stable() {
        let a = parse("NOTE info x.rs:1 hello");
        let b = parse("NOTE info x.rs:1 hello");
        assert_eq!(note_id("r1", &a[0]), note_id("r1", &b[0]));
        assert_ne!(note_id("r1", &a[0]), note_id("r2", &a[0]));
    }
}
