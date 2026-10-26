//! Thin runner over the `git` CLI. Everything in the core goes through it.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{Error, Result};

/// Run `git <args>` in `dir`, return stdout (untrimmed).
pub fn git(dir: &Path, args: &[&str]) -> Result<String> {
    git_with(dir, args, &[], None)
}

/// Like [`git`] with extra environment variables and optional stdin.
pub fn git_with(
    dir: &Path,
    args: &[&str],
    envs: &[(&str, &Path)],
    stdin: Option<&str>,
) -> Result<String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
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
