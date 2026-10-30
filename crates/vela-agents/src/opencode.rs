//! opencode through `opencode run --format json`.
//!
//! Stream lines: `{"type": "step_start" | "text" | "tool_use" | "step_finish" | "error",
//! "sessionID": "ses_...", "part": {...}}`. `text` parts carry the message, `tool_use` parts
//! the tool with its input and state, `step_finish` the cost and tokens. When the installed
//! opencode prints plain text instead (before the first JSON line), each line is a Message.
//! The prompt is the last argument; a resumed run adds `--session <id>`; read only runs use
//! the built in `plan` agent, the others `build`. A tier's effort goes to `--variant`.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::Value;
use vela_core::{Error, Result};

use crate::driver::{AgentDriver, LineParser, RunHandle, RunSpec, launch_with_env, locate};
use crate::event::AgentEvent;
use crate::util::{plain_command, rel_path, shorten};

pub struct OpencodeDriver {
    bin: Option<PathBuf>,
}

impl OpencodeDriver {
    pub fn new() -> Self {
        Self::with_path(None)
    }

    pub fn with_path(path: Option<&OsStr>) -> Self {
        OpencodeDriver {
            bin: locate("opencode", path),
        }
    }

    pub fn with_bin(bin: impl Into<PathBuf>) -> Self {
        OpencodeDriver {
            bin: Some(bin.into()),
        }
    }
}

impl Default for OpencodeDriver {
    fn default() -> Self {
        Self::new()
    }
}

/// The arguments of `opencode` for a run, prompt last.
pub fn args(spec: &RunSpec) -> Vec<String> {
    // `--thinking`: the reasoning parts come in the JSON stream too.
    let mut a: Vec<String> = ["run", "--format", "json", "--thinking"]
        .map(String::from)
        .to_vec();
    if let Some(m) = &spec.model {
        a.extend(["-m".to_string(), m.clone()]);
    }
    if let Some(e) = &spec.effort {
        a.extend(["--variant".to_string(), e.clone()]);
    }
    a.extend(["--dir".to_string(), spec.cwd.to_string_lossy().into_owned()]);
    if let Some(s) = &spec.session {
        a.extend(["--session".to_string(), s.clone()]);
    }
    // Always name the agent: a `default_agent` in the user's opencode config may not exist in
    // this directory, and opencode then fails every prompt with "default agent not found".
    let agent = if spec.read_only { "plan" } else { "build" };
    a.extend(["--agent".to_string(), agent.to_string()]);
    a.extend(spec.extra_args.iter().cloned());
    // A prompt that starts with a dash would be read as an option.
    let prompt = if spec.prompt.starts_with('-') {
        format!(" {}", spec.prompt)
    } else {
        spec.prompt.clone()
    };
    a.push(prompt);
    a
}

/// The permissions of a writer run, as opencode reads them from `OPENCODE_PERMISSION`.
pub const WRITER_PERMISSION: &str = r#"{"edit":"allow","bash":"allow","webfetch":"allow"}"#;

impl AgentDriver for OpencodeDriver {
    fn harness(&self) -> &'static str {
        "opencode"
    }

    fn start(&self, run: RunSpec) -> Result<RunHandle> {
        let bin = self
            .bin
            .as_deref()
            .ok_or_else(|| Error::Invalid("opencode is not installed".to_string()))?;
        let parser = OpencodeParser::new(&run.cwd, run.model.as_deref());
        // A writer works in its own worktree: edits and commands there need no question.
        let env: &[(&str, &str)] = if run.read_only {
            &[]
        } else {
            &[("OPENCODE_PERMISSION", WRITER_PERMISSION)]
        };
        launch_with_env(bin, &args(&run), env, None, &run.cwd, Box::new(parser))
    }
}

pub struct OpencodeParser {
    cwd: PathBuf,
    model: String,
    session_sent: bool,
    json_seen: bool,
}

impl OpencodeParser {
    pub fn new(cwd: &Path, model: Option<&str>) -> Self {
        OpencodeParser {
            cwd: cwd.to_path_buf(),
            model: model.unwrap_or("opencode").to_string(),
            session_sent: false,
            json_seen: false,
        }
    }
}

const WRITE_TOOLS: [&str; 4] = ["edit", "write", "patch", "multiedit"];

impl LineParser for OpencodeParser {
    fn parse(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            // Plain text output, from a version without JSON: show it. Once JSON has been
            // seen, stray lines (logs) are noise.
            let t = line.trim();
            return if self.json_seen || t.is_empty() {
                Vec::new()
            } else {
                vec![AgentEvent::Message {
                    text: t.to_string(),
                }]
            };
        };
        if !v.is_object() {
            return Vec::new();
        }
        self.json_seen = true;
        let mut out = Vec::new();
        if !self.session_sent
            && let Some(id) = v["sessionID"].as_str().filter(|s| !s.is_empty())
        {
            self.session_sent = true;
            out.push(AgentEvent::SessionStarted {
                session: id.to_string(),
            });
        }
        let part = &v["part"];
        let ty = v["type"].as_str().unwrap_or("");
        match ty {
            "text" => {
                if let Some(t) = part["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    out.push(AgentEvent::Message {
                        text: t.trim().to_string(),
                    });
                }
            }
            "reasoning" => {
                if let Some(t) = part["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    out.push(AgentEvent::Reasoning {
                        text: t.trim().to_string(),
                    });
                }
            }
            "tool_use" => {
                let tool = part["tool"].as_str().unwrap_or("tool");
                let input = &part["state"]["input"];
                let file = input["filePath"]
                    .as_str()
                    .or_else(|| input["path"].as_str())
                    .map(|p| rel_path(&self.cwd, p));
                let summary = part["state"]["title"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| input["command"].as_str().map(str::to_string))
                    .or_else(|| file.clone())
                    .unwrap_or_default();
                out.push(AgentEvent::ToolCall {
                    name: tool.to_string(),
                    summary: shorten(&summary, 120),
                });
                if WRITE_TOOLS.contains(&tool)
                    && part["state"]["status"].as_str() != Some("error")
                    && let Some(f) = file.filter(|f| !f.is_empty())
                {
                    out.push(AgentEvent::FileChanged { path: f });
                }
            }
            "step_finish" => {
                let t = &part["tokens"];
                out.push(AgentEvent::Usage {
                    // Cache reads are left out: every step re-reads the whole context.
                    input_tokens: t["input"].as_u64().unwrap_or(0)
                        + t["cache"]["write"].as_u64().unwrap_or(0),
                    output_tokens: t["output"].as_u64().unwrap_or(0),
                    cost_usd: part["cost"].as_f64(),
                    model: self.model.clone(),
                });
            }
            "error" => {
                let e = &v["error"];
                let msg = e["data"]["message"]
                    .as_str()
                    .or_else(|| e["message"].as_str())
                    .or_else(|| e["name"].as_str())
                    .unwrap_or("opencode reported an error");
                out.push(AgentEvent::Failed {
                    error: msg.to_string(),
                });
            }
            t if t.contains("permission") => {
                let what = part["title"]
                    .as_str()
                    .or_else(|| v["title"].as_str())
                    .or_else(|| v["permission"].as_str())
                    .unwrap_or("an action");
                out.push(AgentEvent::Question {
                    text: shorten(&plain_command(what), 200),
                    options: vec!["Allow".to_string(), "Deny".to_string()],
                    tools: Vec::new(),
                });
            }
            _ => {}
        }
        out
    }
}
