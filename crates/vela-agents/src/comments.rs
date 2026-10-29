//! Review comments: the user comments a line of the diff and an agent answers in a thread.
//!
//! A comment goes to a reviewer (it answers, reading only) or to a developer (it answers and
//! changes the code in its worktree, which comes back as proposals). Each reply of the user in
//! the thread is a follow up of the same agent. The answers are not stored: they are read
//! back from the agent's log, from the point where each turn of the thread started.
//!
//! The threads of a space are kept in `VELA_HOME/spaces/<space>.comments.json`.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use vela_core::model::{AgentRole, AgentStatus};
use vela_core::{Result, Vela, paths};

use crate::event::AgentEvent;
use crate::registry::{self, Entry, LogEntry};

/// One turn of the user in a thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub text: String,
    /// Length of the agent's log when this turn was sent: its answer follows.
    pub log_from: usize,
}

/// A thread as stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub repo: String,
    pub path: String,
    pub line: u32,
    /// The hunk the comment was left on; empty when none.
    #[serde(default)]
    pub hunk_id: String,
    pub role: AgentRole,
    /// The agent answering the thread.
    pub agent: String,
    pub turns: Vec<Turn>,
    #[serde(default)]
    pub resolved: bool,
    pub created: String,
}

/// One message of a thread, as the UI shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// "you" or "agent".
    pub from: String,
    pub text: String,
}

/// A thread as the UI shows it. Mirrors `ReviewComment` of the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentView {
    pub id: String,
    pub repo: String,
    pub path: String,
    pub line: u32,
    pub hunk_id: String,
    pub role: AgentRole,
    pub agent: String,
    /// e.g. "Reviewer · Claude Code".
    pub by: String,
    pub resolved: bool,
    /// The agent is writing its answer.
    pub busy: bool,
    /// The agent asks something (a permission): answer it in the agents view.
    pub waiting: bool,
    pub messages: Vec<Message>,
}

fn file(vela: &Vela, space: &str) -> PathBuf {
    paths::spaces_dir(&vela.home).join(format!("{space}.comments.json"))
}

