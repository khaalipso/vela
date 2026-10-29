//! Checks on real temporary repos: running, timeout, cache, hooks and the commit shortcut.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use tempfile::TempDir;
use vela_core::Vela;
use vela_core::checks::{self, Check, Outcome, RunOptions};
use vela_core::commit::commit_with;
use vela_core::commitplan::commit_groups_with;
use vela_core::config;
use vela_core::model::*;

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
    vela: Vela,
    space: Space,
}

impl Env {
    fn dir(&self) -> &Path {
        Path::new(&self.space.repos[0].worktree)
    }
}

/// A space with one repo called "api" whose worktree is the repo itself.
fn env(files: &[(&str, &str)]) -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let dir = root.join("api");
    fs::create_dir_all(&dir).unwrap();
    sh(&dir, &["init", "-q", "-b", "main"]);
    sh(&dir, &["config", "user.name", "Test"]);
    sh(&dir, &["config", "user.email", "test@example.com"]);
    sh(&dir, &["config", "commit.gpgsign", "false"]);
    write(&dir, "README.md", "# api\n");
    for (p, c) in files {
        write(&dir, p, c);
    }
    sh(&dir, &["add", "-A"]);
    sh(&dir, &["commit", "-q", "-m", "init"]);
    let space = Space {
        id: "task".into(),
        name: "Task".into(),
        color: "#E8A14A".into(),
        branch: "main".into(),
        repos: vec![SpaceRepo {
            name: "api".into(),
            source: dir.to_string_lossy().into_owned(),
            worktree: dir.to_string_lossy().into_owned(),
            base: "main".into(),
            branch: String::new(),
        }],
        created_at: "2026-10-26T00:00:00Z".into(),
        window: None,
        archived: false,
        links: vec![],
        ticket: None,
    };
    Env {
        vela: Vela::new(root.join("home")),
        _tmp: tmp,
        root,
        space,
    }
}

fn custom(id: &str, kind: CheckKind, run: &str) -> Check {
    Check {
        id: id.into(),
        name: id.into(),
        kind,
        command: run.into(),
        optional: false,
        enabled: true,
        missing: false,
        source: "config".into(),
        when: CheckWhen::Staged,
    }
}

fn opts(ms: u64, force: bool) -> RunOptions {
    RunOptions {
        timeout: Duration::from_millis(ms),
        force,
    }
}

fn run(e: &Env, c: &Check) -> checks::CheckResult {
    checks::run_check(&e.space, "api", c, &opts(10_000, false)).unwrap()
}

#[test]
fn pass_and_fail_capture_output_and_exit_code() {
    let e = env(&[]);
    let ok = run(
        &e,
        &custom("ok", CheckKind::Custom, "echo out; echo err >&2"),
    );
    assert_eq!(ok.outcome, Outcome::Pass);
    assert_eq!(ok.exit_code, Some(0));
    assert!(
        ok.output.contains("out") && ok.output.contains("err"),
        "{}",
        ok.output
    );
    assert!(!ok.cached && !ok.timed_out);

    let bad = run(
        &e,
        &custom("bad", CheckKind::Lint, "echo 'src/a.ts:3 unused'; exit 3"),
    );
    assert_eq!(bad.outcome, Outcome::Fail);
    assert_eq!(bad.exit_code, Some(3));
    assert!(bad.output.contains("src/a.ts:3 unused"));
}

#[test]
fn runs_in_the_worktree_and_streams_lines() {
    let e = env(&[]);
    let c = custom("pwd", CheckKind::Custom, "pwd; echo a; echo b");
    let mut lines: Vec<String> = Vec::new();
    let r = checks::run_check_streaming(&e.space, "api", &c, &opts(10_000, false), &mut |l| {
        lines.push(l.to_string())
    })
    .unwrap();
    assert_eq!(lines.len(), 3);
    assert_eq!(Path::new(&lines[0]).canonicalize().unwrap(), e.dir());
    assert_eq!(&lines[1..], ["a", "b"]);
    assert_eq!(r.output, format!("{}\na\nb\n", lines[0]));
}

