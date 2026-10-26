//! Shared helpers: temporary repos, spaces and fake harness executables.

#![allow(dead_code)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tempfile::TempDir;
use vela_agents::{AgentManager, Drivers, Emit, Notice};
use vela_core::Vela;
use vela_core::model::Space;

pub fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

pub fn write(dir: &Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

pub fn make_repo(root: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    sh(&dir, &["init", "-q", "-b", "main"]);
    sh(&dir, &["config", "user.name", "Test"]);
    sh(&dir, &["config", "user.email", "test@example.com"]);
    sh(&dir, &["config", "commit.gpgsign", "false"]);
    for (p, c) in files {
        write(&dir, p, c);
    }
    sh(&dir, &["add", "-A"]);
    sh(&dir, &["commit", "-q", "-m", "init"]);
    dir
}

pub const NOTES: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n\
eleven\ntwelve\nthirteen\nfourteen\nfifteen\nsixteen\nseventeen\neighteen\nnineteen\ntwenty\n";

pub struct Env {
    pub _tmp: TempDir,
    pub root: PathBuf,
    pub vela: Vela,
    pub space: Space,
    /// Directory on the fake `PATH`.
    pub bin: PathBuf,
}

/// A space "Refunds" over one repo `api` holding `notes.txt` and `other.txt`.
pub fn env() -> Env {
    env_with(&["api"])
}

pub fn env_with(repos: &[&str]) -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let vela = Vela::new(root.join("home"));
    let paths: Vec<PathBuf> = repos
        .iter()
        .map(|n| {
            make_repo(
                &root,
                n,
                &[("notes.txt", NOTES), ("other.txt", "x\ny\nz\n")],
            )
        })
        .collect();
    let space = vela_core::space::create(&vela, "Refunds", &paths, None).unwrap();
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    Env {
        _tmp: tmp,
        root,
        vela,
        space,
        bin,
    }
}

/// Put an executable shell script called `name` in `dir`.
pub fn script(dir: &Path, name: &str, body: &str) {
    let p = dir.join(name);
    fs::write(&p, format!("#!/bin/sh\n{body}")).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
}

pub fn manager(env: &Env) -> Arc<AgentManager> {
    AgentManager::with_config_dir(Drivers::with_path(env.bin.clone()), None)
}

pub type Notices = Arc<Mutex<Vec<Notice>>>;

pub fn collector() -> (Emit, Notices) {
    let seen: Notices = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    (Arc::new(move |n| s.lock().unwrap().push(n)), seen)
}

pub fn idle(m: &AgentManager) {
    assert!(m.wait_idle(Duration::from_secs(20)), "agents still running");
}