pub fn load(vela: &Vela, space: &str) -> Vec<Thread> {
    fs::read_to_string(file(vela, space))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save(vela: &Vela, space: &str, list: &[Thread]) -> Result<()> {
    fs::create_dir_all(paths::spaces_dir(&vela.home))?;
    let text =
        serde_json::to_string_pretty(list).map_err(|e| vela_core::Error::Parse(e.to_string()))?;
    fs::write(file(vela, space), text)?;
    Ok(())
}

/// A new id, unique in the list.
pub fn next_id(list: &[Thread]) -> String {
    let n = list
        .iter()
        .filter_map(|t| t.id.strip_prefix('c')?.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    format!("c{}", n + 1)
}

/// What the agent is asked for a comment (the first turn of a thread).
pub fn first_prompt(
    role: AgentRole,
    repo: &str,
    path: &str,
    line: u32,
    code: &str,
    text: &str,
) -> String {
    let what = if role == AgentRole::Developer {
        "Answer in a few sentences, in the language of the comment. When the comment asks for \
         a change, make it, then say what you changed."
    } else {
        "Answer in a few sentences, in the language of the comment: explain, or say what \
         should change and why. Do not change any file."
    };
    let code = if code.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nThe lines it is about:\n```\n{}\n```", code.trim_end())
    };
    format!(
        "The user reviews the changes of this space and left a comment on {repo}/{path}, \
         line {line}:\n\n{text}{code}\n\n{what}"
    )
}

/// What the agent said after `from` in its log, up to `to` (the next turn).
fn answer(log: &[LogEntry], from: usize, to: usize) -> String {
    let seg = &log[from.min(log.len())..to.min(log.len())];
    // What the agent said between two tool calls is work in progress: the answer is what
    // follows its last tool call.
    let after_tools = seg
        .iter()
        .rposition(|e| {
            matches!(
                e.event,
                AgentEvent::ToolCall { .. } | AgentEvent::FileChanged { .. }
            )
        })
        .map_or(0, |i| i + 1);
    let msgs: Vec<&str> = seg[after_tools..]
        .iter()
        .filter_map(|e| match &e.event {
            AgentEvent::Message { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    if !msgs.is_empty() {
        return msgs.join("\n\n");
    }
    seg.iter()
        .rev()
        .find_map(|e| match &e.event {
            AgentEvent::Done { summary } if !summary.is_empty() => Some(summary.clone()),
            AgentEvent::Failed { error } => Some(format!("Failed: {error}")),
            _ => None,
        })
        .unwrap_or_default()
}

/// The threads of a space with the answers read from the agents' logs.
pub fn views(vela: &Vela, space: &str, entries: &[Entry]) -> Vec<CommentView> {
    load(vela, space)
        .into_iter()
        .map(|t| {
            let entry = entries.iter().find(|e| e.agent.id == t.agent);
            let log = registry::read_log(vela, space, &t.agent).unwrap_or_default();
            let mut messages = Vec::new();
            for (i, turn) in t.turns.iter().enumerate() {
                messages.push(Message {
                    from: "you".to_string(),
                    text: turn.text.clone(),
                });
                let to = t.turns.get(i + 1).map_or(log.len(), |n| n.log_from);
                let a = answer(&log, turn.log_from, to);
                if !a.trim().is_empty() {
                    messages.push(Message {
                        from: "agent".to_string(),
                        text: a.trim().to_string(),
                    });
                }
            }
            let status = entry.map(|e| e.agent.status);
            let by = match entry {
                Some(e) => format!(
                    "{} · {}",
                    capitalize(e.agent.role.as_str()),
                    crate::tiers::harness_label(&e.agent.tool)
                ),
                None => capitalize(t.role.as_str()),
            };
            CommentView {
                busy: status == Some(AgentStatus::Working),
                waiting: status == Some(AgentStatus::Waiting),
                id: t.id,
                repo: t.repo,
                path: t.path,
                line: t.line,
                hunk_id: t.hunk_id,
                role: t.role,
                agent: t.agent,
                by,
                resolved: t.resolved,
                messages,
            }
        })
        .collect()
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(event: AgentEvent) -> LogEntry {
        LogEntry {
            ts: String::new(),
            event,
        }
    }

    #[test]
    fn the_answer_of_a_turn_is_what_the_agent_said_until_the_next_turn() {
        let log = vec![
            entry(AgentEvent::Prompt {
                text: "why?".into(),
            }),
            entry(AgentEvent::Message {
                text: "because".into(),
            }),
            entry(AgentEvent::Done {
                summary: "because".into(),
            }),
            entry(AgentEvent::Prompt {
                text: "and then?".into(),
            }),
            entry(AgentEvent::Failed {
                error: "boom".into(),
            }),
        ];
        assert_eq!(answer(&log, 0, 3), "because");
        assert_eq!(answer(&log, 3, 5), "Failed: boom");
        assert_eq!(answer(&log, 9, 12), "");
    }

    #[test]
    fn what_the_agent_said_between_tool_calls_is_not_the_answer() {
        let log = vec![
            entry(AgentEvent::Message {
                text: "Je regarde le fichier.".into(),
            }),
            entry(AgentEvent::ToolCall {
                name: "Read".into(),
                summary: "a.rs".into(),
            }),
            entry(AgentEvent::Message {
                text: "C'est voulu.".into(),
            }),
        ];
        assert_eq!(answer(&log, 0, 3), "C'est voulu.");
    }

    #[test]
    fn ids_grow() {
        assert_eq!(next_id(&[]), "c1");
        let t = Thread {
            id: "c7".into(),
            repo: "api".into(),
            path: "a.ts".into(),
            line: 1,
            hunk_id: String::new(),
            role: AgentRole::Reviewer,
            agent: "reviewer-1".into(),
            turns: Vec::new(),
            resolved: false,
            created: String::new(),
        };
        assert_eq!(next_id(&[t]), "c8");
    }

    #[test]
    fn a_developer_is_told_it_may_change_the_code() {
        let p = first_prompt(AgentRole::Developer, "api", "a.ts", 3, "x", "rename this");
        assert!(p.contains("api/a.ts, line 3"));
        assert!(p.contains("make it"));
        let r = first_prompt(AgentRole::Reviewer, "api", "a.ts", 3, "", "why?");
        assert!(r.contains("Do not change"));
        assert!(!r.contains("```"));
    }
}
