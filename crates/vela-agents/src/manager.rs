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
use crate::driver::{AgentDriver, Canceller, Replier, RunHandle, RunSpec};
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

    /// The driver of a harness for a transport (`acp`, `cli`; None: ACP when its server is
    /// installed, else the CLI).
    pub fn get_for(&self, harness: &str, transport: Option<&str>) -> Option<Box<dyn AgentDriver>> {
        if transport != Some("cli")
            && let Some(d) = crate::acp::AcpDriver::for_harness(harness, self.path.as_deref())
        {
            return Some(Box::new(d));
        }
        self.get(harness)
    }

    /// The CLI driver of a harness.
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

    /// Installed harnesses, found on the `PATH` without running them.
    pub fn installed(&self) -> Vec<String> {
        crate::detect::installed(self.path.as_deref())
    }
}

struct Live {
    /// None while the run is being prepared (worktrees, process start).
    canceller: Option<Canceller>,
    /// Answers a question in the live run (ACP).
    replier: Option<Replier>,
}

pub struct AgentManager {
    drivers: Drivers,
    /// The directory of the global config layer; None skips it.
    config_dir: Option<PathBuf>,
    live: Mutex<HashMap<String, Live>>,
    /// Harnesses with their versions, detected at most once per [`DETECT_TTL`].
    detected: Mutex<Option<(Instant, Vec<HarnessInfo>)>>,
}

/// How long a harness detection (which runs `--version` of each) is reused.
const DETECT_TTL: Duration = Duration::from_secs(300);

fn key(space: &str, agent: &str) -> String {
    format!("{space}\0{agent}")
}

/// Roles that only read: they run in the user's worktree in the harness's read only mode.
pub fn is_read_only(role: AgentRole) -> bool {
    matches!(
        role,
        AgentRole::Reviewer | AgentRole::Planner | AgentRole::Product | AgentRole::Security
    )
}

/// Ground rules every role gets, before its own brief (`prompts/_common.md`).
pub const COMMON_BRIEF: &str = include_str!("../prompts/_common.md");

/// The built in brief of a role (`prompts/<role>.md`). `[agents.prompts]` replaces it; the
/// common rules stay.
pub fn role_brief(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Developer => include_str!("../prompts/developer.md"),
        AgentRole::Tester => include_str!("../prompts/tester.md"),
        AgentRole::Debugger => include_str!("../prompts/debugger.md"),
        AgentRole::Reviewer => include_str!("../prompts/reviewer.md"),
        AgentRole::Planner => include_str!("../prompts/planner.md"),
        AgentRole::Product => include_str!("../prompts/product.md"),
        AgentRole::Security => include_str!("../prompts/security.md"),
    }
    .trim()
}

/// Where the agent is and what the space is about, for the prompt.
pub fn space_context(space: &Space, read_only: bool, worktrees: &[(String, String)]) -> String {
    let repos: Vec<String> = space
        .repos
        .iter()
        .map(|r| {
            let wt = worktrees
                .iter()
                .find(|(n, _)| n == &r.name)
                .map(|(_, p)| p.as_str())
                .unwrap_or(&r.worktree);
            format!("- `{}`: {}", r.name, wt)
        })
        .collect();
    format!(
        "Space: \"{}\", branch `{}`.\n{}\nRepos:\n{}",
        space.name,
        space.branch,
        if read_only {
            "You run in the person's own worktree, read only."
        } else {
            "You run in your own worktree of each repo, on a branch made from the last commit of the space; the person's uncommitted changes are not in it."
        },
        repos.join("\n")
    )
}

