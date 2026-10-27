//! Check commands on temporary repos: listing, toggling, background runs and events,
//! the automatic rerun, and the commit shortcut. No webview.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tempfile::TempDir;
use vela_app::checkrun::{CheckEvent, CheckRunner, EmitCheck};
use vela_app::commands;
use vela_core::Vela;
use vela_core::model::{CheckStatus, CommitGroup, Space};

fn sh(dir: &Path, args: &[&str]) -> String {
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

fn write(dir: &Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

struct Env {
    _tmp: TempDir,
    root: PathBuf,
    source: PathBuf,
    vela: Vela,
    runner: Arc<CheckRunner>,
    events: Arc<Mutex<Vec<CheckEvent>>>,
    emit: EmitCheck,
}

fn env(config: &str) -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let source = root.join("api");
    fs::create_dir_all(&source).unwrap();
    sh(&source, &["init", "-q", "-b", "main"]);
    sh(&source, &["config", "user.name", "Test"]);
    sh(&source, &["config", "user.email", "test@example.com"]);
    sh(&source, &["config", "commit.gpgsign", "false"]);
    write(&source, "a.txt", "one\n");
    write(&source, "Cargo.toml", "[package]\nname = \"x\"\n");
    write(&source, ".vela/config.toml", config);
    sh(&source, &["add", "-A"]);
    sh(&source, &["commit", "-q", "-m", "init"]);
    let events: Arc<Mutex<Vec<CheckEvent>>> = Arc::default();
    let sink = events.clone();
    let emit: EmitCheck = Arc::new(move |e| sink.lock().unwrap().push(e));
    Env {
        vela: Vela::new(root.join("home")),
        runner: Arc::default(),
        events,
        emit,
        root,
        source,
        _tmp: tmp,
    }
}

fn space(e: &Env) -> Space {
    commands::create_space(
        &e.vela,
        "Fix it",
        &[e.source.to_string_lossy().into_owned()],
        None,
        None,
    )
    .unwrap()
}

fn wt(s: &Space) -> PathBuf {
    PathBuf::from(&s.repos[0].worktree)
}

fn status_of(e: &Env, id: &str) -> CheckStatus {
    let rc = commands::checks(&e.vela, &e.runner, "fix-it").unwrap();
    rc[0].checks.iter().find(|c| c.id == id).unwrap().status
}

fn finals(e: &Env, id: &str) -> Vec<CheckEvent> {
    e.events
        .lock()
        .unwrap()
        .iter()
        .filter(|ev| ev.id == id && ev.line.is_none() && ev.status != CheckStatus::Running)
        .cloned()
        .collect()
}

fn wait(e: &Env) {
    assert!(
        e.runner.wait_idle(Duration::from_secs(20)),
        "checks still running"
    );
}

const CONFIG: &str = r#"
[[checks.custom]]
id = "hello"
name = "Hello"
run = "echo hello; echo world"
kind = "lint"

[[checks.custom]]
id = "boom"
name = "Boom"
run = "echo 'src/a.ts:1 bad thing'; exit 2"
kind = "lint"
when = "manual"
"#;

#[test]
fn lists_checks_per_repo_and_toggles_a_detected_test() {
    let e = env(CONFIG);
    space(&e);
    let rc = commands::checks(&e.vela, &e.runner, "fix-it").unwrap();
    assert_eq!(rc.len(), 1);
    assert_eq!(rc[0].repo, "api");
    assert!(rc[0].auto);
    let ids: Vec<&str> = rc[0].checks.iter().map(|c| c.id.as_str()).collect();
    assert!(ids.contains(&"clippy") && ids.contains(&"cargo-test"));
    assert!(ids.contains(&"hello") && ids.contains(&"boom"));
    assert_eq!(status_of(&e, "cargo-test"), CheckStatus::Disabled);
    assert_eq!(status_of(&e, "hello"), CheckStatus::Idle);

    commands::set_check_enabled(&e.vela, "fix-it", "api", "cargo-test", true).unwrap();
    assert_ne!(status_of(&e, "cargo-test"), CheckStatus::Disabled);
    // Written to the local layer, the committed config is untouched.
    let local = fs::read_to_string(e.root.join("home/repos/api.toml")).unwrap();
    assert!(
        local.contains("cargo-test") && local.contains("enabled = true"),
        "{local}"
    );
    assert_eq!(
        fs::read_to_string(e.source.join(".vela/config.toml")).unwrap(),
        CONFIG
    );

    commands::set_check_enabled(&e.vela, "fix-it", "api", "hello", false).unwrap();
    assert_eq!(status_of(&e, "hello"), CheckStatus::Disabled);

    assert_eq!(
        commands::set_check_enabled(&e.vela, "fix-it", "nope", "x", true)
            .unwrap_err()
            .kind,
        "repo_not_found"
    );
    assert_eq!(
        commands::set_check_enabled(&e.vela, "fix-it", "api", "a.b", true)
            .unwrap_err()
            .kind,
        "invalid_input"
    );
}

#[test]
fn run_checks_emits_events_and_keeps_the_log() {
    let e = env(CONFIG);
    let s = space(&e);
    write(&wt(&s), "a.txt", "one\ntwo\n");
    sh(&wt(&s), &["add", "a.txt"]);

    let ids = vec!["hello".to_string(), "boom".to_string()];
    let started =
        commands::run_checks(&e.vela, &e.runner, "fix-it", Some(&ids), false, &e.emit).unwrap();
    assert_eq!(started.len(), 2);
    wait(&e);

    let hello = e
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|x| x.id == "hello")
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(hello[0].status, CheckStatus::Running);
    assert!(hello[0].line.is_none());
    let lines: Vec<&str> = hello.iter().filter_map(|x| x.line.as_deref()).collect();
    assert_eq!(lines, ["hello", "world"]);
    let last = hello.last().unwrap();
    assert_eq!(last.status, CheckStatus::Pass);
    assert_eq!(last.cached, Some(false));
    assert_eq!(last.exit_code, Some(0));
    assert!(last.duration_ms.is_some());
    assert_eq!(last.space_id, "fix-it");

    let boom = finals(&e, "boom");
    assert_eq!(boom.last().unwrap().status, CheckStatus::Fail);
    assert_eq!(boom.last().unwrap().exit_code, Some(2));

    assert_eq!(status_of(&e, "hello"), CheckStatus::Pass);
    assert_eq!(status_of(&e, "boom"), CheckStatus::Fail);
    let log = commands::check_log(&e.vela, &e.runner, "fix-it", "api", "boom").unwrap();
    assert!(log.contains("src/a.ts:1 bad thing"), "{log}");
    assert_eq!(
        commands::check_log(&e.vela, &e.runner, "fix-it", "nope", "boom")
            .unwrap_err()
            .kind,
        "repo_not_found"
    );

    // Second run: same staged set, served from the cache.
    e.events.lock().unwrap().clear();
    commands::run_checks(
        &e.vela,
        &e.runner,
        "fix-it",
        Some(&["hello".to_string()]),
        false,
        &e.emit,
    )
    .unwrap();
    wait(&e);
    assert_eq!(finals(&e, "hello").last().unwrap().cached, Some(true));
    assert_eq!(status_of(&e, "hello"), CheckStatus::Pass);

    // Staging more makes the listing go back to idle until it runs again.
    write(&wt(&s), "b.txt", "x\n");
    sh(&wt(&s), &["add", "b.txt"]);
    assert_eq!(status_of(&e, "hello"), CheckStatus::Idle);
}