#[test]
fn timeout_kills_the_whole_process_group() {
    let e = env(&[]);
    let c = custom(
        "slow",
        CheckKind::Custom,
        "echo start; sleep 30 & sleep 30; echo never",
    );
    let t = std::time::Instant::now();
    let r = checks::run_check(&e.space, "api", &c, &opts(300, false)).unwrap();
    assert!(
        t.elapsed() < Duration::from_secs(5),
        "took {:?}",
        t.elapsed()
    );
    assert_eq!(r.outcome, Outcome::Fail);
    assert!(r.timed_out);
    assert!(r.output.contains("start") && !r.output.contains("never"));
    assert!(r.output.contains("Timed out"));
    // A timeout is not cached.
    let again = checks::run_check(&e.space, "api", &c, &opts(300, false)).unwrap();
    assert!(!again.cached);
}

#[test]
fn cache_hits_on_the_same_tree_and_misses_after_staging_more() {
    let e = env(&[("a.txt", "1\n2\n3\n"), ("b.txt", "x\n")]);
    let d = e.dir();
    let counter = e.root.join("count");
    let c = custom(
        "count",
        CheckKind::Lint,
        &format!("echo x >> {}", counter.display()),
    );
    let runs = || {
        fs::read_to_string(&counter)
            .unwrap_or_default()
            .lines()
            .count()
    };

    write(d, "a.txt", "1\n2\n3\n4\n");
    sh(d, &["add", "a.txt"]);
    let first = run(&e, &c);
    assert!(!first.cached);
    assert_eq!(runs(), 1);

    let second = run(&e, &c);
    assert!(second.cached);
    assert_eq!(second.duration_ms, first.duration_ms);
    assert_eq!(runs(), 1);
    assert!(
        checks::cached_result(&e.space, "api", &c)
            .unwrap()
            .is_some()
    );

    // Forcing ignores the cache.
    let forced = checks::run_check(&e.space, "api", &c, &opts(10_000, true)).unwrap();
    assert!(!forced.cached);
    assert_eq!(runs(), 2);

    // Staging another file changes the tree: miss.
    write(d, "b.txt", "y\n");
    sh(d, &["add", "b.txt"]);
    assert!(
        checks::cached_result(&e.space, "api", &c)
            .unwrap()
            .is_none()
    );
    assert!(!run(&e, &c).cached);
    assert_eq!(runs(), 3);

    // Unstaging it again: back to the first tree, hit.
    sh(d, &["restore", "--staged", "b.txt"]);
    assert!(run(&e, &c).cached);
    assert_eq!(runs(), 3);
}

#[test]
fn cache_hunk_level_change_misses() {
    let numbered: String = (1..=40).map(|i| format!("line {i}\n")).collect();
    let e = env(&[("f.txt", &numbered)]);
    let d = e.dir();
    let edited = numbered
        .replace("line 2\n", "line two\n")
        .replace("line 38\n", "line thirty-eight\n");
    write(d, "f.txt", &edited);
    let c = custom("true", CheckKind::Lint, "true");
    // Stage only the first hunk.
    let space = e.space.clone();
    let hunks = vela_core::diff::worktree_hunks(&space).unwrap();
    assert_eq!(hunks.len(), 2);
    let first = hunks[0].id.clone();
    let second = hunks[1].id.clone();
    vela_core::stage::stage_hunk(&space, &first).unwrap();
    assert!(!run(&e, &c).cached);
    assert!(run(&e, &c).cached);
    vela_core::stage::stage_hunk(&space, &second).unwrap();
    assert!(!run(&e, &c).cached);
}

