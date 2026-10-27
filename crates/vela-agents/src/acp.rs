//! ACP (Agent Client Protocol): one JSON-RPC protocol over stdio for every harness that
//! speaks it (`opencode acp`, `gemini --experimental-acp`, the `claude-code-acp` and
//! `codex-acp` adapters). Vela is the client.
//!
//! A run is: `initialize`, `session/new` (or `session/load` to resume, its replayed history
//! is skipped), the model, effort and mode set through the session's config options (or the
//! older `session/set_model` / `session/set_mode`), then one `session/prompt`. Its response
//! ends the run and the process is stopped.
//!
//! Unlike the line based transports, a permission request (`session/request_permission`)
//! does not end the run: it becomes a Question, and the answer goes back to the live process
//! through the handle's replier.
//!
//! The client offers no file system or terminal capability: the harness uses its own tools
//! in the agent's worktree.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use vela_core::{Error, Result};

use crate::driver::{AgentDriver, Ctl, Replier, RunHandle, RunSpec, kill_group, locate};
use crate::event::AgentEvent;
use crate::util::{rel_path, shorten};

const PROTOCOL_VERSION: u64 = 1;
const ID_INIT: u64 = 1;
const ID_SESSION: u64 = 2;
const ID_PROMPT: u64 = 3;
/// Ids of the setup requests (model, effort, mode) start here.
const ID_SETUP: u64 = 100;

/// A harness reached through ACP: the binary and the arguments that start its ACP server.
pub struct AcpDriver {
    harness: &'static str,
    bin: Option<PathBuf>,
    args: Vec<String>,
}

impl AcpDriver {
    pub fn new(harness: &'static str, bin: Option<PathBuf>, args: &[&str]) -> Self {
        AcpDriver {
            harness,
            bin,
            args: args.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// The ACP server of a harness, if Vela knows how to start one and it is installed.
    pub fn for_harness(harness: &str, path: Option<&OsStr>) -> Option<Self> {
        let (name, bin, args): (&'static str, &str, &[&str]) = match harness {
            "opencode" => ("opencode", "opencode", &["acp"]),
            "claude" => ("claude", "claude-code-acp", &[]),
            "codex" => ("codex", "codex-acp", &[]),
            "gemini" => ("gemini", "gemini", &["--experimental-acp"]),
            _ => return None,
        };
        let found = locate(bin, path)?;
        Some(AcpDriver::new(name, Some(found), args))
    }

    pub fn with_bin(harness: &'static str, bin: impl Into<PathBuf>, args: &[&str]) -> Self {
        AcpDriver::new(harness, Some(bin.into()), args)
    }
}

impl AgentDriver for AcpDriver {
    fn harness(&self) -> &'static str {
        self.harness
    }

    fn start(&self, run: RunSpec) -> Result<RunHandle> {
        let bin = self.bin.as_deref().ok_or_else(|| {
            Error::Invalid(format!(
                "the ACP server of {} is not installed",
                self.harness
            ))
        })?;
        launch(bin, &self.args, run)
    }
}

/// A permission request waiting for the user.
struct Pending {
    id: Value,
    /// (optionId, name, kind)
    options: Vec<(String, String, String)>,
}

struct Shared {
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<Option<Pending>>,
}

impl Shared {
    fn send(&self, v: &Value) {
        if let Ok(mut g) = self.stdin.lock()
            && let Some(w) = g.as_mut()
        {
            let mut line = v.to_string();
            line.push('\n');
            let _ = w.write_all(line.as_bytes()).and_then(|_| w.flush());
        }
    }
}

/// The option an answer picks: an option named by the answer, else the first allow option
/// for a yes and the first reject option for anything else.
pub fn pick_option(options: &[(String, String, String)], answer: &str) -> Option<String> {
    let a = answer.trim().to_lowercase();
    if let Some((id, _, _)) = options
        .iter()
        .find(|(id, name, _)| name.to_lowercase() == a || id.to_lowercase() == a)
    {
        return Some(id.clone());
    }
    let want = if crate::manager::is_yes(answer) {
        ["allow_once", "allow_always", "allow"]
    } else {
        ["reject_once", "reject_always", "reject"]
    };
    want.iter()
        .find_map(|k| options.iter().find(|(_, _, kind)| kind == k))
        .or_else(|| {
            options.iter().find(|(_, _, kind)| {
                kind.starts_with(if want[0].starts_with('a') {
                    "allow"
                } else {
                    "reject"
                })
            })
        })
        .map(|(id, _, _)| id.clone())
}

fn launch(bin: &Path, args: &[String], spec: RunSpec) -> Result<RunHandle> {
    let mut child = Command::new(bin)
        .args(args)
        .current_dir(&spec.cwd)
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| Error::Invalid(format!("cannot start {}: {e}", bin.display())))?;
    let ctl = Arc::new(Ctl {
        pid: child.id(),
        cancelled: AtomicBool::new(false),
    });
    let shared = Arc::new(Shared {
        stdin: Mutex::new(child.stdin.take()),
        pending: Mutex::new(None),
    });
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let err_tail = Arc::new(Mutex::new(String::new()));
    let err_thread = {
        let tail = err_tail.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf);
            let text = String::from_utf8_lossy(&buf).into_owned();
            let lines: Vec<&str> = text.lines().rev().take(12).collect();
            if let Ok(mut t) = tail.lock() {
                *t = lines.into_iter().rev().collect::<Vec<_>>().join("\n");
            }
        })
    };
    let (tx, rx) = channel();
    let session = Session::new(spec, shared.clone(), tx);
    shared.send(&json!({
        "jsonrpc": "2.0", "id": ID_INIT, "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "vela", "version": env!("CARGO_PKG_VERSION") }
        }
    }));
    let thread_ctl = ctl.clone();
    let pid = ctl.pid;
    std::thread::spawn(move || {
        let mut s = session;
        let mut reader = BufReader::new(stdout);
        let mut raw = Vec::new();
        loop {
            raw.clear();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&raw);
                    if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                        s.handle(&v);
                    }
                    if s.finished {
                        // The prompt is answered: the server has nothing more to say.
                        if let Ok(mut g) = s.shared.stdin.lock() {
                            g.take();
                        }
                        kill_group(pid);
                        break;
                    }
                }
            }
        }
        let _ = child.wait();
        let _ = err_thread.join();
        if !s.terminal {
            let error = if thread_ctl.cancelled.load(Ordering::SeqCst) {
                "cancelled".to_string()
            } else {
                let tail = err_tail.lock().map(|t| t.clone()).unwrap_or_default();
                if tail.is_empty() {
                    "the ACP server stopped before answering".to_string()
                } else {
                    tail
                }
            };
            s.emit(AgentEvent::Failed { error });
        }
    });
    let replier: Replier = {
        let shared = shared.clone();
        Arc::new(move |answer: &str| {
            let Some(p) = shared.pending.lock().ok().and_then(|mut g| g.take()) else {
                return false;
            };
            let outcome = match pick_option(&p.options, answer) {
                Some(id) => json!({ "outcome": "selected", "optionId": id }),
                None => json!({ "outcome": "cancelled" }),
            };
            shared.send(&json!({ "jsonrpc": "2.0", "id": p.id, "result": { "outcome": outcome } }));
            true
        })
    };
    Ok(RunHandle::from_parts(rx, ctl, Some(replier)))
}