#[test]
fn running_status_is_reported_and_a_second_start_is_ignored() {
    let e = env("[[checks.custom]]\nid = \"slow\"\nrun = \"echo go; sleep 1\"\n");
    let s = space(&e);
    write(&wt(&s), "a.txt", "two\n");
    sh(&wt(&s), &["add", "a.txt"]);
    let ids = vec!["slow".to_string()];
    let first =
        commands::run_checks(&e.vela, &e.runner, "fix-it", Some(&ids), false, &e.emit).unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(status_of(&e, "slow"), CheckStatus::Running);
    let second =
        commands::run_checks(&e.vela, &e.runner, "fix-it", Some(&ids), false, &e.emit).unwrap();
    assert!(second.is_empty());
    wait(&e);
    assert_eq!(status_of(&e, "slow"), CheckStatus::Pass);
}

#[test]
fn run_all_runs_enabled_checks_only() {
    let e = env(CONFIG);
    let s = space(&e);
    write(&wt(&s), "a.txt", "two\n");
    sh(&wt(&s), &["add", "a.txt"]);
    commands::set_check_enabled(&e.vela, "fix-it", "api", "clippy", false).unwrap();
    let started = commands::run_checks(&e.vela, &e.runner, "fix-it", None, false, &e.emit).unwrap();
    let ids: Vec<String> = started.into_iter().map(|(_, id)| id).collect();
    // cargo-test is optional (off), clippy was turned off, `boom` runs when asked for all.
    assert!(ids.contains(&"hello".to_string()) && ids.contains(&"boom".to_string()));
    assert!(!ids.contains(&"cargo-test".to_string()) && !ids.contains(&"clippy".to_string()));
    wait(&e);
}