#[test]
fn tests_are_keyed_on_head_too() {
    let e = env(&[]);
    let d = e.dir();
    let t = custom("t", CheckKind::Test, "true");
    assert!(!run(&e, &t).cached);
    assert!(run(&e, &t).cached);
    // Same (empty) staged tree relative to a new HEAD is a different tree anyway; make a
    // commit that leaves the index tree identical to the one before is impossible, so check
    // the key through a new empty commit: tree equal, HEAD different.
    sh(d, &["commit", "-q", "--allow-empty", "-m", "empty"]);
    assert!(!run(&e, &t).cached, "HEAD moved, tests must run again");
    let lint = custom("l", CheckKind::Lint, "true");
    assert!(!run(&e, &lint).cached);
    sh(d, &["commit", "-q", "--allow-empty", "-m", "empty 2"]);
    assert!(run(&e, &lint).cached, "lint only depends on the tree");
}

#[test]
fn files_placeholder_gets_the_staged_paths_and_skips_when_empty() {
    let e = env(&[]);
    let d = e.dir();
    let c = custom(
        "files",
        CheckKind::Hook,
        "for f in {files}; do echo \"got:$f\"; done",
    );
    let none = run(&e, &c);
    assert_eq!(none.outcome, Outcome::Skipped);
    write(d, "src/a b.ts", "1\n");
    write(d, "c.ts", "1\n");
    sh(d, &["add", "-A"]);
    let r = run(&e, &c);
    assert_eq!(r.outcome, Outcome::Pass);
    assert!(
        r.output.contains("got:src/a b.ts") || r.output.contains("got:src/a"),
        "{}",
        r.output
    );
    assert!(r.output.contains("got:c.ts"));
}

/// Install an executable `pre-commit` hook that logs each run and fails when `fail` exists.
fn install_hook(e: &Env) -> PathBuf {
    let log = e.root.join("hook.log");
    let fail = e.root.join("hook.fail");
    let hooks = e.dir().join(".git/hooks");
    fs::create_dir_all(&hooks).unwrap();
    let script = format!(
        "#!/bin/sh\necho ran >> '{}'\nif [ -e '{}' ]; then echo 'hook says no'; exit 1; fi\necho 'hook ok'\n",
        log.display(),
        fail.display()
    );
    let p = hooks.join("pre-commit");
    fs::write(&p, script).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    log
}

fn hook_runs(log: &Path) -> usize {
    fs::read_to_string(log).unwrap_or_default().lines().count()
}

#[test]
fn a_real_pre_commit_hook_in_the_hooks_dir_is_detected_and_run() {
    let e = env(&[]);
    let log = install_hook(&e);
    let (cfg, found) = checks::load_repo(&e.vela, &e.space.repos[0]);
    assert!(cfg.warnings.is_empty());
    let hook = found
        .iter()
        .find(|c| c.kind == CheckKind::Hook)
        .expect("hook detected");
    assert_eq!(hook.id, "git-hook");
    assert!(hook.enabled && !hook.missing);

    write(e.dir(), "x.txt", "1\n");
    sh(e.dir(), &["add", "x.txt"]);
    let r = run(&e, hook);
    assert_eq!(r.outcome, Outcome::Pass);
    assert!(r.output.contains("hook ok"));
    assert_eq!(hook_runs(&log), 1);

    fs::write(e.root.join("hook.fail"), "").unwrap();
    let r = checks::run_check(&e.space, "api", hook, &opts(10_000, true)).unwrap();
    assert_eq!(r.outcome, Outcome::Fail);
    assert!(r.output.contains("hook says no"));
}

