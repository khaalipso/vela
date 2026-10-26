//! Runs agents: starts a harness on a background thread, persists and forwards its events.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use vela_core::config::{self, AgentsConfig};
use vela_core::model::{Agent, AgentRole, AgentStatus, AgentUsage, Space, Tier};
use vela_core::{Error, Result, Vela};

use crate::claude::ClaudeDriver;
use crate::codex::CodexDriver;
use crate::detect::{HarnessInfo, detect};
use crate::driver::{AgentDriver, Canceller, RunHandle, RunSpec};
use crate::event::AgentEvent;
use crate::opencode::OpencodeDriver;
use crate::registry::{self, Entry, LogEntry};
use crate::tiers::{Overrides, resolve};
use crate::worktree;

/// What the UI receives as `vela://agent`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub space_id: String,
    pub agent_id: String,
    pub event: AgentEvent,
}

pub type Emit = Arc<dyn Fn(Notice) + Send + Sync>;

/// A request to start an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskRequest {
    pub role: AgentRole,
    pub prompt: String,
    pub harness: Option<String>,
    pub tier: Option<Tier>,
}

/// The question the space waits on, for the Up next island. Mirrors `AgentQuestion` of the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionView {
    pub agent_id: String,
    pub role: AgentRole,
    pub tool: String,
    pub text: String,
    pub yes: String,
    pub no: String,
    pub options: Vec<String>,
}

/// Where harness binaries come from and where the global config lives.
#[derive(Clone)]
pub struct Drivers {
    path: Option<OsString>,
}

impl Drivers {
    /// The process `PATH`, plus the usual install directories.
    pub fn system() -> Self {
        Drivers { path: None }
    }

    /// Only this `PATH` (tests put fake harnesses there).
    pub fn with_path(path: impl Into<OsString>) -> Self {
        Drivers {
            path: Some(path.into()),
        }
    }

    pub fn get(&self, harness: &str) -> Option<Box<dyn AgentDriver>> {
        let p = self.path.as_deref();
        Some(match harness {
            "claude" => Box::new(ClaudeDriver::with_path(p)),
            "codex" => Box::new(CodexDriver::with_path(p)),
            "opencode" => Box::new(OpencodeDriver::with_path(p)),
            _ => return None,
        })
    }

    pub fn detect(&self) -> Vec<HarnessInfo> {
        detect(self.path.as_deref())
    }
}

struct Live {
    /// None while the run is being prepared (worktrees, process start).
    canceller: Option<Canceller>,
}

pub struct AgentManager {
    drivers: Drivers,
    /// The directory of the global config layer; None skips it.
    config_dir: Option<PathBuf>,
    live: Mutex<HashMap<String, Live>>,
}

fn key(space: &str, agent: &str) -> String {
    format!("{space}\0{agent}")
}

/// Roles that only read: they run in the user's worktree in the harness's read only mode.
pub fn is_read_only(role: AgentRole) -> bool {
    matches!(role, AgentRole::Reviewer | AgentRole::Planner)
}

fn role_brief(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Developer => {
            "You are the developer agent of a Vela space. Make the requested change in this \
             working directory. Do not commit and do not touch files outside it. When done, say in \
             one or two sentences what you changed and why."
        }
        AgentRole::Tester => {
            "You are the tester agent of a Vela space. Write or run tests for the request in this \
             working directory. Do not commit. When done, say in one or two sentences what you \
             found."
        }
        AgentRole::Debugger => {
            "You are the debugger agent of a Vela space. Find the cause of the problem and fix it \
             in this working directory. Do not commit. When done, say in one or two sentences what \
             was wrong."
        }
        AgentRole::Reviewer => {
            "You are the reviewer agent of a Vela space. You only read: do not change any file. \
             Review the uncommitted changes (git diff, git status) against the request and report \
             concrete problems, most important first."
        }
        AgentRole::Planner => {
            "You are the planner agent of a Vela space. You only read: do not change any file. \
             Write a short plan as a list of steps for the request."
        }
    }
}

fn compose_prompt(role: AgentRole, prompt: &str) -> String {
    format!("{}\n\nRequest: {}", role_brief(role), prompt.trim())
}