#[test]
fn auto_runs_staged_checks_once_per_staged_set() {
    let e = env(CONFIG);
    let s = space(&e);
    // Nothing staged: nothing runs.
    assert!(
        e.runner
            .auto_now(&e.vela, "fix-it", &e.emit)
            .unwrap()
            .is_empty()
    );

    write(&wt(&s), "a.txt", "two\n");
    sh(&wt(&s), &["add", "a.txt"]);
    commands::set_check_enabled(&e.vela, "fix-it", "api", "clippy", false).unwrap();
    let started = e.runner.auto_now(&e.vela, "fix-it", &e.emit).unwrap();
    let ids: Vec<&str> = started.iter().map(|(_, id)| id.as_str()).collect();
    // `boom` is manual, cargo-test is off, clippy was turned off.
    assert_eq!(ids, ["hello"]);
    wait(&e);
    // Same staged set: nothing to do.
    assert!(
        e.runner
            .auto_now(&e.vela, "fix-it", &e.emit)
            .unwrap()
            .is_empty()
    );

    // checks.auto = false in the local layer stops it.
    write(&wt(&s), "b.txt", "1\n");
    sh(&wt(&s), &["add", "b.txt"]);
    vela_core::config::set_local_value(
        &e.vela,
        "api",
        &["checks", "auto"],
        toml::Value::Boolean(false),
    )
    .unwrap();
    assert!(
        e.runner
            .auto_now(&e.vela, "fix-it", &e.emit)
            .unwrap()
            .is_empty()
    );
    let rc = commands::checks(&e.vela, &e.runner, "fix-it").unwrap();
    assert!(!rc[0].auto);
}

#[test]
fn schedule_auto_debounces_a_burst_into_one_run() {
    let e = env("[[checks.custom]]\nid = \"count\"\nrun = \"echo x >> ../count.log\"\n");
    let s = space(&e);
    write(&wt(&s), "a.txt", "two\n");
    sh(&wt(&s), &["add", "a.txt"]);
    for _ in 0..5 {
        e.runner.schedule_auto(&e.vela, "fix-it", &e.emit);
        std::thread::sleep(Duration::from_millis(30));
    }
    std::thread::sleep(vela_app::checkrun::AUTO_DEBOUNCE + Duration::from_millis(600));
    wait(&e);
    let finals = finals(&e, "count");
    assert_eq!(finals.len(), 1, "{finals:?}");
    assert_eq!(finals[0].status, CheckStatus::Pass);
}

