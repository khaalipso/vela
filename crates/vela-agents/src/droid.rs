//! Factory's droid through `droid exec --output-format stream-json`.
//!
//! Stream lines: `{"type": "system" | "message" | "reasoning" | "tool_call" | "tool_result" | "completion" |
//! "error", "session_id": ..., ...}`. `system` (subtype `init`) carries the session and model,
//! `message` the text of the assistant (the echo of the prompt has role `user`), `tool_call` the
//! tool with its `parameters`, `completion` the final text and the token usage.
//! The prompt is the last argument; a resumed run adds `--session-id <id>`. Without `--auto`
//! droid is read only, which is what a read only run gets; a writer runs at `--auto medium`
//! (edits, builds, local git; no push, no sudo). A tier's effort goes to `--reasoning-effort`.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::Value;
use vela_core::{Error, Result};

use crate::driver::{AgentDriver, LineParser, RunHandle, RunSpec, launch, locate};
use crate::event::AgentEvent;
use crate::util::{rel_path, shorten};

pub struct DroidDriver {
    bin: Option<PathBuf>,
}

impl DroidDriver {
    pub fn new() -> Self {
        Self::with_path(None)
    }

    pub fn with_path(path: Option<&OsStr>) -> Self {
        DroidDriver {
            bin: locate("droid", path),
        }
    }

    pub fn with_bin(bin: impl Into<PathBuf>) -> Self {
        DroidDriver {
            bin: Some(bin.into()),
        }
    }
}

impl Default for DroidDriver {
    fn default() -> Self {
        Self::new()
    }
}

/// The arguments of `droid` for a run, prompt last.
pub fn args(spec: &RunSpec) -> Vec<String> {
    let mut a: Vec<String> = ["exec", "--output-format", "stream-json"]
        .map(String::from)
        .to_vec();
    if !spec.read_only {
        a.extend(["--auto".to_string(), "medium".to_string()]);
    }
    if let Some(m) = &spec.model {
        a.extend(["--model".to_string(), m.clone()]);
    }
    if let Some(e) = &spec.effort {
        a.extend(["--reasoning-effort".to_string(), e.clone()]);
    }
    a.extend(["--cwd".to_string(), spec.cwd.to_string_lossy().into_owned()]);
    if let Some(s) = &spec.session {
        a.extend(["--session-id".to_string(), s.clone()]);
    }
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

impl AgentDriver for DroidDriver {
    fn harness(&self) -> &'static str {
        "droid"
    }

    fn start(&self, run: RunSpec) -> Result<RunHandle> {
        let bin = self
            .bin
            .as_deref()
            .ok_or_else(|| Error::Invalid("droid is not installed".to_string()))?;
        let parser = DroidParser::new(&run.cwd, run.model.as_deref());
        launch(bin, &args(&run), None, &run.cwd, Box::new(parser))
    }
}

pub struct DroidParser {
    cwd: PathBuf,
    model: String,
    session_sent: bool,
}

impl DroidParser {
    pub fn new(cwd: &Path, model: Option<&str>) -> Self {
        DroidParser {
            cwd: cwd.to_path_buf(),
            model: model.unwrap_or("droid").to_string(),
            session_sent: false,
        }
    }
}

const WRITE_TOOLS: [&str; 3] = ["Edit", "Create", "MultiEdit"];

/// The files an `ApplyPatch` patch touches (`*** Add File: p`, `*** Update File: p`).
fn patched_files(patch: &str) -> Vec<String> {
    patch
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            ["*** Add File:", "*** Update File:"]
                .iter()
                .find_map(|p| l.strip_prefix(p))
        })
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

impl LineParser for DroidParser {
    fn parse(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        if !v.is_object() {
            return Vec::new();
        }
        let mut out = Vec::new();
        if !self.session_sent
            && let Some(id) = v["session_id"].as_str().filter(|s| !s.is_empty())
        {
            self.session_sent = true;
            out.push(AgentEvent::SessionStarted {
                session: id.to_string(),
            });
        }
        match v["type"].as_str().unwrap_or("") {
            "system" => {
                if self.model == "droid"
                    && let Some(m) = v["model"].as_str().filter(|m| !m.is_empty())
                {
                    self.model = m.to_string();
                }
            }
            "message" if v["role"].as_str() == Some("assistant") => {
                if let Some(t) = v["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    out.push(AgentEvent::Message {
                        text: t.trim().to_string(),
                    });
                }
            }
            "reasoning" => {
                if let Some(t) = v["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    out.push(AgentEvent::Reasoning {
                        text: t.trim().to_string(),
                    });
                }
            }
            "tool_call" => {
                let tool = v["toolName"].as_str().unwrap_or("tool");
                let p = &v["parameters"];
                let file = p["file_path"]
                    .as_str()
                    .or_else(|| p["path"].as_str())
                    .map(|f| rel_path(&self.cwd, f));
                let summary = p["command"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| file.clone())
                    .or_else(|| p["pattern"].as_str().map(str::to_string))
                    .unwrap_or_default();
                out.push(AgentEvent::ToolCall {
                    name: tool.to_string(),
                    summary: shorten(&summary, 120),
                });
                if WRITE_TOOLS.contains(&tool)
                    && let Some(f) = file.filter(|f| !f.is_empty())
                {
                    out.push(AgentEvent::FileChanged { path: f });
                }
                if tool == "ApplyPatch" {
                    let patch = p["input"].as_str().or_else(|| p.as_str()).unwrap_or("");
                    for f in patched_files(patch) {
                        out.push(AgentEvent::FileChanged {
                            path: rel_path(&self.cwd, &f),
                        });
                    }
                }
            }
            "completion" => {
                let u = &v["usage"];
                out.push(AgentEvent::Usage {
                    // Cache reads are left out: every turn re-reads the whole context.
                    input_tokens: u["input_tokens"].as_u64().unwrap_or(0)
                        + u["cache_creation_input_tokens"].as_u64().unwrap_or(0),
                    output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
                    cost_usd: None,
                    model: self.model.clone(),
                });
                out.push(AgentEvent::Done {
                    summary: v["finalText"].as_str().unwrap_or("").trim().to_string(),
                });
            }
            "error" => out.push(AgentEvent::Failed {
                error: v["message"]
                    .as_str()
                    .unwrap_or("droid reported an error")
                    .to_string(),
            }),
            _ => {}
        }
        out
    }
}
