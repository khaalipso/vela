//! Which harnesses are installed.

use std::ffi::OsStr;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::driver::locate;
use crate::tiers::{HARNESSES, harness_label};

/// One harness and whether it can be run. Mirrors `Harness` of the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessInfo {
    pub name: String,
    pub label: String,
    pub available: bool,
    pub path: Option<String>,
    /// First line of `<binary> --version`.
    pub version: Option<String>,
}

fn version_of(bin: &std::path::Path) -> Option<String> {
    let mut child = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let end = Instant::now() + Duration::from_secs(5);
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
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(80).collect())
}

/// Check every harness: binary on `path` (the `PATH` format; None for the process `PATH`
/// plus the usual install directories) and its version.
pub fn detect(path: Option<&OsStr>) -> Vec<HarnessInfo> {
    // `--version` of a Node based CLI can take a second: ask them all at once.
    std::thread::scope(|scope| {
        let jobs: Vec<_> = HARNESSES
            .iter()
            .map(|name| {
                let bin = locate(name, path);
                scope.spawn(move || HarnessInfo {
                    name: (*name).to_string(),
                    label: harness_label(name).to_string(),
                    available: bin.is_some(),
                    version: bin.as_deref().and_then(version_of),
                    path: bin.map(|b| b.to_string_lossy().into_owned()),
                })
            })
            .collect();
        jobs.into_iter()
            .map(|j| j.join().expect("version thread"))
            .collect()
    })
}

/// The installed harnesses, without running them (a lookup on the `PATH`).
pub fn installed(path: Option<&OsStr>) -> Vec<String> {
    HARNESSES
        .iter()
        .filter(|n| locate(n, path).is_some())
        .map(|n| n.to_string())
        .collect()
}
