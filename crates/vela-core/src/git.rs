//! Thin runner over the `git` CLI. Everything in the core goes through it.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{Error, Result};

/// Run `git <args>` in `dir`, return stdout (untrimmed).
pub fn git(dir: &Path, args: &[&str]) -> Result<String> {
    git_with(dir, args, &[], None)
}

/// How long a command waits for an `index.lock` held by another process before it gives up.
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_millis(3000);

/// Like [`git`] with extra environment variables and optional stdin.
///
/// Vela reads the repo all the time (status on every file change) while the person stages and
/// commits. Read commands must not take the index lock for their opportunistic refresh
/// (`GIT_OPTIONAL_LOCKS=0`), and a command that still meets the lock of another process (the
/// person's editor, a terminal) waits a moment for it instead of failing at once.
pub fn git_with(
    dir: &Path,
    args: &[&str],
    envs: &[(&str, &Path)],
    stdin: Option<&str>,
) -> Result<String> {
    let started = std::time::Instant::now();
    let mut pause = std::time::Duration::from_millis(25);
    loop {
        match run(dir, args, envs, stdin) {
            Err(Error::Git { stderr, .. }) if is_lock_busy(&stderr) && started.elapsed() < LOCK_WAIT => {
                std::thread::sleep(pause);
                pause = (pause * 2).min(std::time::Duration::from_millis(400));
            }
            r => return r,
        }
    }
}

/// Git's refusal when another process holds a lock file (`index.lock`, `HEAD.lock`, a ref).
fn is_lock_busy(stderr: &str) -> bool {
    stderr.contains(".lock': File exists")
}

fn run(dir: &Path, args: &[&str], envs: &[(&str, &Path)], stdin: Option<&str>) -> Result<String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn()?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // A broken pipe means git bailed out early; its stderr explains why.
        let _ = pipe.write_all(input.as_bytes());
    }
    let out = child.wait_with_output()?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(Error::Git {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    }
}

/// The branch checked out in `dir` (a clone or a worktree), read from `HEAD` without running
/// git: cheap enough to call on every load. None when detached or unreadable.
pub fn head_branch(dir: &Path) -> Option<String> {
    let dot_git = dir.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        // A linked worktree: `.git` is a file "gitdir: <path>".
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let p = text.strip_prefix("gitdir:")?.trim();
        let p = Path::new(p);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            dir.join(p)
        }
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    head.trim()
        .strip_prefix("ref: refs/heads/")
        .map(str::to_string)
}

#[cfg(test)]
mod lock_tests {
    use super::*;

    fn repo() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("vela-lock-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        git(&d, &["init", "-q"]).unwrap();
        std::fs::write(d.join("a"), "x").unwrap();
        d
    }

    #[test]
    fn waits_for_a_lock_that_goes_away() {
        let d = repo();
        let lock = d.join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let l = lock.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            std::fs::remove_file(l).unwrap();
        });
        git(&d, &["add", "--", "a"]).unwrap();
        t.join().unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn gives_up_on_a_stale_lock_with_git_message() {
        let d = repo();
        std::fs::write(d.join(".git/index.lock"), "").unwrap();
        let e = git(&d, &["add", "--", "a"]).unwrap_err().to_string();
        assert!(e.contains("index.lock"), "{e}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn status_does_not_need_the_lock() {
        let d = repo();
        std::fs::write(d.join(".git/index.lock"), "").unwrap();
        let t = std::time::Instant::now();
        git(&d, &["status", "--porcelain"]).unwrap();
        assert!(t.elapsed() < std::time::Duration::from_millis(1500));
        let _ = std::fs::remove_dir_all(&d);
    }
}
