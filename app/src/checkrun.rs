//! Running checks in the background: threads, live logs, `vela://check` events and the
//! debounced rerun after the index changes.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use vela_core::Vela;
use vela_core::checks::{self, Check, Outcome, RunOptions};
use vela_core::model::{CheckStatus, CheckWhen, RepoChecks, Space, SpaceRepo};
use vela_core::store;

use crate::error::AppResult;

pub const EVENT: &str = "vela://check";
/// Quiet time after the last index change before the checks rerun.
pub const AUTO_DEBOUNCE: Duration = Duration::from_millis(500);

/// Mirrors `CheckEvent` of the UI. `line` carries one line of live output while `running`;
/// the other events carry the final status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckEvent {
    pub space_id: String,
    pub repo: String,
    pub id: String,
    pub status: CheckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
}

pub type EmitCheck = Arc<dyn Fn(CheckEvent) + Send + Sync>;

#[derive(Default)]
struct Live {
    running: bool,
    log: String,
}

#[derive(Default)]
pub struct CheckRunner {
    live: Mutex<HashMap<String, Live>>,
    auto_seq: Mutex<HashMap<String, u64>>,
}

fn key(space: &str, repo: &str, id: &str) -> String {
    format!("{space}\0{repo}\0{id}")
}

impl CheckRunner {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Live>> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_running(&self, space: &str, repo: &str, id: &str) -> bool {
        self.lock()
            .get(&key(space, repo, id))
            .is_some_and(|l| l.running)
    }

    pub fn any_running(&self) -> bool {
        self.lock().values().any(|l| l.running)
    }

