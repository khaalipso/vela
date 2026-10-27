//! Terminals inside the window: a shell in a pseudo terminal, started in a space worktree.
//! Output goes to the UI as `vela://term` events; the UI (xterm.js) sends keys back.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;

use crate::error::{AppError, AppResult};

pub const EVENT: &str = "vela://term";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TermEvent {
    /// Output of the shell (UTF-8; a split character waits for the next chunk).
    Data { id: u64, data: String },
    /// The shell exited.
    Exit { id: u64, code: Option<u32> },
}

pub type EmitTerm = Arc<dyn Fn(TermEvent) + Send + Sync>;

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    next: AtomicU64,
    open: Mutex<HashMap<u64, Term>>,
}

/// The user's shell: `$SHELL`, else `/bin/sh`.
pub fn shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string())
}

/// The longest prefix of `buf` that is valid UTF-8, as a string, and what is left after it
/// (an incomplete character at the end, kept for the next chunk).
pub fn take_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let out = s.to_string();
            buf.clear();
            out
        }
        Err(e) => {
            let good = e.valid_up_to();
            // An invalid byte in the middle (not just a split char at the end): replace it.
            if e.error_len().is_some() {
                let out = String::from_utf8_lossy(buf).into_owned();
                buf.clear();
                return out;
            }
            let out = String::from_utf8_lossy(&buf[..good]).into_owned();
            buf.drain(..good);
            out
        }
    }
}

impl Terminals {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Term>> {
        self.open.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Start a shell in `cwd`. Returns the terminal id.
    pub fn open(
        self: &Arc<Self>,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        emit: EmitTerm,
    ) -> AppResult<u64> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: rows.max(2),
                cols: cols.max(10),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::new("io", format!("cannot open a terminal: {e}")))?;
        let mut cmd = CommandBuilder::new(shell());
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "vela");
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::new("io", format!("cannot start the shell: {e}")))?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::new("io", e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::new("io", e.to_string()))?;
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        self.lock().insert(
            id,
            Term {
                master: pair.master,
                writer,
                child,
            },
        );
        let me = self.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&chunk[..n]);
                        let data = take_utf8(&mut pending);
                        if !data.is_empty() {
                            emit(TermEvent::Data { id, data });
                        }
                    }
                }
            }
            let code = me
                .lock()
                .remove(&id)
                .and_then(|mut t| t.child.wait().ok())
                .map(|s| s.exit_code());
            emit(TermEvent::Exit { id, code });
        });
        Ok(id)
    }

    pub fn write(&self, id: u64, data: &str) -> AppResult<()> {
        let mut open = self.lock();
        let t = open
            .get_mut(&id)
            .ok_or_else(|| AppError::invalid("this terminal is closed"))?;
        t.writer
            .write_all(data.as_bytes())
            .and_then(|_| t.writer.flush())
            .map_err(|e| AppError::new("io", e.to_string()))
    }

    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> AppResult<()> {
        let open = self.lock();
        let t = open
            .get(&id)
            .ok_or_else(|| AppError::invalid("this terminal is closed"))?;
        t.master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(10),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::new("io", e.to_string()))
    }

    /// Kill the shell. The reader thread then sends `Exit`.
    pub fn close(&self, id: u64) {
        if let Some(t) = self.lock().get_mut(&id) {
            let _ = t.child.kill();
        }
    }

    pub fn close_all(&self) {
        for t in self.lock().values_mut() {
            let _ = t.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    #[test]
    fn utf8_split_across_chunks_waits_for_the_rest() {
        let bytes = "é".as_bytes();
        let mut buf = vec![b'a', bytes[0]];
        assert_eq!(take_utf8(&mut buf), "a");
        assert_eq!(buf, vec![bytes[0]]);
        buf.push(bytes[1]);
        assert_eq!(take_utf8(&mut buf), "é");
        assert!(buf.is_empty());
    }

    #[test]
    fn runs_a_shell_and_reports_exit() {
        let terms = Arc::new(Terminals::default());
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        let emit: EmitTerm = Arc::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        });
        let dir = tempfile::tempdir().unwrap();
        let id = terms.open(dir.path().to_path_buf(), 80, 24, emit).unwrap();
        terms.write(id, "echo vela-$((40+2))\nexit\n").unwrap();
        let mut out = String::new();
        let mut exited = false;
        while let Ok(e) = rx.recv_timeout(Duration::from_secs(10)) {
            match e {
                TermEvent::Data { data, .. } => out.push_str(&data),
                TermEvent::Exit { .. } => {
                    exited = true;
                    break;
                }
            }
        }
        assert!(out.contains("vela-42"), "{out}");
        assert!(exited);
        assert!(terms.write(id, "x").is_err());
    }
}
