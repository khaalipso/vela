//! Claude Code through `claude -p --output-format stream-json --verbose`.
//!
//! Stream lines (one JSON object each): `system/init` (session id, model), `assistant`
//! (content blocks: `text`, `tool_use`), `user` (tool results), `result` (cost, usage,
//! `permission_denials`). The prompt goes on stdin. A resumed run adds `--resume <session>`.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::Value;
use vela_core::{Error, Result};

use crate::driver::{AgentDriver, LineParser, RunHandle, RunSpec, launch, locate};
use crate::event::AgentEvent;
use crate::util::{rel_path, shorten, steps_from_text};

pub struct ClaudeDriver {
    bin: Option<PathBuf>,
}

impl ClaudeDriver {
    /// Looks `claude` up on `PATH` (and the usual install directories).
    pub fn new() -> Self {
        Self::with_path(None)
    }

    /// Looks `claude` up in `path` (the `PATH` format) only; used by tests.
    pub fn with_path(path: Option<&OsStr>) -> Self {
        ClaudeDriver {
            bin: locate("claude", path),
        }
    }

    pub fn with_bin(bin: impl Into<PathBuf>) -> Self {
        ClaudeDriver {
            bin: Some(bin.into()),
        }
    }
}

impl Default for ClaudeDriver {
    fn default() -> Self {
        Self::new()
    }
}

/// The arguments of `claude` for a run (the prompt is sent on stdin).
pub fn args(spec: &RunSpec) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(m) = &spec.model {
        a.extend(["--model".to_string(), m.clone()]);
    }
    if let Some(e) = &spec.effort {
        a.extend(["--effort".to_string(), e.clone()]);
    }
    a.extend([
        "--permission-mode".to_string(),
        if spec.read_only {
            "plan"
        } else {
            "acceptEdits"
        }
        .to_string(),
    ]);
    if let Some(s) = &spec.session {
        a.extend(["--resume".to_string(), s.clone()]);
    }
    a.extend(spec.extra_args.iter().cloned());
    a
}

impl AgentDriver for ClaudeDriver {
    fn harness(&self) -> &'static str {
        "claude"
    }

    fn start(&self, run: RunSpec) -> Result<RunHandle> {
        let bin = self
            .bin
            .as_deref()
            .ok_or_else(|| Error::Invalid("claude is not installed".to_string()))?;
        let parser = ClaudeParser::new(&run.cwd, run.model.as_deref());
        launch(
            bin,
            &args(&run),
            Some(run.prompt.clone()),
            &run.cwd,
            Box::new(parser),
        )
    }
}

pub struct ClaudeParser {
    cwd: PathBuf,
    model: String,
    session_sent: bool,
}

impl ClaudeParser {
    pub fn new(cwd: &Path, model: Option<&str>) -> Self {
        ClaudeParser {
            cwd: cwd.to_path_buf(),
            model: model.unwrap_or("claude").to_string(),
            session_sent: false,
        }
    }