#[test]
fn hooks_path_is_respected() {
    let e = env(&[]);
    let hooks = e.root.join("shared-hooks");
    fs::create_dir_all(&hooks).unwrap();
    let p = hooks.join("pre-commit");
    fs::write(&p, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    sh(
        e.dir(),
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    assert_eq!(checks::hooks_dir(e.dir()).unwrap(), hooks);
    let found = checks::detect(e.dir());
    assert!(
        found
            .iter()
            .any(|c| c.id == "git-hook" && c.command.contains("shared-hooks"))
    );
    // Relative path: relative to the worktree.
    sh(e.dir(), &["config", "core.hooksPath", "rel-hooks"]);
    assert_eq!(
        checks::hooks_dir(e.dir()).unwrap(),
        e.dir().join("rel-hooks")
    );
}

#[test]
fn a_non_executable_hook_is_not_a_hook() {
    let e = env(&[]);
    let p = e.dir().join(".git/hooks/pre-commit");
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        checks::detect(e.dir())
            .iter()
            .all(|c| c.kind != CheckKind::Hook)
    );
}

#[test]
fn worktrees_use_the_common_git_dir_for_hooks() {
    let e = env(&[]);
    install_hook(&e);
    let wt = e.root.join("wt");
    sh(
        e.dir(),
        &["worktree", "add", "-q", "-b", "feat", wt.to_str().unwrap()],
    );
    let found = checks::detect(&wt);
    let hook = found
        .iter()
        .find(|c| c.id == "git-hook")
        .expect("hook via common dir");
    assert!(
        hook.command.contains(".git/hooks/pre-commit"),
        "{}",
        hook.command
    );
}

#[test]
fn commit_skips_hooks_that_passed_on_the_exact_tree_and_adds_the_trailer() {
    let e = env(&[]);
    let log = install_hook(&e);
    let d = e.dir();
    write(d, "x.txt", "1\n");
    sh(d, &["add", "x.txt"]);
    let (_, found) = checks::load_repo(&e.vela, &e.space.repos[0]);
    let hook = found.iter().find(|c| c.kind == CheckKind::Hook).unwrap();
    assert!(run(&e, hook).outcome == Outcome::Pass);
    assert_eq!(hook_runs(&log), 1);

    let skip = checks::commit_skip(&e.vela, &e.space);
    let done = commit_with(&e.space, "feat: x", Some(&skip)).unwrap();
    assert_eq!(done.len(), 1);
    assert_eq!(hook_runs(&log), 1, "git did not run the hook again");
    let msg = sh(d, &["log", "-1", "--format=%B"]);
    let tree = sh(d, &["rev-parse", "HEAD^{tree}"]);
    assert!(
        msg.contains(&format!(
            "Vela-Checks: git-hook passed on {}",
            &tree.trim()[..7]
        )),
        "{msg}"
    );
}

#[test]
fn commit_runs_the_hooks_when_the_staged_set_changed_or_the_option_is_off() {
    let e = env(&[]);
    let log = install_hook(&e);
    let d = e.dir();
    write(d, "x.txt", "1\n");
    sh(d, &["add", "x.txt"]);
    let (_, found) = checks::load_repo(&e.vela, &e.space.repos[0]);
    let hook = found.iter().find(|c| c.kind == CheckKind::Hook).unwrap();
    run(&e, hook);
    assert_eq!(hook_runs(&log), 1);

    // Stage something else after the check: the pass no longer covers this tree.
    write(d, "y.txt", "1\n");
    sh(d, &["add", "y.txt"]);
    let skip = checks::commit_skip(&e.vela, &e.space);
    commit_with(&e.space, "feat: x and y", Some(&skip)).unwrap();
    assert_eq!(hook_runs(&log), 2, "git ran the hook");
    assert!(!sh(d, &["log", "-1", "--format=%B"]).contains("Vela-Checks"));

    // Option off: even a fresh pass is not trusted.
    write(d, "z.txt", "1\n");
    sh(d, &["add", "z.txt"]);
    run(&e, hook);
    assert_eq!(hook_runs(&log), 3);
    config::set_local_value(
        &e.vela,
        "api",
        &["checks", "skip_hooks_on_commit_if_passed"],
        toml::Value::Boolean(false),
    )
    .unwrap();
    let skip = checks::commit_skip(&e.vela, &e.space);
    commit_with(&e.space, "feat: z", Some(&skip)).unwrap();
    assert_eq!(hook_runs(&log), 4);
    assert!(!sh(d, &["log", "-1", "--format=%B"]).contains("Vela-Checks"));
}

#[test]
fn a_failed_hook_never_skips_and_the_commit_is_refused() {
    let e = env(&[]);
    let log = install_hook(&e);
    fs::write(e.root.join("hook.fail"), "").unwrap();
    let d = e.dir();
    write(d, "x.txt", "1\n");
    sh(d, &["add", "x.txt"]);
    let (_, found) = checks::load_repo(&e.vela, &e.space.repos[0]);
    let hook = found.iter().find(|c| c.kind == CheckKind::Hook).unwrap();
    assert_eq!(run(&e, hook).outcome, Outcome::Fail);
    let skip = checks::commit_skip(&e.vela, &e.space);
    assert!(commit_with(&e.space, "feat: x", Some(&skip)).is_err());
    assert_eq!(hook_runs(&log), 2);
}

#[test]
fn commit_groups_skip_the_hook_for_a_single_group_covering_the_index() {
    let e = env(&[]);
    let log = install_hook(&e);
    let d = e.dir();
    write(d, "x.txt", "1\n");
    sh(d, &["add", "x.txt"]);
    let (_, found) = checks::load_repo(&e.vela, &e.space.repos[0]);
    let hook = found.iter().find(|c| c.kind == CheckKind::Hook).unwrap();
    run(&e, hook);
    let plan = vela_core::commitplan::plan(&e.space, &[]).unwrap();
    assert_eq!(plan.groups.len(), 1);
    let skip = checks::commit_skip(&e.vela, &e.space);
    commit_groups_with(&e.space, plan.conventional, &plan.groups, Some(&skip)).unwrap();
    assert_eq!(hook_runs(&log), 1);
    assert!(sh(d, &["log", "-1", "--format=%B"]).contains("Vela-Checks: git-hook passed on "));
}

#[test]
fn entries_reflect_config_cache_and_missing_tools() {
    let e = env(&[
        ("Cargo.toml", "[package]\nname=\"x\"\n"),
        (".pre-commit-config.yaml", "repos: []\n"),
    ]);
    let repo_cfg = e.dir().join(".vela/config.toml");
    write(
        e.dir(),
        ".vela/config.toml",
        "[[checks.custom]]\nid = \"echo\"\nname = \"Echo\"\nrun = \"echo hi\"\nkind = \"lint\"\n",
    );
    assert!(repo_cfg.exists());
    let rc = checks::space_checks(&e.vela, &e.space);
    assert_eq!(rc.len(), 1);
    let by = |id: &str| rc[0].checks.iter().find(|c| c.id == id).unwrap().clone();
    assert!(rc[0].auto);
    assert_eq!(by("cargo-test").status, CheckStatus::Disabled);
    assert!(by("cargo-test").optional);
    assert_eq!(by("echo").status, CheckStatus::Idle);

    // Run the custom check: next listing says pass and cached.
    let found = checks::repo_checks(
        e.dir(),
        &config::load_repo_config_in(None, &e.vela, e.dir(), "api")
            .config
            .checks,
    );
    let echo = found.iter().find(|c| c.id == "echo").unwrap();
    run(&e, echo);
    let again = checks::space_checks(&e.vela, &e.space);
    let echo_entry = again[0].checks.iter().find(|c| c.id == "echo").unwrap();
    assert_eq!(echo_entry.status, CheckStatus::Pass);
    assert!(echo_entry.cached);
    assert_eq!(echo_entry.exit_code, Some(0));

    // Turning a detected test on from the local layer.
    config::set_check_enabled(&e.vela, "api", "cargo-test", true).unwrap();
    let rc = checks::space_checks(&e.vela, &e.space);
    let ct = rc[0].checks.iter().find(|c| c.id == "cargo-test").unwrap();
    assert!(ct.enabled);
    assert_ne!(ct.status, CheckStatus::Disabled);
    // And a detected check turned off.
    config::set_check_enabled(&e.vela, "api", "pre-commit", false).unwrap();
    let rc = checks::space_checks(&e.vela, &e.space);
    assert_eq!(
        rc[0]
            .checks
            .iter()
            .find(|c| c.id == "pre-commit")
            .unwrap()
            .status,
        CheckStatus::Disabled
    );
}

#[test]
fn unknown_repo_is_an_error() {
    let e = env(&[]);
    let c = custom("x", CheckKind::Custom, "true");
    assert!(checks::run_check(&e.space, "nope", &c, &RunOptions::default()).is_err());
}