    /// Wait until nothing runs (for tests). False on timeout.
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let end = Instant::now() + timeout;
        while self.any_running() {
            if Instant::now() >= end {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        true
    }

    /// The checks of every repo, with `running` set where a run is in flight.
    pub fn list(&self, vela: &Vela, space: &Space) -> Vec<RepoChecks> {
        let mut out = checks::space_checks(vela, space);
        let live = self.lock();
        for rc in &mut out {
            for c in &mut rc.checks {
                if live
                    .get(&key(&space.id, &rc.repo, &c.id))
                    .is_some_and(|l| l.running)
                {
                    c.status = CheckStatus::Running;
                }
            }
        }
        out
    }

    /// The log of the run in flight, else of the last one for the current staged set.
    pub fn log(&self, vela: &Vela, space: &Space, repo: &str, id: &str) -> String {
        if let Some(l) = self.lock().get(&key(&space.id, repo, id))
            && (l.running || !l.log.is_empty())
        {
            return l.log.clone();
        }
        let Some(r) = space.repos.iter().find(|r| r.name == repo) else {
            return String::new();
        };
        let (_, found) = checks::load_repo(vela, r);
        found
            .iter()
            .find(|c| c.id == id)
            .and_then(|c| checks::cached_result(space, repo, c).ok().flatten())
            .map(|r| r.output)
            .unwrap_or_default()
    }

    /// Start checks in background threads. `ids` picks checks by id, even disabled ones
    /// (the user asked); without it every enabled check of every repo runs. Checks already
    /// running are left alone. Returns the `(repo, id)` pairs started.
    pub fn run(
        self: &Arc<Self>,
        vela: &Vela,
        space: &Space,
        ids: Option<&[String]>,
        force: bool,
        emit: &EmitCheck,
    ) -> Vec<(String, String)> {
        let mut started = Vec::new();
        for r in &space.repos {
            let (cfg, found) = checks::load_repo(vela, r);
            let opts = RunOptions::from_config(&cfg.config.checks, force);
            for c in found {
                let wanted = match ids {
                    Some(ids) => ids.contains(&c.id),
                    None => c.enabled,
                };
                if !wanted || c.missing {
                    continue;
                }
                if self.start(space, r, c.clone(), opts, emit) {
                    started.push((r.name.clone(), c.id));
                }
            }
        }
        started
    }

    fn start(
        self: &Arc<Self>,
        space: &Space,
        r: &SpaceRepo,
        check: Check,
        opts: RunOptions,
        emit: &EmitCheck,
    ) -> bool {
        let k = key(&space.id, &r.name, &check.id);
        {
            let mut live = self.lock();
            let l = live.entry(k.clone()).or_default();
            if l.running {
                return false;
            }
            l.running = true;
            l.log.clear();
        }
        let base = CheckEvent {
            space_id: space.id.clone(),
            repo: r.name.clone(),
            id: check.id.clone(),
            status: CheckStatus::Running,
            line: None,
            duration_ms: None,
            cached: None,
            exit_code: None,
            timed_out: None,
        };
        emit(base.clone());
        let (me, space, repo, emit) = (self.clone(), space.clone(), r.name.clone(), emit.clone());
        std::thread::spawn(move || {
            let result = checks::run_check_streaming(&space, &repo, &check, &opts, &mut |line| {
                if let Some(l) = me.lock().get_mut(&k) {
                    l.log.push_str(line);
                    l.log.push('\n');
                }
                emit(CheckEvent {
                    line: Some(line.to_string()),
                    ..base.clone()
                });
            });
            let final_event = match &result {
                Ok(r) => CheckEvent {
                    status: match r.outcome {
                        Outcome::Pass => CheckStatus::Pass,
                        Outcome::Fail => CheckStatus::Fail,
                        Outcome::Skipped => CheckStatus::Skipped,
                    },
                    duration_ms: Some(r.duration_ms),
                    cached: Some(r.cached),
                    exit_code: r.exit_code,
                    timed_out: Some(r.timed_out),
                    ..base.clone()
                },
                Err(e) => CheckEvent {
                    status: CheckStatus::Fail,
                    line: Some(e.to_string()),
                    ..base.clone()
                },
            };
            if let Some(l) = me.lock().get_mut(&k) {
                l.running = false;
                match &result {
                    Ok(r) => l.log = r.output.clone(),
                    Err(e) => l.log = e.to_string(),
                }
            }
            emit(final_event);
        });
        true
    }

    /// The index of `space_id` changed: after a quiet [`AUTO_DEBOUNCE`], run the enabled
    /// `when = "staged"` checks of the repos that have `checks.auto` on, skipping repos with
    /// nothing staged and checks that already have a result for this staged set.
    pub fn schedule_auto(self: &Arc<Self>, vela: &Vela, space_id: &str, emit: &EmitCheck) {
        let seq = {
            let mut m = self.auto_seq.lock().unwrap_or_else(|e| e.into_inner());
            let n = m.entry(space_id.to_string()).or_insert(0);
            *n += 1;
            *n
        };
        let (me, vela, id, emit) = (
            self.clone(),
            vela.clone(),
            space_id.to_string(),
            emit.clone(),
        );
        std::thread::spawn(move || {
            std::thread::sleep(AUTO_DEBOUNCE);
            let current = me
                .auto_seq
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&id)
                .copied();
            if current != Some(seq) {
                return;
            }
            let _ = me.auto_now(&vela, &id, &emit);
        });
    }

    /// The body of [`Self::schedule_auto`] without the wait. Returns what was started.
    pub fn auto_now(
        self: &Arc<Self>,
        vela: &Vela,
        space_id: &str,
        emit: &EmitCheck,
    ) -> AppResult<Vec<(String, String)>> {
        let space = store::load(vela, space_id)?;
        let mut started = Vec::new();
        for r in &space.repos {
            let (cfg, found) = checks::load_repo(vela, r);
            if !cfg.config.checks.auto {
                continue;
            }
            if checks::staged_paths(Path::new(&r.worktree))
                .map(|p| p.is_empty())
                .unwrap_or(true)
            {
                continue;
            }
            let opts = RunOptions::from_config(&cfg.config.checks, false);
            for c in found {
                if !c.enabled || c.missing || c.when != CheckWhen::Staged {
                    continue;
                }
                if checks::cached_result(&space, &r.name, &c)?.is_some() {
                    continue;
                }
                if self.start(&space, r, c.clone(), opts, emit) {
                    started.push((r.name.clone(), c.id));
                }
            }
        }
        Ok(started)
    }
}
