//! The normalized event stream every driver produces.

use serde::{Deserialize, Serialize};

/// One thing an agent did or said. Serialized as `{ "type": "toolCall", ... }` (camelCase).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AgentEvent {
    /// The harness gave the conversation an id; it is what a reply resumes.
    SessionStarted {
        session: String,
    },
    /// A whole message of the agent (not a chunk).
    Message {
        text: String,
    },
    /// What the model thought before acting, when the harness shows it.
    Reasoning {
        text: String,
    },
    Plan {
        steps: Vec<String>,
    },
    ToolCall {
        name: String,
        summary: String,
    },
    /// A file the agent wrote, relative to the run's working directory when possible.
    FileChanged {
        path: String,
    },
    /// A permission or approval request, or an explicit question to the user.
    Question {
        text: String,
        #[serde(default)]
        options: Vec<String>,
        /// Tools the harness refused and would run if the answer is yes.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tools: Vec<String>,
    },
    /// Tokens and cost of one segment of the run; the segments of a run add up.
    #[serde(rename_all = "camelCase")]
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        #[serde(default)]
        cost_usd: Option<f64>,
        model: String,
    },
    /// The work of a run was brought into the person's files (paths), except the files that
    /// conflict with their edits, which the agent is asked to resolve.
    #[serde(rename_all = "camelCase")]
    Applied {
        files: Vec<String>,
        #[serde(default)]
        conflicts: Vec<String>,
        /// The conflicts are in the person's files, with their markers, for them to resolve.
        #[serde(default)]
        to_you: bool,
    },
    /// The run ended well.
    Done {
        summary: String,
    },
    /// The run ended badly (the process failed, was cancelled, or the harness reported an error).
    Failed {
        error: String,
    },
    /// What the user asked or answered. Written to the log by the manager, never by a driver.
    Prompt {
        text: String,
    },
    /// Words to find the conversation again, from the Vela model. Never in the log.
    Labels {
        labels: Vec<String>,
        #[serde(default)]
        title: Option<String>,
    },
}

impl AgentEvent {
    /// Done or Failed: the last event of a run.
    pub fn is_terminal(&self) -> bool {
        matches!(self, AgentEvent::Done { .. } | AgentEvent::Failed { .. })
    }
}

/// First non empty line of `text`, trimmed and cut at `max` characters.
pub fn one_line(text: &str, max: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if line.chars().count() <= max {
        return line.to_string();
    }
    let cut: String = line.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}
