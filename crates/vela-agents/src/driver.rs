//! The driver contract and the process plumbing the drivers share.

use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use vela_core::model::{AgentRole, Tier};
use vela_core::{Error, Result};

use crate::event::AgentEvent;

/// Everything a driver needs to start one run.
#[derive(Debug, Clone, PartialEq)]
pub struct RunSpec {
    /// "claude", "codex" or "opencode".
    pub harness: String,
    /// None: the harness picks its default model.
    pub model: Option<String>,
    pub tier: Option<Tier>,
    pub role: AgentRole,
    pub prompt: String,
    /// The agent worktree (or, for read only runs, the user's worktree).
    pub cwd: PathBuf,
    /// Resume this conversation instead of starting one.
    pub session: Option<String>,
    /// Use the harness's read only / plan mode.
    pub read_only: bool,
    pub extra_args: Vec<String>,
}

/// A running harness process and its normalized events.
pub struct RunHandle {
    events: Receiver<AgentEvent>,
    ctl: Arc<Ctl>,
}

struct Ctl {
    pid: u32,
    cancelled: AtomicBool,
}

impl RunHandle {
    /// Next event, waiting at most `timeout`. None when the run is over (after Done or Failed).
    pub fn next_timeout(&self, timeout: Duration) -> Option<AgentEvent> {
        self.events.recv_timeout(timeout).ok()
    }

    /// Blocks until the next event. None when the run is over.
    pub fn recv(&self) -> Option<AgentEvent> {
        self.events.recv().ok()
    }

    /// Every remaining event, up to and including the terminal one.
    pub fn collect(&self) -> Vec<AgentEvent> {
        self.events.iter().collect()
    }

    pub fn pid(&self) -> u32 {
        self.ctl.pid
    }

    /// Kill the process and its children. The stream ends with `Failed { error: "cancelled" }`.
    pub fn cancel(&self) {
        self.ctl.cancel();
    }

    /// A cheap handle that can cancel this run from another thread.
    pub fn canceller(&self) -> Canceller {
        Canceller(self.ctl.clone())
    }
}

impl Ctl {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        kill_group(self.pid);
    }
}

/// Cancels a run without owning its event stream.
#[derive(Clone)]
pub struct Canceller(Arc<Ctl>);

impl Canceller {
    pub fn cancel(&self) {
        self.0.cancel();
    }
}

/// One harness. `start` begins a run; `reply` continues a finished one with the user's answer.
pub trait AgentDriver: Send + Sync {
    fn harness(&self) -> &'static str;

    fn start(&self, run: RunSpec) -> Result<RunHandle>;

    /// Answer a question. None of the three harnesses reads answers on stdin in non interactive
    /// mode, so the answer is a resumed run of the same session with the answer as the prompt.
    fn reply(&self, run: &RunSpec, session: &str, text: &str) -> Result<RunHandle> {
        let mut next = run.clone();
        next.session = Some(session.to_string());
        next.prompt = text.to_string();
        self.start(next)
    }
}

/// Turns the stdout of a harness, a line at a time, into events. Unknown lines give no events.
pub trait LineParser: Send {
    fn parse(&mut self, line: &str) -> Vec<AgentEvent>;
}

/// Parse a whole recorded stream (for tests and for replaying a log).
pub fn parse_stream(parser: &mut dyn LineParser, text: &str) -> Vec<AgentEvent> {
    text.lines().flat_map(|l| parser.parse(l)).collect()
}

pub(crate) fn kill_group(pid: u32) {
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Where harness binaries are looked for besides `PATH`, because an app started from a
/// launcher often has a short `PATH`.
fn fallback_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for d in [
            ".local/bin",
            ".local/share/mise/shims",
            ".bun/bin",
            ".cargo/bin",
            ".npm-global/bin",
            ".volta/bin",
        ] {
            v.push(home.join(d));
        }
    }
    v.push(PathBuf::from("/usr/local/bin"));
    v.push(PathBuf::from("/opt/homebrew/bin"));
    v
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Find `name` in the directories of `path` (the `PATH` format). Without `path`, the process
/// `PATH` is used and the usual install directories are tried after it.
pub fn locate(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = match path {
        Some(p) => std::env::split_paths(p).collect(),
        None => std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default(),
    };
    if path.is_none() {
        dirs.extend(fallback_dirs());
    }
    dirs.into_iter()
        .map(|d| d.join(name))
        .find(|p| is_executable(p))
}

const STDERR_TAIL: usize = 2000;

/// Spawn `bin` in its own process group and stream its stdout through `parser`.
///
/// The stream always ends with exactly one Done or Failed: the one the parser produced, or
/// else one made from the exit status. Events after the terminal one are dropped.
pub(crate) fn launch(
    bin: &Path,
    args: &[String],
    stdin: Option<String>,
    cwd: &Path,
    mut parser: Box<dyn LineParser>,
) -> Result<RunHandle> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = cmd
        .spawn()
        .map_err(|e| Error::Invalid(format!("cannot start {}: {e}", bin.display())))?;
    let ctl = Arc::new(Ctl {
        pid: child.id(),
        cancelled: AtomicBool::new(false),
    });
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = pipe.write_all(text.as_bytes());
        });
    }
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let err_tail = Arc::new(Mutex::new(String::new()));
    let err_thread = {
        let tail = err_tail.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf);
            let text = String::from_utf8_lossy(&buf).into_owned();
            let start = text.len().saturating_sub(STDERR_TAIL);
            let start = (start..=text.len())
                .find(|i| text.is_char_boundary(*i))
                .unwrap_or(text.len());
            if let Ok(mut t) = tail.lock() {
                *t = text[start..].trim().to_string();
            }
        })
    };
    let (tx, rx) = channel();
    let thread_ctl = ctl.clone();
    std::thread::spawn(move || {
        let mut state = Forward {
            tx,
            terminal: false,
            last_text: String::new(),
        };
        let mut reader = BufReader::new(stdout);
        let mut raw = Vec::new();
        loop {
            raw.clear();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&raw);
                    let line = line.trim_end_matches(['\n', '\r']);
                    if !line.trim().is_empty() {
                        for e in parser.parse(line) {
                            state.send(e);
                        }
                    }
                }
            }
        }
        let status = child.wait();
        let _ = err_thread.join();
        if !state.terminal {
            let tail = err_tail.lock().map(|t| t.clone()).unwrap_or_default();
            let end = if thread_ctl.cancelled.load(Ordering::SeqCst) {
                AgentEvent::Failed {
                    error: "cancelled".to_string(),
                }
            } else {
                match status {
                    Ok(s) if s.success() => AgentEvent::Done {
                        summary: state.last_text.clone(),
                    },
                    Ok(s) => AgentEvent::Failed {
                        error: if tail.is_empty() {
                            format!("the harness exited with {s}")
                        } else {
                            tail
                        },
                    },
                    Err(e) => AgentEvent::Failed {
                        error: e.to_string(),
                    },
                }
            };
            state.send(end);
        }
    });
    Ok(RunHandle { events: rx, ctl })
}

struct Forward {
    tx: Sender<AgentEvent>,
    terminal: bool,
    last_text: String,
}

impl Forward {
    fn send(&mut self, e: AgentEvent) {
        if self.terminal {
            return;
        }
        match &e {
            AgentEvent::Message { text } => self.last_text = text.clone(),
            e if e.is_terminal() => self.terminal = true,
            _ => {}
        }
        let _ = self.tx.send(e);
    }
}