    fn tool_use(&self, block: &Value, out: &mut Vec<AgentEvent>) {
        let name = block["name"].as_str().unwrap_or("tool");
        let input = &block["input"];
        match name {
            "TodoWrite" => {
                let steps: Vec<String> = input["todos"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|t| t["content"].as_str())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                if !steps.is_empty() {
                    out.push(AgentEvent::Plan { steps });
                }
            }
            "ExitPlanMode" => {
                if let Some(plan) = input["plan"].as_str() {
                    out.push(AgentEvent::Message {
                        text: plan.to_string(),
                    });
                    let steps = steps_from_text(plan);
                    if !steps.is_empty() {
                        out.push(AgentEvent::Plan { steps });
                    }
                }
            }
            "AskUserQuestion" => {
                let q = input["questions"]
                    .as_array()
                    .and_then(|a| a.first())
                    .unwrap_or(input);
                let text = q["question"].as_str().unwrap_or("The agent has a question");
                let options: Vec<String> = q["options"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|o| o["label"].as_str().or_else(|| o.as_str()))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                out.push(AgentEvent::Question {
                    text: text.to_string(),
                    options,
                    tools: Vec::new(),
                });
            }
            "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
                let path = input["file_path"]
                    .as_str()
                    .or_else(|| input["notebook_path"].as_str())
                    .unwrap_or("");
                let path = rel_path(&self.cwd, path);
                out.push(AgentEvent::ToolCall {
                    name: name.to_string(),
                    summary: path.clone(),
                });
                if !path.is_empty() {
                    out.push(AgentEvent::FileChanged { path });
                }
            }
            _ => out.push(AgentEvent::ToolCall {
                name: name.to_string(),
                summary: tool_summary(&self.cwd, input),
            }),
        }
    }

    fn result(&self, v: &Value, out: &mut Vec<AgentEvent>) {
        let usage = &v["usage"];
        let n = |k: &str| usage[k].as_u64().unwrap_or(0);
        let input =
            n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
        let output = n("output_tokens");
        if input > 0 || output > 0 || v["total_cost_usd"].is_number() {
            out.push(AgentEvent::Usage {
                input_tokens: input,
                output_tokens: output,
                cost_usd: v["total_cost_usd"].as_f64(),
                model: self.model.clone(),
            });
        }
        let denials: Vec<&Value> = v["permission_denials"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|d| {
                        !matches!(
                            d["tool_name"].as_str(),
                            Some("AskUserQuestion" | "ExitPlanMode") | None
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !denials.is_empty() {
            let mut tools: Vec<String> = Vec::new();
            let mut what: Vec<String> = Vec::new();
            for d in &denials {
                let tool = d["tool_name"].as_str().unwrap_or("tool");
                what.push(format!(
                    "{tool}: {}",
                    tool_summary(&self.cwd, &d["tool_input"])
                ));
                if !tools.iter().any(|t| t == tool) {
                    tools.push(tool.to_string());
                }
            }
            out.push(AgentEvent::Question {
                text: format!(
                    "Claude Code needs your permission to use {}",
                    what.join("; ")
                ),
                options: vec!["Allow".to_string(), "Deny".to_string()],
                tools,
            });
        }
        let text = v["result"].as_str().unwrap_or("").to_string();
        let failed = v["is_error"].as_bool().unwrap_or(false)
            || v["subtype"]
                .as_str()
                .is_some_and(|s| s.starts_with("error"));
        if failed {
            let error = if text.is_empty() {
                v["subtype"].as_str().unwrap_or("error").to_string()
            } else {
                text
            };
            out.push(AgentEvent::Failed { error });
        } else {
            out.push(AgentEvent::Done { summary: text });
        }
    }
}

fn tool_summary(cwd: &Path, input: &Value) -> String {
    for k in [
        "command",
        "file_path",
        "path",
        "pattern",
        "url",
        "query",
        "description",
        "prompt",
    ] {
        if let Some(s) = input[k].as_str() {
            let s = if k == "file_path" || k == "path" {
                rel_path(cwd, s)
            } else {
                s.to_string()
            };
            return shorten(&s, 120);
        }
    }
    String::new()
}

impl LineParser for ClaudeParser {
    fn parse(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if !self.session_sent
            && let Some(id) = v["session_id"].as_str().filter(|s| !s.is_empty())
        {
            self.session_sent = true;
            out.push(AgentEvent::SessionStarted {
                session: id.to_string(),
            });
        }
        match v["type"].as_str() {
            Some("system") => {
                if v["subtype"] == "init"
                    && let Some(m) = v["model"].as_str()
                {
                    self.model = m.to_string();
                }
            }
            Some("assistant") => {
                if let Some(m) = v["message"]["model"].as_str() {
                    self.model = m.to_string();
                }
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") => {
                            if let Some(t) = block["text"].as_str().filter(|t| !t.trim().is_empty())
                            {
                                out.push(AgentEvent::Message {
                                    text: t.trim().to_string(),
                                });
                            }
                        }
                        Some("tool_use") => self.tool_use(block, &mut out),
                        _ => {}
                    }
                }
            }
            Some("result") => self.result(&v, &mut out),
            _ => {}
        }
        out
    }
}