/// The prompt of a request: the common rules, the brief of the role (the custom one when
/// set), the notes format for the roles that report notes, the context, then the request.
pub fn compose_prompt(
    role: AgentRole,
    prompt: &str,
    custom: Option<&str>,
    context: &str,
) -> String {
    let brief = custom
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| role_brief(role));
    let mut out = format!("{}\n\n{}", COMMON_BRIEF.trim(), brief);
    if crate::notes::reports_notes(role) {
        out.push_str("\n\n");
        out.push_str(crate::notes::FORMAT);
    }
    if !context.trim().is_empty() {
        out.push_str("\n\n## Context\n");
        out.push_str(context.trim());
    }
    out.push_str("\n\n## Request\n");
    out.push_str(prompt.trim());
    out
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
            detected: Mutex::new(None),
        })
    }

    /// Like [`AgentManager::new`] with an explicit global config directory (None: no global layer).
    pub fn with_config_dir(drivers: Drivers, config_dir: Option<PathBuf>) -> Arc<Self> {
        Arc::new(AgentManager {
            drivers,
            config_dir,
            live: Mutex::new(HashMap::new()),
            detected: Mutex::new(None),
        })
    }

    /// The directory of the global config layer (None: there is none).
    pub fn config_dir(&self) -> Option<&std::path::Path> {
        self.config_dir.as_deref()
    }

    /// Harnesses with their versions. Cached: `--version` is slow for some of them.
    pub fn harnesses(&self) -> Vec<HarnessInfo> {
        let mut g = self.detected.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, list)) = g.as_ref()
            && at.elapsed() < DETECT_TTL
        {
            return list.clone();
        }
        let list = self.drivers.detect();
        *g = Some((Instant::now(), list.clone()));
        list
    }

    /// Forget the cached detection (after installing a harness).
    pub fn refresh_harnesses(&self) -> Vec<HarnessInfo> {
        *self.detected.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.harnesses()
    }

    /// Names of the installed harnesses, cheap: no process is started.
    pub fn installed(&self) -> Vec<String> {
        self.drivers.installed()
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

    /// Wait until no agent of the space runs. False on timeout.
    pub fn wait_idle_space(&self, space_id: &str, timeout: Duration) -> bool {
        let prefix = format!("{space_id}\0");
        let end = Instant::now() + timeout;
        while self.live().keys().any(|k| k.starts_with(&prefix)) {
            if Instant::now() >= end {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
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
        let installed = self.installed();
        AgentRole::ALL
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

    /// Kill every running agent of a space (before the space is removed). Returns how many.
    pub fn cancel_space(&self, space_id: &str) -> usize {
        let prefix = format!("{space_id}\0");
        let live = self.live();
        let mut n = 0;
        for (k, l) in live.iter() {
            if k.starts_with(&prefix) {
                if let Some(c) = &l.canceller {
                    c.cancel();
                }
                n += 1;
            }
        }
        n
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
        let installed = self.installed();
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
            .get_for(
                &resolved.harness,
                cfg.transport.get(&resolved.harness).map(String::as_str),
            )
            .ok_or_else(|| Error::Invalid(format!("unknown harness: {}", resolved.harness)))?;
        let read_only = is_read_only(req.role);

        // Reserve the id before making worktrees so two requests never share one. The agent is
        // live from the start, so a listing never mistakes it for an interrupted one.
        let id = registry::insert_next(vela, &space.id, req.role, |id| {
            self.live().insert(
                key(&space.id, &id),
                Live {
                    canceller: None,
                    replier: None,
                },
            );
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
            effort: resolved.effort,
            tier: Some(resolved.tier),
            role: req.role,
            prompt: compose_prompt(
                req.role,
                &req.prompt,
                cfg.prompts.get(req.role.as_str()).map(String::as_str),
                &space_context(space, read_only, &wts),
            ),
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
        // A live run that can take the answer (ACP): it goes straight to the process.
        let replier = self
            .live()
            .get(&key(&space.id, agent_id))
            .and_then(|l| l.replier.clone());
        if entry.agent.status == AgentStatus::Waiting
            && let Some(reply) = replier
            && reply(text)
        {
            let entry = registry::update(vela, &space.id, agent_id, registry::begin_run)?;
            let prompt = AgentEvent::Prompt {
                text: text.to_string(),
            };
            let _ = registry::append_log(vela, &space.id, agent_id, &prompt);
            emit(Notice {
                space_id: space.id.clone(),
                agent_id: agent_id.to_string(),
                event: prompt,
            });
            return Ok(entry.agent);
        }
        if entry.agent.status == AgentStatus::Working || self.is_live(&space.id, agent_id) {
            return Err(Error::Invalid(format!("{agent_id} is still working")));
        }
        let session = entry
            .agent
            .session
            .clone()
            .ok_or_else(|| Error::Invalid(format!("{agent_id} has no session to resume")))?;
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
        self.resume(vela, space, &entry, &session, prompt, extra, text, emit)
    }

    /// Give a finished agent more work: a resumed run of its session in its own worktree.
    pub fn follow_up(
        self: &Arc<Self>,
        vela: &Vela,
        space: &Space,
        agent_id: &str,
        prompt: &str,
        emit: &Emit,
    ) -> Result<Agent> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err(Error::Invalid("tell the agent what to do".to_string()));
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
        self.resume(
            vela,
            space,
            &entry,
            &session,
            prompt.to_string(),
            Vec::new(),
            prompt,
            emit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn resume(
        self: &Arc<Self>,
        vela: &Vela,
        space: &Space,
        entry: &Entry,
        session: &str,
        prompt: String,
        extra: Vec<String>,
        shown: &str,
        emit: &Emit,
    ) -> Result<Agent> {
        let agent_id = entry.agent.id.as_str();
        let cfg = self.agents_config(vela, space);
        let driver = self
            .drivers
            .get_for(
                &entry.agent.tool,
                cfg.transport.get(&entry.agent.tool).map(String::as_str),
            )
            .ok_or_else(|| Error::Invalid(format!("unknown harness: {}", entry.agent.tool)))?;
        let cwd = if entry.read_only {
            worktree::read_only_dir(vela, space)
        } else {
            worktree::run_dir(vela, space, agent_id, &entry.agent.worktrees)
        };
        let effort = entry
            .agent
            .tier
            .and_then(|t| cfg.effort.get(&entry.agent.tool).and_then(|e| e.get(t)))
            .map(str::to_string);
        let spec = RunSpec {
            harness: entry.agent.tool.clone(),
            model: entry.agent.model.clone(),
            effort,
            tier: entry.agent.tier,
            role: entry.agent.role,
            prompt,
            cwd,
            session: Some(session.to_string()),
            read_only: entry.read_only,
            extra_args: extra,
        };
        let handle = driver.reply(&spec, session, &spec.prompt)?;
        let entry = registry::update(vela, &space.id, agent_id, registry::begin_run)?;
        self.watch(vela, &space.id, agent_id, handle, shown, emit);
        Ok(entry.agent)
    }

    /// A review comment of the user: a new thread answered by a reviewer, or by a developer
    /// (the agent that wrote the hunk when it can be resumed, else a new one).
    #[allow(clippy::too_many_arguments)]
    pub fn comment(
        self: &Arc<Self>,
        vela: &Vela,
        space: &Space,
        at: (&str, &str, u32, &str),
        code: &str,
        text: &str,
        role: AgentRole,
        author: Option<&str>,
        emit: &Emit,
    ) -> Result<crate::comments::Thread> {
        let (repo, path, line, hunk_id) = at;
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::Invalid("write the comment first".to_string()));
        }
        let role = if role == AgentRole::Developer {
            AgentRole::Developer
        } else {
            AgentRole::Reviewer
        };
        let prompt = crate::comments::first_prompt(role, repo, path, line, code, text);
        let resumable = author
            .filter(|_| role == AgentRole::Developer)
            .and_then(|a| registry::find(vela, &space.id, a).ok())
            .filter(|e| {
                !e.read_only
                    && e.agent.session.is_some()
                    && e.agent.status != AgentStatus::Working
                    && !self.is_live(&space.id, &e.agent.id)
            });
        let (agent, log_from) = match resumable {
            Some(e) => {
                let from = registry::read_log(vela, &space.id, &e.agent.id)
                    .map(|l| l.len())
                    .unwrap_or(0);
                (
                    self.follow_up(vela, space, &e.agent.id, &prompt, emit)?,
                    from,
                )
            }
            None => (
                self.ask(
                    vela,
                    space,
                    AskRequest {
                        role,
                        prompt,
                        harness: None,
                        tier: None,
                    },
                    emit,
                )?,
                0,
            ),
        };
        let mut list = crate::comments::load(vela, &space.id);
        let thread = crate::comments::Thread {
            id: crate::comments::next_id(&list),
            repo: repo.to_string(),
            path: path.to_string(),
            line,
            hunk_id: hunk_id.to_string(),
            role,
            agent: agent.id,
            turns: vec![crate::comments::Turn {
                text: text.to_string(),
                log_from,
            }],
            resolved: false,
            created: registry::now(),
        };
        list.push(thread.clone());
        crate::comments::save(vela, &space.id, &list)?;
        Ok(thread)
    }

    /// The user answers in a thread: a follow up of the agent of the thread.
    pub fn reply_comment(
        self: &Arc<Self>,
        vela: &Vela,
        space: &Space,
        thread_id: &str,
        text: &str,
        emit: &Emit,
    ) -> Result<()> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::Invalid("write the answer first".to_string()));
        }
        let mut list = crate::comments::load(vela, &space.id);
        let t = list
            .iter_mut()
            .find(|t| t.id == thread_id)
            .ok_or_else(|| Error::Invalid("this comment is gone".to_string()))?;
        let from = registry::read_log(vela, &space.id, &t.agent)
            .map(|l| l.len())
            .unwrap_or(0);
        let resumable = registry::find(vela, &space.id, &t.agent)
            .ok()
            .is_some_and(|e| e.agent.session.is_some());
        if resumable {
            self.follow_up(vela, space, &t.agent, text, emit)?;
            t.turns.push(crate::comments::Turn {
                text: text.to_string(),
                log_from: from,
            });
        } else {
            // The agent never started a session: a new one takes the whole thread.
            let mut prompt = crate::comments::first_prompt(
                t.role,
                &t.repo,
                &t.path,
                t.line,
                "",
                &t.turns[0].text,
            );
            for turn in &t.turns[1..] {
                prompt.push_str(&format!("\n\nThe user added: {}", turn.text));
            }
            prompt.push_str(&format!("\n\nThe user added: {text}"));
            let a = self.ask(
                vela,
                space,
                AskRequest {
                    role: t.role,
                    prompt,
                    harness: None,
                    tier: None,
                },
                emit,
            )?;
            t.agent = a.id;
            t.turns.push(crate::comments::Turn {
                text: text.to_string(),
                log_from: 0,
            });
            for turn in t.turns.iter_mut() {
                turn.log_from = 0;
            }
        }
        t.resolved = false;
        crate::comments::save(vela, &space.id, &list)
    }

    /// Ask for a fix of a reviewer note. The agent that proposed the hunk gets it back when it
    /// can be resumed; otherwise a new developer agent starts with the note as the request.
    pub fn ask_fix(
        self: &Arc<Self>,
        vela: &Vela,
        space: &Space,
        note: &crate::notes::Note,
        author: Option<&str>,
        emit: &Emit,
    ) -> Result<Agent> {
        let prompt = crate::notes::fix_prompt(note);
        let resumable = author
            .and_then(|a| registry::find(vela, &space.id, a).ok())
            .filter(|e| {
                !e.read_only
                    && e.agent.session.is_some()
                    && e.agent.status != AgentStatus::Working
                    && !self.is_live(&space.id, &e.agent.id)
            });
        let agent = match resumable {
            Some(e) => self.follow_up(vela, space, &e.agent.id, &prompt, emit)?,
            None => self.ask(
                vela,
                space,
                AskRequest {
                    role: AgentRole::Developer,
                    prompt,
                    harness: None,
                    tier: None,
                },
                emit,
            )?,
        };
        let mut st = crate::notes::load_state(vela, &space.id);
        st.fixers.insert(note.id.clone(), agent.id.clone());
        crate::notes::save_state(vela, &space.id, &st)?;
        Ok(agent)
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
                replier: handle.replier(),
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
