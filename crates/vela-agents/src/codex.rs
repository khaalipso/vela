//! Codex through `codex exec --json`.
//!
//! Stream lines: `thread.started` (thread id), `turn.started`, `item.started|updated|completed`
//! (items: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`,
//! `web_search`, `todo_list`), `turn.completed` (usage), `turn.failed`, `error`. The prompt goes
//! on stdin (`-`). A resumed run is `codex exec resume <thread> -`.
//!
//! `codex exec` never asks for approval: commands the sandbox refuses just fail. Events whose
//! type mentions an approval are still turned into questions, in case a newer Codex sends them.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::Value;
use vela_core::{Error, Result};

use crate::driver::{AgentDriver, LineParser, RunHandle, RunSpec, launch, locate};
use crate::event::AgentEvent;
use crate::util::{rel_path, shorten};

pub struct CodexDriver {
    bin: Option<PathBuf>,
}

impl CodexDriver {
    pub fn new() -> Self {
        Self::with_path(None)
    }

    pub fn with_path(path: Option<&OsStr>) -> Self {
        CodexDriver {
            bin: locate("codex", path),
        }
    }

    pub fn with_bin(bin: impl Into<PathBuf>) -> Self {
        CodexDriver {
            bin: Some(bin.into()),
        }
    }
}

impl Default for CodexDriver {
    fn default() -> Self {
        Self::new()
    }
}

/// The arguments of `codex` for a run (the prompt is sent on stdin).
pub fn args(spec: &RunSpec) -> Vec<String> {
    let sandbox = if spec.read_only {
        "read-only"
    } else {
        "workspace-write"
    };
    let mut a: Vec<String> = vec!["exec".to_string()];
    if let Some(session) = &spec.session {
        // `exec resume` takes no -C or -s: the working directory is the process's, and the
        // sandbox is set through the config override.
        a.extend(["resume", "--json", "--skip-git-repo-check"].map(String::from));
        a.extend(["-c".to_string(), format!("sandbox_mode=\"{sandbox}\"")]);
        if let Some(m) = &spec.model {
            a.extend(["-m".to_string(), m.clone()]);
        }
        a.extend(spec.extra_args.iter().cloned());
        a.push(session.clone());
    } else {
        a.extend(["--json", "--skip-git-repo-check"].map(String::from));
        a.extend(["-C".to_string(), spec.cwd.to_string_lossy().into_owned()]);
        a.extend(["-s".to_string(), sandbox.to_string()]);
        if let Some(m) = &spec.model {
            a.extend(["-m".to_string(), m.clone()]);
        }
        a.extend(spec.extra_args.iter().cloned());
    }
    a.push("-".to_string());
    a
}

impl AgentDriver for CodexDriver {
    fn harness(&self) -> &'static str {
        "codex"
    }

    fn start(&self, run: RunSpec) -> Result<RunHandle> {
        let bin = self
            .bin
            .as_deref()
            .ok_or_else(|| Error::Invalid("codex is not installed".to_string()))?;
        let parser = CodexParser::new(&run.cwd, run.model.as_deref());
        launch(
            bin,
            &args(&run),
            Some(run.prompt.clone()),
            &run.cwd,
            Box::new(parser),
        )
    }
}

pub struct CodexParser {
    cwd: PathBuf,
    model: String,
    last_message: String,
    seen: HashSet<String>,
    last_plan: Vec<String>,
}

impl CodexParser {
    pub fn new(cwd: &Path, model: Option<&str>) -> Self {
        CodexParser {
            cwd: cwd.to_path_buf(),
            model: model.unwrap_or("codex").to_string(),
            last_message: String::new(),
            seen: HashSet::new(),
            last_plan: Vec::new(),
        }
    }

    fn item(&mut self, phase: &str, item: &Value, out: &mut Vec<AgentEvent>) {
        let kind = item["type"].as_str().unwrap_or("");
        let id = item["id"].as_str().unwrap_or("").to_string();
        if kind.contains("approval") {
            out.push(approval(item));
            return;
        }
        match kind {
            "agent_message" if phase == "completed" => {
                if let Some(t) = item["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    self.last_message = t.trim().to_string();
                    out.push(AgentEvent::Message {
                        text: self.last_message.clone(),
                    });
                }
            }
            "command_execution" => {
                if self.seen.insert(id) {
                    out.push(AgentEvent::ToolCall {
                        name: "shell".to_string(),
                        summary: shorten(item["command"].as_str().unwrap_or(""), 120),
                    });
                }
            }
            "file_change" if phase == "completed" => {
                if item["status"].as_str() == Some("failed") {
                    return;
                }
                for c in item["changes"].as_array().into_iter().flatten() {
                    if let Some(p) = c["path"].as_str() {
                        let path = rel_path(&self.cwd, p);
                        out.push(AgentEvent::ToolCall {
                            name: "file_change".to_string(),
                            summary: path.clone(),
                        });
                        out.push(AgentEvent::FileChanged { path });
                    }
                }
            }
            "mcp_tool_call" => {
                if self.seen.insert(id) {
                    out.push(AgentEvent::ToolCall {
                        name: format!(
                            "{}.{}",
                            item["server"].as_str().unwrap_or("mcp"),
                            item["tool"].as_str().unwrap_or("tool")
                        ),
                        summary: String::new(),
                    });
                }
            }
            "web_search" => {
                if self.seen.insert(id) {
                    out.push(AgentEvent::ToolCall {
                        name: "web_search".to_string(),
                        summary: shorten(item["query"].as_str().unwrap_or(""), 120),
                    });
                }
            }
            "todo_list" => {
                let steps: Vec<String> = item["items"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|i| i["text"].as_str())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                if !steps.is_empty() && steps != self.last_plan {
                    self.last_plan = steps.clone();
                    out.push(AgentEvent::Plan { steps });
                }
            }
            _ => {}
        }
    }
}

fn approval(v: &Value) -> AgentEvent {
    let text = ["command", "reason", "message", "text"]
        .iter()
        .find_map(|k| v[*k].as_str())
        .map(|s| format!("Codex asks to run: {}", shorten(s, 160)))
        .unwrap_or_else(|| "Codex asks for approval".to_string());
    AgentEvent::Question {
        text,
        options: vec!["Approve".to_string(), "Deny".to_string()],
        tools: Vec::new(),
    }
}

impl LineParser for CodexParser {
    fn parse(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let ty = v["type"].as_str().unwrap_or("");
        let mut out = Vec::new();
        match ty {
            "thread.started" => {
                if let Some(id) = v["thread_id"].as_str() {
                    out.push(AgentEvent::SessionStarted {
                        session: id.to_string(),
                    });
                }
            }
            "item.started" | "item.updated" | "item.completed" => {
                let phase = ty.trim_start_matches("item.");
                self.item(phase, &v["item"], &mut out);
            }
            "turn.completed" => {
                let u = &v["usage"];
                out.push(AgentEvent::Usage {
                    input_tokens: u["input_tokens"].as_u64().unwrap_or(0),
                    output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
                    cost_usd: None,
                    model: self.model.clone(),
                });
                out.push(AgentEvent::Done {
                    summary: self.last_message.clone(),
                });
            }
            "turn.failed" => out.push(AgentEvent::Failed {
                error: v["error"]["message"]
                    .as_str()
                    .unwrap_or("the turn failed")
                    .to_string(),
            }),
            t if t.contains("approval") => out.push(approval(&v)),
            _ => {}
        }
        out
    }
}