/// The client side of one run: turns what the server sends into events.
struct Session {
    spec: RunSpec,
    shared: Arc<Shared>,
    tx: Sender<AgentEvent>,
    session_id: Option<String>,
    /// `session/load` replays the history as updates: skip them until it answers.
    replaying: bool,
    setup: VecDeque<Value>,
    next_setup: u64,
    text: String,
    last_text: String,
    tools: HashMap<String, (String, String)>,
    announced: HashSet<String>,
    changed: HashSet<String>,
    cost: Option<f64>,
    terminal: bool,
    finished: bool,
}

impl Session {
    fn new(spec: RunSpec, shared: Arc<Shared>, tx: Sender<AgentEvent>) -> Self {
        Session {
            spec,
            shared,
            tx,
            session_id: None,
            replaying: false,
            setup: VecDeque::new(),
            next_setup: ID_SETUP,
            text: String::new(),
            last_text: String::new(),
            tools: HashMap::new(),
            announced: HashSet::new(),
            changed: HashSet::new(),
            cost: None,
            terminal: false,
            finished: false,
        }
    }

    fn emit(&mut self, e: AgentEvent) {
        if self.terminal {
            return;
        }
        if e.is_terminal() {
            self.terminal = true;
        }
        let _ = self.tx.send(e);
    }

    fn flush_text(&mut self) {
        let t = self.text.trim().to_string();
        self.text.clear();
        if !t.is_empty() {
            self.last_text = t.clone();
            self.emit(AgentEvent::Message { text: t });
        }
    }

    fn fail(&mut self, error: String) {
        self.flush_text();
        self.emit(AgentEvent::Failed { error });
        self.finished = true;
    }