const HOOK_CONFIG: &str = r#"
[[checks.custom]]
id = "gate"
name = "Gate"
run = "echo gate ok"
kind = "hook"
"#;

/// A pre-commit hook in the source repo's hooks dir that always refuses, and the
/// detected check for it switched off, so only `gate` stands for the hooks.
fn refusing_hook(e: &Env) {
    let p = e.source.join(".git/hooks/pre-commit");
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, "#!/bin/sh\necho refused >&2\nexit 1\n").unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    commands::set_check_enabled(&e.vela, "fix-it", "api", "git-hook", false).unwrap();
}

#[test]
fn commit_skips_the_hooks_a_passed_hook_check_covered() {
    let e = env(HOOK_CONFIG);
    let s = space(&e);
    refusing_hook(&e);
    write(&wt(&s), "a.txt", "two\n");
    sh(&wt(&s), &["add", "a.txt"]);

    // No check ran: git runs the refusing hook and the commit fails.
    let err = commands::commit(&e.vela, "fix-it", "fix: a", None).unwrap_err();
    assert_eq!(err.kind, "git");
    assert!(
        err.message.contains("refused") || err.message.contains("pre-commit"),
        "{err}"
    );

    // The gate check passes on this tree: the commit goes through with --no-verify.
    let ids = vec!["gate".to_string()];
    commands::run_checks(&e.vela, &e.runner, "fix-it", Some(&ids), false, &e.emit).unwrap();
    wait(&e);
    assert_eq!(status_of(&e, "gate"), CheckStatus::Pass);
    let r = commands::commit(&e.vela, "fix-it", "fix: a", None).unwrap();
    assert_eq!(r.repos, ["api"]);
    let msg = sh(&wt(&s), &["log", "-1", "--format=%B"]);
    let tree = sh(&wt(&s), &["rev-parse", "HEAD^{tree}"]);
    assert!(
        msg.contains(&format!(
            "Vela-Checks: gate passed on {}",
            &tree.trim()[..7]
        )),
        "{msg}"
    );
}

#[test]
fn commit_groups_carry_the_trailer_too() {
    let e = env(HOOK_CONFIG);
    let s = space(&e);
    refusing_hook(&e);
    write(&wt(&s), "a.txt", "two\n");
    sh(&wt(&s), &["add", "a.txt"]);
    let ids = vec!["gate".to_string()];
    commands::run_checks(&e.vela, &e.runner, "fix-it", Some(&ids), false, &e.emit).unwrap();
    wait(&e);
    let plan = commands::commit_plan(&e.vela, "fix-it").unwrap();
    let groups: Vec<CommitGroup> = plan.groups;
    assert_eq!(groups.len(), 1);
    let r = commands::commit_groups(&e.vela, "fix-it", plan.conventional, groups, None).unwrap();
    assert_eq!(r.commits.len(), 1);
    assert!(sh(&wt(&s), &["log", "-1", "--format=%B"]).contains("Vela-Checks: gate passed on "));
}

#[test]
fn stage_unstage_file_and_auto_toggle() {
    let e = env(CONFIG);
    let s = space(&e);
    write(&wt(&s), "a.txt", "two\n");
    commands::stage_file(&e.vela, "fix-it", "api", "a.txt").unwrap();
    assert!(sh(&wt(&s), &["diff", "--cached", "--name-only"]).contains("a.txt"));
    commands::unstage_file(&e.vela, "fix-it", "api", "a.txt").unwrap();
    assert!(sh(&wt(&s), &["diff", "--cached", "--name-only"]).is_empty());
    commands::set_checks_auto(&e.vela, "fix-it", "api", false).unwrap();
    let rc = commands::checks(&e.vela, &e.runner, "fix-it").unwrap();
    assert!(!rc[0].auto);
    assert_eq!(
        commands::set_checks_auto(&e.vela, "fix-it", "zz", true)
            .unwrap_err()
            .kind,
        "repo_not_found"
    );
}
