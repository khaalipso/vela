//! An app started from the Dock, Finder or a desktop launcher gets a short `PATH`
//! (`/usr/bin:/bin:...` on macOS), so the harnesses, `pnpm`, `mise` and the like are not
//! found. Before anything else runs, Vela asks the user's login shell for its `PATH` and puts
//! it in front of the one it was given.

use std::io::IsTerminal;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MARK: &str = "__VELA_PATH__";

/// The `PATH` between the markers in the output of the shell (rc files may print around it).
pub fn extract(out: &str) -> Option<String> {
    let start = out.find(MARK)? + MARK.len();
    let end = start + out[start..].find(MARK)?;
    let p = out[start..end].trim();
    (!p.is_empty()).then(|| p.to_string())
}

/// `first` then the entries of `rest` it does not have, without duplicates or empty entries.
pub fn merge(first: &str, rest: &str) -> String {
    let mut seen = Vec::new();
    for d in first.split(':').chain(rest.split(':')) {
        if !d.is_empty() && !seen.contains(&d) {
            seen.push(d);
        }
    }
    seen.join(":")
}

fn login_path(timeout: Duration) -> Option<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/sh".into()
            }
        });
    let mut child = Command::new(shell)
        .args([
            "-l",
            "-i",
            "-c",
            &format!("printf '{MARK}%s{MARK}' \"$PATH\""),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let end = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    extract(&String::from_utf8_lossy(&out.stdout))
}

/// Import the login shell's `PATH` when Vela was not started from a terminal. Call it first in
/// `main`, while there is a single thread. `VELA_KEEP_PATH=1` turns it off.
pub fn import_login_path() {
    if std::io::stdin().is_terminal() || std::env::var_os("VELA_KEEP_PATH").is_some() {
        return;
    }
    let Some(login) = login_path(Duration::from_secs(3)) else {
        return;
    };
    let current = std::env::var("PATH").unwrap_or_default();
    // SAFETY: called at the start of main, before any other thread exists.
    unsafe { std::env::set_var("PATH", merge(&login, &current)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_between_markers_and_merges() {
        let out = format!("motd line\n{MARK}/opt/homebrew/bin:/usr/bin{MARK}\n");
        assert_eq!(extract(&out).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(extract("nothing"), None);
        assert_eq!(
            merge("/a:/usr/bin", "/usr/bin:/bin::/a"),
            "/a:/usr/bin:/bin"
        );
    }
}
