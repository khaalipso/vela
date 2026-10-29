//! The agents of a space on disk.
//!
//! - `VELA_HOME/spaces/<space>.agents.json`: one [`Entry`] per agent.
//! - `VELA_HOME/spaces/<space>.agents/<agent>.jsonl`: every event of the agent, appended, one
//!   `{ "ts": ..., "event": ... }` per line. The UI shows it as the history of the agent.
//!
//! An agent that was `working` when Vela stopped has no process any more: [`recover`] marks it
//! `interrupted` the next time the space is read.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use vela_core::model::{Agent, AgentRole, AgentStatus, AgentUsage};
use vela_core::space::rfc3339;
use vela_core::{Error, Result, Vela, paths};

use crate::event::{AgentEvent, one_line};

/// An agent plus what only Vela needs to continue or judge it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub agent: Agent,
    /// Repo name → tree the agent started from (proposals are the changes since).
    #[serde(default)]
    pub bases: Vec<(String, String)>,
    #[serde(default)]
    pub read_only: bool,
    /// Tools the harness refused while the agent waits; an "allow" answer grants them.
    #[serde(default)]
    pub pending_tools: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogEntry {
    pub ts: String,
    pub event: AgentEvent,
}

static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn registry_file(vela: &Vela, space: &str) -> PathBuf {
    paths::spaces_dir(&vela.home).join(format!("{space}.agents.json"))
}

pub fn log_dir(vela: &Vela, space: &str) -> PathBuf {
    paths::spaces_dir(&vela.home).join(format!("{space}.agents"))
}

pub fn log_file(vela: &Vela, space: &str, agent: &str) -> PathBuf {
    log_dir(vela, space).join(format!("{agent}.jsonl"))
}

pub fn now() -> String {
    rfc3339(SystemTime::now())
}

fn load_unlocked(vela: &Vela, space: &str) -> Result<Vec<Entry>> {
    match fs::read_to_string(registry_file(vela, space)) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| Error::Parse(format!("agents of {space}: {e}")))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

fn save_unlocked(vela: &Vela, space: &str, entries: &[Entry]) -> Result<()> {
    fs::create_dir_all(paths::spaces_dir(&vela.home))?;
    let file = registry_file(vela, space);
    let tmp = file.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(entries)
        .map_err(|e| Error::Parse(format!("agents of {space}: {e}")))?;
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &file)?;
    Ok(())
}

pub fn load(vela: &Vela, space: &str) -> Result<Vec<Entry>> {
    let _g = lock();
    load_unlocked(vela, space)
}

/// Add an entry.
pub fn insert(vela: &Vela, space: &str, entry: Entry) -> Result<()> {
    let _g = lock();
    let mut all = load_unlocked(vela, space)?;
    all.retain(|e| e.agent.id != entry.agent.id);
    all.push(entry);
    save_unlocked(vela, space, &all)
}

/// Change one entry and save. Returns the entry as saved.
pub fn update<F: FnOnce(&mut Entry)>(vela: &Vela, space: &str, agent: &str, f: F) -> Result<Entry> {
    let _g = lock();
    let mut all = load_unlocked(vela, space)?;
    let e = all
        .iter_mut()
        .find(|e| e.agent.id == agent)
        .ok_or_else(|| Error::Invalid(format!("no such agent: {agent}")))?;
    f(e);
    let out = e.clone();
    save_unlocked(vela, space, &all)?;
    Ok(out)
}

/// Add an entry under the next free id of its role. `make` runs while the registry is locked,
/// so two requests never get the same id and the caller can mark the agent live before any
/// reader sees it.
pub fn insert_next<F: FnOnce(String) -> Entry>(
    vela: &Vela,
    space: &str,
    role: AgentRole,
    make: F,
) -> Result<Entry> {
    let _g = lock();
    let mut all = load_unlocked(vela, space)?;
    let entry = make(next_id(&all, role));
    all.push(entry.clone());
    save_unlocked(vela, space, &all)?;
    Ok(entry)
}

pub fn remove(vela: &Vela, space: &str, agent: &str) -> Result<()> {
    let _g = lock();
    let mut all = load_unlocked(vela, space)?;
    all.retain(|e| e.agent.id != agent);
    save_unlocked(vela, space, &all)
}

pub fn find(vela: &Vela, space: &str, agent: &str) -> Result<Entry> {
    load(vela, space)?
        .into_iter()
        .find(|e| e.agent.id == agent)
        .ok_or_else(|| Error::Invalid(format!("no such agent: {agent}")))
}