/// Does the answer mean yes to a permission question?
pub fn is_yes(text: &str) -> bool {
    let first = text
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase();
    matches!(
        first.as_str(),
        "allow" | "yes" | "y" | "approve" | "approved" | "ok" | "okay" | "sure" | "oui"
    )
}

impl AgentManager {
    pub fn new(drivers: Drivers) -> Arc<Self> {
        Arc::new(AgentManager {
            drivers,
            config_dir: vela_core::paths::config_dir_from_env(),
            live: Mutex::new(HashMap::new()),
        })
    }

    /// Like [`AgentManager::new`] with an explicit global config directory (None: no global layer).
    pub fn with_config_dir(drivers: Drivers, config_dir: Option<PathBuf>) -> Arc<Self> {
        Arc::new(AgentManager {
            drivers,
            config_dir,
            live: Mutex::new(HashMap::new()),
        })
    }

    pub fn harnesses(&self) -> Vec<HarnessInfo> {
        self.drivers.detect()
    }

    fn live(&self) -> std::sync::MutexGuard<'_, HashMap<String, Live>> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_live(&self, space: &str, agent: &str) -> bool {
        self.live().contains_key(&key(space, agent))
    }

    /// Wait until no agent runs (for tests). False on timeout.
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let end = Instant::now() + timeout;
        while !self.live().is_empty() {
            if Instant::now() >= end {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        true
    }

    /// The `[agents]` config of the space (its first repo's layers).
    pub fn agents_config(&self, vela: &Vela, space: &Space) -> AgentsConfig {
        match space.repos.first() {
            Some(r) => {
                config::load_repo_config_in(
                    self.config_dir.as_deref(),
                    vela,
                    std::path::Path::new(&r.source),
                    &r.name,
                )
                .config
                .agents
            }
            None => AgentsConfig::default(),
        }
    }

    /// Harness, tier and model each role gets when the request says nothing, for the composer.
    pub fn role_defaults(
        &self,
        vela: &Vela,
        space: &Space,
    ) -> Vec<(AgentRole, crate::tiers::Resolved)> {
        let cfg = self.agents_config(vela, space);
        let installed: Vec<String> = self
            .harnesses()
            .into_iter()
            .filter(|h| h.available)
            .map(|h| h.name)
            .collect();
        [
            AgentRole::Developer,
            AgentRole::Reviewer,
            AgentRole::Tester,
            AgentRole::Planner,
            AgentRole::Debugger,
        ]
        .into_iter()
        .map(|r| (r, resolve(&cfg, r, &Overrides::default(), Some(&installed))))
        .collect()
    }

    /// The agents of a space, newest first. Agents that were running when Vela stopped are
    /// marked interrupted.
    pub fn list(&self, vela: &Vela, space_id: &str) -> Result<Vec<Agent>> {
        Ok(self
            .entries(vela, space_id)?
            .into_iter()
            .map(|e| e.agent)
            .collect())
    }

    pub fn entries(&self, vela: &Vela, space_id: &str) -> Result<Vec<Entry>> {
        registry::recover(vela, space_id, &|a| self.is_live(space_id, a))?;
        let mut all = registry::load(vela, space_id)?;
        all.reverse();
        Ok(all)
    }

    /// The first question an agent of the space waits on.
    pub fn question(&self, vela: &Vela, space_id: &str) -> Result<Option<QuestionView>> {
        Ok(self.entries(vela, space_id)?.into_iter().find_map(|e| {
            let a = e.agent;
            if a.status != AgentStatus::Waiting {
                return None;
            }
            let text = a.question?;
            Some(QuestionView {
                agent_id: a.id,
                role: a.role,
                tool: a.tool,
                yes: a.options.first().cloned().unwrap_or_else(|| "Yes".into()),
                no: a.options.get(1).cloned().unwrap_or_else(|| "No".into()),
                options: a.options,
                text,
            })
        }))
    }

    /// Tokens and cost of the whole space.
    pub fn usage(&self, vela: &Vela, space_id: &str) -> Result<AgentUsage> {
        Ok(registry::totals(&registry::load(vela, space_id)?))
    }

    pub fn log(&self, vela: &Vela, space_id: &str, agent: &str) -> Result<Vec<LogEntry>> {
        registry::read_log(vela, space_id, agent)
    }

    /// Kill the process of a running agent. False when it is not running.
    pub fn cancel(&self, space_id: &str, agent: &str) -> bool {
        match self.live().get(&key(space_id, agent)) {
            Some(l) => {
                if let Some(c) = &l.canceller {
                    c.cancel();
                }
                true
            }
            None => false,
        }
    }

    /// Start an agent for the request: resolve harness and model, make its worktrees, run.
    pub fn ask(
        self: &Arc<Self>,
        vela: &Vela,
        space: &Space,
        req: AskRequest,
        emit: &Emit,
    ) -> Result<Agent> {
        if req.prompt.trim().is_empty() {
            return Err(Error::Invalid("tell the agent what to do".to_string()));
        }
        let cfg = self.agents_config(vela, space);
        let installed: Vec<String> = self
            .harnesses()
            .into_iter()
            .filter(|h| h.available)
            .map(|h| h.name)
            .collect();
        let resolved = resolve(
            &cfg,
            req.role,
            &Overrides {
                harness: req.harness.clone(),
                tier: req.tier,
            },
            Some(&installed),
        );
        if !installed.contains(&resolved.harness) {
            return Err(Error::Invalid(format!(
                "{} is not installed",
                crate::tiers::harness_label(&resolved.harness)
            )));
        }
        let driver = self
            .drivers
            .get(&resolved.harness)
            .ok_or_else(|| Error::Invalid(format!("unknown harness: {}", resolved.harness)))?;
        let read_only = is_read_only(req.role);

        // Reserve the id before making worktrees so two requests never share one. The agent is
        // live from the start, so a listing never mistakes it for an interrupted one.
        let id = registry::insert_next(vela, &space.id, req.role, |id| {
            self.live()
                .insert(key(&space.id, &id), Live { canceller: None });
            Entry {
                agent: Agent {
                    id,
                    space: space.id.clone(),
                    role: req.role,
                    tool: resolved.harness.clone(),
                    worktrees: Vec::new(),
                    status: AgentStatus::Working,
                    summary: String::new(),
                    model: resolved.model.clone(),
                    tier: Some(resolved.tier),
                    session: None,
                    prompt: req.prompt.trim().to_string(),
                    last_message: String::new(),
                    plan: Vec::new(),
                    question: None,
                    options: Vec::new(),
                    usage: AgentUsage::default(),
                    started: registry::now(),
                    finished: None,
                },
                bases: Vec::new(),
                read_only,
                pending_tools: Vec::new(),
            }
        })?
        .agent
        .id;
        let fail = |e: Error| {
            let _ = registry::remove(vela, &space.id, &id);
            self.live().remove(&key(&space.id, &id));
            e
        };
        let trees = if read_only {
            Vec::new()
        } else {
            worktree::create(vela, space, &id).map_err(fail)?
        };
        let wts: Vec<(String, String)> = trees
            .iter()
            .map(|t| (t.repo.clone(), t.path.to_string_lossy().into_owned()))
            .collect();
        let bases: Vec<(String, String)> = trees
            .iter()
            .map(|t| (t.repo.clone(), t.base.clone()))
            .collect();
        let cwd = if read_only {
            worktree::read_only_dir(vela, space)
        } else {
            worktree::run_dir(vela, space, &id, &wts)
        };
        let spec = RunSpec {
            harness: resolved.harness,
            model: resolved.model,
            tier: Some(resolved.tier),
            role: req.role,
            prompt: compose_prompt(req.role, &req.prompt),
            cwd,
            session: None,
            read_only,
            extra_args: Vec::new(),
        };
        let handle = match driver.start(spec) {
            Ok(h) => h,
            Err(e) => {
                let _ = worktree::remove(vela, space, &id, &wts);
                return Err(fail(e));
            }
        };
        let entry = registry::update(vela, &space.id, &id, |e| {
            e.agent.worktrees = wts;
            e.bases = bases;
        })?;
        let agent = entry.agent.clone();
        self.watch(vela, &space.id, &id, handle, req.prompt.trim(), emit);
        Ok(agent)
    }

    /// Answer an agent: a resumed run of its session with the answer as the prompt. A yes to
    /// a permission question also grants the refused tools (Claude Code).
    pub fn answer(
        self: &Arc<Self>,
        vela: &Vela,
        space: &Space,
        agent_id: &str,
        text: &str,
        emit: &Emit,
    ) -> Result<Agent> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::Invalid("the answer is empty".to_string()));
        }
        let entry = registry::find(vela, &space.id, agent_id)?;
        if entry.agent.status == AgentStatus::Working || self.is_live(&space.id, agent_id) {
            return Err(Error::Invalid(format!("{agent_id} is still working")));
        }
        let session = entry
            .agent
            .session
            .clone()
            .ok_or_else(|| Error::Invalid(format!("{agent_id} has no session to resume")))?;
        let driver = self
            .drivers
            .get(&entry.agent.tool)
            .ok_or_else(|| Error::Invalid(format!("unknown harness: {}", entry.agent.tool)))?;
        let tools = entry.pending_tools.clone();
        let mut extra = Vec::new();
        let prompt = if !tools.is_empty() {
            if is_yes(text) {
                if entry.agent.tool == "claude" {
                    extra.extend(["--allowed-tools".to_string(), tools.join(",")]);
                }
                format!(
                    "Permission granted: you may use {}. Continue what you were doing.",
                    tools.join(", ")
                )
            } else {
                format!(
                    "Permission denied for {}. Find another way, or stop and explain. {text}",
                    tools.join(", ")
                )
            }
        } else {
            text.to_string()
        };
        let cwd = if entry.read_only {
            worktree::read_only_dir(vela, space)
        } else {
            worktree::run_dir(vela, space, agent_id, &entry.agent.worktrees)
        };
        let spec = RunSpec {
            harness: entry.agent.tool.clone(),
            model: entry.agent.model.clone(),
            tier: entry.agent.tier,
            role: entry.agent.role,
            prompt,
            cwd,
            session: Some(session.clone()),
            read_only: entry.read_only,
            extra_args: extra,
        };
        let handle = driver.reply(&spec, &session, &spec.prompt)?;
        let entry = registry::update(vela, &space.id, agent_id, registry::begin_run)?;
        self.watch(vela, &space.id, agent_id, handle, text, emit);
        Ok(entry.agent)
    }

    /// Consume the events of a run on a thread: log, fold into the registry, forward.
    fn watch(
        self: &Arc<Self>,
        vela: &Vela,
        space_id: &str,
        agent_id: &str,
        handle: RunHandle,
        user_text: &str,
        emit: &Emit,
    ) {
        self.live().insert(
            key(space_id, agent_id),
            Live {
                canceller: Some(handle.canceller()),
            },
        );
        let me = self.clone();
        let (vela, space_id, agent_id, emit) = (
            vela.clone(),
            space_id.to_string(),
            agent_id.to_string(),
            emit.clone(),
        );
        let prompt = AgentEvent::Prompt {
            text: user_text.to_string(),
        };
        std::thread::spawn(move || {
            let notice = |event: AgentEvent| Notice {
                space_id: space_id.clone(),
                agent_id: agent_id.clone(),
                event,
            };
            let _ = registry::append_log(&vela, &space_id, &agent_id, &prompt);
            emit(notice(prompt));
            while let Some(ev) = handle.recv() {
                let _ = registry::append_log(&vela, &space_id, &agent_id, &ev);
                let ts = registry::now();
                let _ = registry::update(&vela, &space_id, &agent_id, |e| {
                    registry::apply_event(e, &ev, &ts);
                });
                if ev.is_terminal() {
                    // The agent is no longer live before anyone hears it is done.
                    me.live().remove(&key(&space_id, &agent_id));
                }
                emit(notice(ev));
            }
            // A stream that ended without a terminal event (should not happen).
            me.live().remove(&key(&space_id, &agent_id));
        });
    }

    /// Remove an agent that is not running: its worktrees, branches and registry entry.
    /// The log stays.
    pub fn discard(&self, vela: &Vela, space: &Space, agent_id: &str) -> Result<()> {
        if self.is_live(&space.id, agent_id) {
            return Err(Error::Invalid(format!("{agent_id} is still running")));
        }
        let entry = registry::find(vela, &space.id, agent_id)?;
        worktree::remove(vela, space, agent_id, &entry.agent.worktrees)?;
        registry::remove(vela, &space.id, agent_id)
    }
}