    fn request(&self, id: u64, method: &str, params: Value) {
        self.shared
            .send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
    }

    fn handle(&mut self, v: &Value) {
        let method = v["method"].as_str();
        match (method, v.get("id")) {
            // A request from the server.
            (Some(m), Some(id)) => self.on_request(m, id.clone(), &v["params"]),
            (Some("session/update"), None) => {
                if !self.replaying {
                    self.on_update(&v["params"]["update"]);
                }
            }
            (Some(_), None) => {}
            (None, Some(id)) => {
                let id = id.as_u64().unwrap_or(0);
                if let Some(err) = v.get("error") {
                    self.on_error(id, err);
                } else {
                    self.on_result(id, &v["result"]);
                }
            }
            (None, None) => {}
        }
    }

    fn on_error(&mut self, id: u64, err: &Value) {
        let msg = err["message"].as_str().unwrap_or("error").to_string();
        let detail = err["data"]["message"]
            .as_str()
            .or_else(|| err["data"].as_str())
            .map(|d| format!(": {d}"))
            .unwrap_or_default();
        match id {
            ID_INIT => self.fail(format!("ACP initialize failed: {msg}{detail}")),
            ID_SESSION if self.spec.session.is_some() && self.replaying => {
                // The session cannot be loaded: start a new one, the prompt says what to do.
                self.replaying = false;
                self.spec.session = None;
                self.new_session();
            }
            ID_SESSION => self.fail(format!("cannot start an ACP session: {msg}{detail}")),
            ID_PROMPT => self.fail(format!("{msg}{detail}")),
            // A model or mode the server does not take: keep its default.
            _ => self.next_step(),
        }
    }

    fn new_session(&mut self) {
        self.request(
            ID_SESSION,
            "session/new",
            json!({ "cwd": self.spec.cwd.to_string_lossy(), "mcpServers": [] }),
        );
    }

    fn on_result(&mut self, id: u64, r: &Value) {
        match id {
            ID_INIT => {
                let can_load = r["agentCapabilities"]["loadSession"].as_bool() == Some(true);
                match self.spec.session.clone() {
                    Some(sid) if can_load => {
                        self.replaying = true;
                        self.request(
                            ID_SESSION,
                            "session/load",
                            json!({ "sessionId": sid, "cwd": self.spec.cwd.to_string_lossy(), "mcpServers": [] }),
                        );
                    }
                    _ => self.new_session(),
                }
            }
            ID_SESSION => {
                self.replaying = false;
                let sid = r["sessionId"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| self.spec.session.clone());
                let Some(sid) = sid else {
                    return self.fail("the ACP server gave no session id".to_string());
                };
                self.session_id = Some(sid.clone());
                self.emit(AgentEvent::SessionStarted {
                    session: sid.clone(),
                });
                self.plan_setup(&sid, r);
                self.next_step();
            }
            ID_PROMPT => self.on_prompt_done(r),
            _ => self.next_step(),
        }
    }