/// `<role>-<n>`, with `n` one above the highest used for that role.
pub fn next_id(entries: &[Entry], role: AgentRole) -> String {
    let prefix = format!("{}-", role.as_str());
    let max = entries
        .iter()
        .filter_map(|e| e.agent.id.strip_prefix(&prefix)?.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    format!("{prefix}{}", max + 1)
}

/// Mark the agents that claim to work but have no live process as interrupted.
/// Returns whether anything changed.
pub fn recover(vela: &Vela, space: &str, is_live: &dyn Fn(&str) -> bool) -> Result<bool> {
    let _g = lock();
    let mut all = load_unlocked(vela, space)?;
    let mut changed = false;
    for e in &mut all {
        if e.agent.status == AgentStatus::Working && !is_live(&e.agent.id) {
            e.agent.status = AgentStatus::Interrupted;
            e.agent.finished = Some(now());
            if e.agent.summary.is_empty() {
                e.agent.summary = "Interrupted when Vela closed".to_string();
            }
            changed = true;
        }
    }
    if changed {
        save_unlocked(vela, space, &all)?;
    }
    Ok(changed)
}

/// Fold one event into the entry.
pub fn apply_event(entry: &mut Entry, ev: &AgentEvent, ts: &str) {
    let a = &mut entry.agent;
    if !matches!(ev, AgentEvent::Labels { .. }) {
        a.last_event = Some(ts.to_string());
    }
    match ev {
        AgentEvent::SessionStarted { session } => a.session = Some(session.clone()),
        AgentEvent::Message { text } => {
            a.last_message = text.clone();
            a.summary = one_line(text, 160);
            a.activity = "Writing".to_string();
        }
        AgentEvent::Plan { steps } => a.plan = steps.clone(),
        AgentEvent::ToolCall { name, summary } => {
            a.activity = if summary.trim().is_empty() {
                name.clone()
            } else {
                one_line(&format!("{name}: {summary}"), 120)
            };
        }
        AgentEvent::FileChanged { path } => a.activity = one_line(&format!("Edited {path}"), 120),
        AgentEvent::Prompt { .. } => {}
        AgentEvent::Labels { labels } => a.labels = labels.clone(),
        AgentEvent::Question {
            text,
            options,
            tools,
        } => {
            a.question = Some(text.clone());
            a.options = options.clone();
            // Waiting from now: a live run (ACP) stays paused until the answer comes.
            a.status = AgentStatus::Waiting;
            a.activity.clear();
            entry.pending_tools = tools.clone();
            if a.summary.is_empty() {
                a.summary = one_line(text, 160);
            }
        }
        AgentEvent::Usage {
            input_tokens,
            output_tokens,
            cost_usd,
            model,
        } => {
            a.usage.input_tokens += input_tokens;
            a.usage.output_tokens += output_tokens;
            a.usage.cost_usd += cost_usd.unwrap_or(0.0);
            if a.model.is_none() && !matches!(model.as_str(), "claude" | "codex" | "opencode") {
                a.model = Some(model.clone());
            }
        }
        AgentEvent::Done { summary } => {
            if a.question.is_some() {
                a.status = AgentStatus::Waiting;
            } else {
                a.status = AgentStatus::Done;
                a.activity.clear();
                a.finished = Some(ts.to_string());
                if !summary.trim().is_empty() {
                    a.summary = one_line(summary, 160);
                    if a.last_message.is_empty() {
                        a.last_message = summary.clone();
                    }
                }
            }
        }
        AgentEvent::Failed { error } => {
            a.status = AgentStatus::Failed;
            a.activity.clear();
            a.finished = Some(ts.to_string());
            a.question = None;
            a.options.clear();
            a.summary = if error == "cancelled" {
                "Cancelled".to_string()
            } else {
                one_line(error, 160)
            };
        }
    }
}

/// Put an entry back to work for a new run (ask or reply).
pub fn begin_run(entry: &mut Entry) {
    entry.agent.status = AgentStatus::Working;
    entry.agent.question = None;
    entry.agent.options.clear();
    entry.pending_tools.clear();
    entry.agent.finished = None;
    entry.agent.activity = "Starting".to_string();
    entry.agent.last_event = Some(now());
}

/// Append one event to the log of an agent.
pub fn append_log(vela: &Vela, space: &str, agent: &str, event: &AgentEvent) -> Result<()> {
    let _g = lock();
    fs::create_dir_all(log_dir(vela, space))?;
    let line = serde_json::to_string(&LogEntry {
        ts: now(),
        event: event.clone(),
    })
    .map_err(|e| Error::Parse(e.to_string()))?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file(vela, space, agent))?;
    writeln!(f, "{line}")?;
    Ok(())
}

/// The log of an agent. Lines that do not parse (a write cut short by a crash) are skipped.
pub fn read_log(vela: &Vela, space: &str, agent: &str) -> Result<Vec<LogEntry>> {
    match fs::read_to_string(log_file(vela, space, agent)) {
        Ok(text) => Ok(text
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

/// Tokens and cost of all the agents of a space.
pub fn totals(entries: &[Entry]) -> AgentUsage {
    let mut t = AgentUsage::default();
    for e in entries {
        t.input_tokens += e.agent.usage.input_tokens;
        t.output_tokens += e.agent.usage.output_tokens;
        t.cost_usd += e.agent.usage.cost_usd;
    }
    t
}