    /// The requests that set the model, the effort and the mode, from what the session offers.
    fn plan_setup(&mut self, sid: &str, r: &Value) {
        let opts = r["configOptions"].as_array().cloned().unwrap_or_default();
        let find = |pred: &dyn Fn(&Value) -> bool| opts.iter().find(|o| pred(o)).cloned();
        let values = |o: &Value| -> Vec<String> {
            o["options"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x["value"].as_str().or_else(|| x["id"].as_str()))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        let set = |config: &str, value: &str| {
            json!({ "method": "session/set_config_option",
                    "params": { "sessionId": sid, "configId": config, "value": value } })
        };
        // Model.
        if let Some(model) = self.spec.model.clone() {
            if let Some(o) = find(&|o| o["category"] == "model" || o["id"] == "model") {
                self.setup
                    .push_back(set(o["id"].as_str().unwrap_or("model"), &model));
            } else if r["models"].is_object() {
                self.setup.push_back(json!({ "method": "session/set_model",
                    "params": { "sessionId": sid, "modelId": model } }));
            }
        }
        // Effort.
        if let Some(effort) = self.spec.effort.clone()
            && let Some(o) = find(&|o| {
                o["category"] == "thought_level" || o["id"] == "effort" || o["id"] == "reasoning"
            })
            && values(&o).contains(&effort)
        {
            self.setup
                .push_back(set(o["id"].as_str().unwrap_or("effort"), &effort));
        }
        // Mode: read only roles plan, the others build.
        let pick_mode = |ids: Vec<String>, current: Option<&str>| -> Option<String> {
            let is_ro = |m: &str| {
                let m = m.to_lowercase();
                m.contains("plan") || m.contains("read") || m.contains("ask")
            };
            let want = if self.spec.read_only {
                ids.iter().find(|m| is_ro(m)).cloned()
            } else if current.is_some_and(is_ro) {
                ids.iter()
                    .find(|m| ["build", "code", "default", "edit", "write"].contains(&m.as_str()))
                    .cloned()
                    .or_else(|| ids.iter().find(|m| !is_ro(m)).cloned())
            } else {
                None
            };
            want.filter(|w| Some(w.as_str()) != current)
        };
        if let Some(o) = find(&|o| o["category"] == "mode" || o["id"] == "mode") {
            if let Some(m) = pick_mode(values(&o), o["currentValue"].as_str()) {
                self.setup
                    .push_back(set(o["id"].as_str().unwrap_or("mode"), &m));
            }
        } else if let Some(modes) = r["modes"].as_object() {
            let ids = modes
                .get("availableModes")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m["id"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let cur = modes.get("currentModeId").and_then(Value::as_str);
            if let Some(m) = pick_mode(ids, cur) {
                self.setup.push_back(json!({ "method": "session/set_mode",
                    "params": { "sessionId": sid, "modeId": m } }));
            }
        }
    }

    /// Send the next setup request, or the prompt once there is none left.
    fn next_step(&mut self) {
        if let Some(req) = self.setup.pop_front() {
            let id = self.next_setup;
            self.next_setup += 1;
            self.request(
                id,
                req["method"].as_str().unwrap_or(""),
                req["params"].clone(),
            );
            return;
        }
        if self.next_setup == u64::MAX {
            return;
        }
        self.next_setup = u64::MAX;
        let sid = self.session_id.clone().unwrap_or_default();
        self.request(
            ID_PROMPT,
            "session/prompt",
            json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": self.spec.prompt }] }),
        );
    }

    fn on_prompt_done(&mut self, r: &Value) {
        self.flush_text();
        let u = &r["usage"];
        if u.is_object() || self.cost.is_some() {
            self.emit(AgentEvent::Usage {
                input_tokens: u["inputTokens"].as_u64().unwrap_or(0)
                    + u["cachedReadTokens"].as_u64().unwrap_or(0)
                    + u["cachedWriteTokens"].as_u64().unwrap_or(0),
                output_tokens: u["outputTokens"].as_u64().unwrap_or(0),
                cost_usd: self.cost,
                model: self
                    .spec
                    .model
                    .clone()
                    .unwrap_or_else(|| self.spec.harness.clone()),
            });
        }
        let reason = r["stopReason"].as_str().unwrap_or("end_turn");
        let end = match reason {
            "end_turn" | "max_turn_requests" => AgentEvent::Done {
                summary: self.last_text.clone(),
            },
            "cancelled" => AgentEvent::Failed {
                error: "cancelled".to_string(),
            },
            "refusal" => AgentEvent::Failed {
                error: "the agent refused".to_string(),
            },
            "max_tokens" => AgentEvent::Failed {
                error: "the agent ran out of tokens".to_string(),
            },
            other => AgentEvent::Done {
                summary: if self.last_text.is_empty() {
                    other.to_string()
                } else {
                    self.last_text.clone()
                },
            },
        };
        self.emit(end);
        self.finished = true;
    }

    fn on_request(&mut self, method: &str, id: Value, p: &Value) {
        if method == "session/request_permission" {
            self.flush_text();
            let tc = &p["toolCall"];
            let what = tc["title"]
                .as_str()
                .filter(|t| !t.is_empty())
                .map(str::to_string)
                .or_else(|| tc["rawInput"]["command"].as_str().map(str::to_string))
                .unwrap_or_else(|| "an action".to_string());
            let options: Vec<(String, String, String)> = p["options"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|o| {
                            (
                                o["optionId"].as_str().unwrap_or("").to_string(),
                                o["name"].as_str().unwrap_or("").to_string(),
                                o["kind"].as_str().unwrap_or("").to_string(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            // Yes first, no second: the island's two buttons.
            let mut names: Vec<(u8, String)> = options
                .iter()
                .map(|(_, n, k)| {
                    let rank = match k.as_str() {
                        "allow_once" => 0,
                        "reject_once" => 1,
                        "allow_always" => 2,
                        _ => 3,
                    };
                    (rank, n.clone())
                })
                .collect();
            names.sort();
            if let Ok(mut g) = self.shared.pending.lock() {
                *g = Some(Pending { id, options });
            }
            self.emit(AgentEvent::Question {
                text: format!("Allow {}?", shorten(&what, 160)),
                options: names.into_iter().map(|(_, n)| n).collect(),
                tools: Vec::new(),
            });
            return;
        }
        // No file system or terminal capability was offered.
        self.shared.send(&json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": format!("{method} is not supported by Vela") }
        }));
    }

    fn rel(&self, p: &str) -> String {
        rel_path(&self.spec.cwd, p)
    }

    fn on_update(&mut self, u: &Value) {
        let kind = u["sessionUpdate"].as_str().unwrap_or("");
        match kind {
            "agent_message_chunk" => {
                if let Some(t) = u["content"]["text"].as_str() {
                    self.text.push_str(t);
                }
            }
            "agent_thought_chunk"
            | "user_message_chunk"
            | "available_commands_update"
            | "current_mode_update"
            | "config_option_update" => {}
            "plan" => {
                self.flush_text();
                let steps: Vec<String> = u["entries"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|e| e["content"].as_str())
                            .map(|s| shorten(s, 200))
                            .collect()
                    })
                    .unwrap_or_default();
                if !steps.is_empty() {
                    self.emit(AgentEvent::Plan { steps });
                }
            }
            "usage_update" => {
                if let Some(c) = u["cost"]["amount"].as_f64() {
                    self.cost = Some(c);
                }
            }
            "tool_call" | "tool_call_update" => {
                self.flush_text();
                self.on_tool(u);
            }
            _ => {}
        }
    }

    fn on_tool(&mut self, u: &Value) {
        let id = u["toolCallId"].as_str().unwrap_or("").to_string();
        let entry = self.tools.entry(id.clone()).or_default();
        if let Some(k) = u["kind"].as_str() {
            entry.0 = k.to_string();
        }
        if let Some(t) = u["title"].as_str().filter(|t| !t.is_empty())
            && entry.1.is_empty()
        {
            entry.1 = t.to_string();
        }
        let (kind, name) = entry.clone();
        let input = &u["rawInput"];
        let file = input["filePath"]
            .as_str()
            .or_else(|| input["path"].as_str())
            .or_else(|| input["file_path"].as_str())
            .map(|p| self.rel(p));
        let status = u["status"].as_str().unwrap_or("");
        let has_input = [
            "command",
            "filePath",
            "path",
            "file_path",
            "pattern",
            "url",
            "query",
        ]
        .iter()
        .any(|k| !input[*k].is_null());
        if !self.announced.contains(&id)
            && (has_input || status == "completed" || status == "failed")
        {
            self.announced.insert(id.clone());
            let summary = input["command"]
                .as_str()
                .map(str::to_string)
                .or_else(|| file.clone())
                .or_else(|| u["title"].as_str().map(str::to_string))
                .unwrap_or_default();
            self.emit(AgentEvent::ToolCall {
                name: if name.is_empty() {
                    kind.clone()
                } else {
                    name.clone()
                },
                summary: shorten(&summary, 120),
            });
        }
        if status == "failed" {
            return;
        }
        let mut paths: Vec<String> = Vec::new();
        if let Some(c) = u["content"].as_array() {
            for item in c {
                if item["type"] == "diff"
                    && let Some(p) = item["path"].as_str()
                {
                    paths.push(self.rel(p));
                }
            }
        }
        if (kind == "edit" || kind == "delete" || kind == "move") && status == "completed" {
            if let Some(f) = file {
                paths.push(f);
            }
            if let Some(locs) = u["locations"].as_array() {
                for l in locs {
                    if let Some(p) = l["path"].as_str() {
                        paths.push(self.rel(p));
                    }
                }
            }
        }
        for p in paths {
            if !p.is_empty() && self.changed.insert(format!("{id}\0{p}")) {
                self.emit(AgentEvent::FileChanged { path: p });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> Vec<(String, String, String)> {
        vec![
            ("once".into(), "Allow once".into(), "allow_once".into()),
            (
                "always".into(),
                "Always allow".into(),
                "allow_always".into(),
            ),
            ("reject".into(), "Reject".into(), "reject_once".into()),
        ]
    }

    #[test]
    fn answers_pick_an_option() {
        assert_eq!(pick_option(&opts(), "yes").as_deref(), Some("once"));
        assert_eq!(
            pick_option(&opts(), "Always allow").as_deref(),
            Some("always")
        );
        assert_eq!(pick_option(&opts(), "no").as_deref(), Some("reject"));
        assert_eq!(
            pick_option(&opts(), "use the other API").as_deref(),
            Some("reject")
        );
    }
}
