//! Checks: detect hooks, tests, lint and type checks of a repo, run them in the user's
//! worktree, cache the results by staged tree, and let a commit skip hooks that already passed.
//!
//! Configuration (what is off, custom checks, timeouts) comes from [`crate::config`].

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::Vela;
use crate::config::{self, ChecksConfig, LoadedConfig};
use crate::error::{Error, Result};
use crate::git::git;
use crate::model::{CheckEntry, CheckKind, CheckStatus, CheckWhen, RepoChecks, Space, SpaceRepo};

/// Output kept per run; older lines are dropped first.
const MAX_OUTPUT: usize = 512 * 1024;

/// One check of a repo, before it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// Stable within a repo: `pre-commit`, `cargo-test`, a custom `id`.
    pub id: String,
    pub name: String,
    pub kind: CheckKind,
    /// Shell command. `{files}` expands to the staged paths, quoted.
    pub command: String,
    /// Off until the user turns it on (tests).
    pub optional: bool,
    pub enabled: bool,
    /// The tool the command needs is not on PATH.
    pub missing: bool,
    /// File that made us detect it, or `config`.
    pub source: String,
    pub when: CheckWhen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Pass,
    Fail,
    /// Nothing to run (no staged file for a command that takes them).
    Skipped,
}

/// What one run produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub repo: String,
    pub id: String,
    pub outcome: Outcome,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
    /// stdout and stderr, interleaved.
    pub output: String,
    /// Served from the cache, the command did not run.
    pub cached: bool,
    /// `git write-tree` of the index the check ran for.
    pub tree: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct RunOptions {
    pub timeout: Duration,
    /// Ignore the cache and run.
    pub force: bool,
}

impl RunOptions {
    pub fn from_config(c: &ChecksConfig, force: bool) -> Self {
        RunOptions {
            timeout: Duration::from_secs(c.timeout_secs.max(1)),
            force,
        }
    }
}

impl Default for RunOptions {
    fn default() -> Self {
        RunOptions::from_config(&ChecksConfig::default(), false)
    }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Quote one word for `sh`.
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-./=:@%+,".contains(c))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Is `bin` an executable in one of the directories of `path`?
pub fn which_in(bin: &str, path: &OsStr) -> bool {
    use std::os::unix::fs::PermissionsExt;
    if bin.contains('/') {
        return fs::metadata(bin).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
    }
    std::env::split_paths(path).any(|d| {
        fs::metadata(d.join(bin)).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}

fn first_word(command: &str) -> &str {
    command.split_whitespace().next().unwrap_or("")
}

#[allow(clippy::too_many_arguments)]
fn detected(
    id: &str,
    name: &str,
    kind: CheckKind,
    command: &str,
    optional: bool,
    source: &str,
    path: &OsStr,
) -> Check {
    Check {
        id: id.to_string(),
        name: name.to_string(),
        kind,
        command: command.to_string(),
        optional,
        enabled: !optional,
        missing: !which_in(first_word(command), path),
        source: source.to_string(),
        when: CheckWhen::Staged,
    }
}

/// Where git looks for hooks of the repo at `dir`: `core.hooksPath` when set (relative to
/// the worktree), else `<git-common-dir>/hooks`.
pub fn hooks_dir(dir: &Path) -> Option<PathBuf> {
    if let Ok(p) = git(dir, &["config", "--get", "core.hooksPath"]) {
        let p = p.trim();
        if !p.is_empty() {
            let p = match p.strip_prefix("~/") {
                Some(rest) => std::env::var_os("HOME")
                    .map(|h| PathBuf::from(h).join(rest))
                    .unwrap_or_else(|| PathBuf::from(p)),
                None => PathBuf::from(p),
            };
            return Some(if p.is_absolute() { p } else { dir.join(p) });
        }
    }
    let common = git(dir, &["rev-parse", "--git-common-dir"]).ok()?;
    let common = PathBuf::from(common.trim());
    let common = if common.is_absolute() {
        common
    } else {
        dir.join(common)
    };
    Some(common.join("hooks"))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn read(dir: &Path, name: &str) -> Option<String> {
    fs::read_to_string(dir.join(name)).ok()
}

fn package_manager(dir: &Path) -> &'static str {
    let has = |f: &str| dir.join(f).exists();
    if has("pnpm-lock.yaml") {
        "pnpm"
    } else if has("yarn.lock") {
        "yarn"
    } else if has("bun.lockb") || has("bun.lock") {
        "bun"
    } else {
        "npm"
    }
}

/// `npm test` ships with a placeholder script that always fails.
fn placeholder_test(script: &str) -> bool {
    script.contains("no test specified")
}

/// Everything found in the worktree, before any configuration. Hooks and lint are on,
/// tests are optional (off).
pub fn detect(dir: &Path) -> Vec<Check> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    detect_with_path(dir, &path)
}

/// [`detect`] with an explicit PATH to look for tools in.
pub fn detect_with_path(dir: &Path, path: &OsStr) -> Vec<Check> {
    let mut out: Vec<Check> = Vec::new();
    let exists = |f: &str| dir.join(f).exists();

    // Hooks.
    if exists(".pre-commit-config.yaml") {
        out.push(detected(
            "pre-commit",
            "pre-commit",
            CheckKind::Hook,
            "pre-commit run --files {files}",
            false,
            ".pre-commit-config.yaml",
            path,
        ));
    } else if let Some(f) = ["lefthook.yml", "lefthook.yaml", ".lefthook.yml"]
        .into_iter()
        .find(|f| exists(f))
    {
        out.push(detected(
            "lefthook",
            "lefthook",
            CheckKind::Hook,
            "lefthook run pre-commit",
            false,
            f,
            path,
        ));
    } else if exists(".husky/pre-commit") {
        out.push(detected(
            "husky",
            "husky pre-commit",
            CheckKind::Hook,
            "sh .husky/pre-commit",
            false,
            ".husky/pre-commit",
            path,
        ));
    } else if let Some(hook) = hooks_dir(dir)
        .map(|d| d.join("pre-commit"))
        .filter(|p| is_executable(p))
    {
        out.push(detected(
            "git-hook",
            "pre-commit hook",
            CheckKind::Hook,
            &shell_quote(&hook.to_string_lossy()),
            false,
            "git hooks",
            path,
        ));
    }

    // JavaScript.
    if let Some(text) = read(dir, "package.json")
        && let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&text)
    {
        let pm = package_manager(dir);
        let script = |n: &str| pkg["scripts"][n].as_str();
        if let Some(s) = script("test")
            && !placeholder_test(s)
        {
            out.push(detected(
                "test",
                &format!("Tests ({pm})"),
                CheckKind::Test,
                &format!("{pm} test"),
                true,
                "package.json",
                path,
            ));
        }
        for (id, name, kind) in [
            ("lint", "Lint", CheckKind::Lint),
            ("typecheck", "Types", CheckKind::Types),
            ("check", "Check", CheckKind::Types),
        ] {
            if script(id).is_some() {
                out.push(detected(
                    id,
                    name,
                    kind,
                    &format!("{pm} run {id}"),
                    false,
                    "package.json",
                    path,
                ));
            }
        }
    }

    // Rust.
    if exists("Cargo.toml") {
        out.push(detected(
            "clippy",
            "Clippy",
            CheckKind::Lint,
            "cargo clippy -- -D warnings",
            false,
            "Cargo.toml",
            path,
        ));
        out.push(detected(
            "cargo-test",
            "Tests (cargo)",
            CheckKind::Test,
            "cargo test",
            true,
            "Cargo.toml",
            path,
        ));
    }

    // Python.
    let pyproject = read(dir, "pyproject.toml").unwrap_or_default();
    let setup_cfg = read(dir, "setup.cfg").unwrap_or_default();
    if exists("pytest.ini") || pyproject.contains("pytest") || setup_cfg.contains("pytest") {
        out.push(detected(
            "pytest",
            "Tests (pytest)",
            CheckKind::Test,
            "pytest",
            true,
            "pytest",
            path,
        ));
    }
    if exists("ruff.toml") || exists(".ruff.toml") || pyproject.contains("[tool.ruff") {
        out.push(detected(
            "ruff",
            "Ruff",
            CheckKind::Lint,
            "ruff check",
            false,
            "ruff config",
            path,
        ));
    }

    // Go, make.
    if exists("go.mod") {
        out.push(detected(
            "go-test",
            "Tests (go)",
            CheckKind::Test,
            "go test ./...",
            true,
            "go.mod",
            path,
        ));
    }
    if let Some(mk) = read(dir, "Makefile").or_else(|| read(dir, "makefile"))
        && mk.lines().any(|l| l.starts_with("test:"))
    {
        out.push(detected(
            "make-test",
            "Tests (make)",
            CheckKind::Test,
            "make test",
            true,
            "Makefile",
            path,
        ));
    }
    out
}

fn kind_rank(k: CheckKind) -> u8 {
    match k {
        CheckKind::Hook => 0,
        CheckKind::Lint => 1,
        CheckKind::Types => 2,
        CheckKind::Test => 3,
        CheckKind::Custom => 4,
    }
}

/// Detected checks, plus the custom ones of the config, with `enabled` settled.
pub fn repo_checks(dir: &Path, cfg: &ChecksConfig) -> Vec<Check> {
    let mut checks = detect(dir);
    for c in &cfg.custom {
        let check = Check {
            id: c.id.clone(),
            name: c.name.clone().unwrap_or_else(|| c.id.clone()),
            kind: c.kind,
            command: c.run.clone(),
            optional: c.optional,
            enabled: !c.optional,
            missing: false,
            source: "config".to_string(),
            when: c.when,
        };
        match checks.iter().position(|x| x.id == check.id) {
            Some(i) => checks[i] = check,
            None => checks.push(check),
        }
    }
    for c in &mut checks {
        if let Some(on) = cfg.detected.get(&c.id).and_then(|o| o.enabled) {
            c.enabled = on;
        }
    }
    checks.sort_by_key(|c| kind_rank(c.kind));
    checks
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

fn cache() -> &'static Mutex<HashMap<String, CheckResult>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CheckResult>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Forget every cached result.
pub fn clear_cache() {
    if let Ok(mut c) = cache().lock() {
        c.clear();
    }
}

/// `git write-tree` of the index: the identity of the staged set. None when the index
/// cannot be written (unmerged paths).
pub fn index_tree(dir: &Path) -> Option<String> {
    git(dir, &["write-tree"]).ok().map(|s| s.trim().to_string())
}

fn head_sha(dir: &Path) -> Option<String> {
    git(dir, &["rev-parse", "--verify", "-q", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
}

/// Key of a result: repo, check, command, the staged tree, and HEAD for tests (they
/// read more than the staged files).
fn cache_key(dir: &Path, check: &Check, tree: &str) -> String {
    let head = if check.kind == CheckKind::Test {
        head_sha(dir).unwrap_or_default()
    } else {
        String::new()
    };
    let canon = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    format!(
        "{}\0{}\0{}\0{tree}\0{head}",
        canon.display(),
        check.id,
        check.command
    )
}

fn repo_of<'a>(space: &'a Space, repo: &str) -> Result<&'a SpaceRepo> {
    space
        .repos
        .iter()
        .find(|r| r.name == repo)
        .ok_or_else(|| Error::RepoNotFound(repo.to_string()))
}

/// The cached result of `check` for the index as it is now.
pub fn cached_result(space: &Space, repo: &str, check: &Check) -> Result<Option<CheckResult>> {
    let dir = Path::new(&repo_of(space, repo)?.worktree);
    Ok(cached_in(dir, check))
}

fn cached_in(dir: &Path, check: &Check) -> Option<CheckResult> {
    let tree = index_tree(dir)?;
    let key = cache_key(dir, check, &tree);
    cache().lock().ok()?.get(&key).cloned().map(|mut r| {
        r.cached = true;
        r
    })
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

struct Raw {
    code: Option<i32>,
    timed_out: bool,
    output: String,
    elapsed: Duration,
}

fn kill_group(child: &mut Child) {
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{}", child.id())])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

/// Run `command` with `sh -c` in `dir`, stdout and stderr merged, a line at a time to `on_line`.
fn run_shell(
    dir: &Path,
    command: &str,
    timeout: Duration,
    on_line: &mut dyn FnMut(&str),
) -> Result<Raw> {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new("sh");
    cmd.arg("-c")
        .arg(format!("exec 2>&1\n{command}"))
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    let start = Instant::now();
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf)
                        .trim_end_matches(['\n', '\r'])
                        .to_string();
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let deadline = start + timeout;
    let mut output = String::new();
    let push = |line: &str, output: &mut String, on_line: &mut dyn FnMut(&str)| {
        output.push_str(line);
        output.push('\n');
        if output.len() > MAX_OUTPUT {
            let mut cut = output.len() - MAX_OUTPUT / 2;
            while !output.is_char_boundary(cut) {
                cut += 1;
            }
            output.drain(..cut);
        }
        on_line(line);
    };
    let mut timed_out = false;
    let mut status = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(line) => push(&line, &mut output, on_line),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        status = child.try_wait()?;
        if status.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            kill_group(&mut child);
            timed_out = true;
            status = Some(child.wait()?);
            break;
        }
    }
    // EOF with the process still running: wait for it, within the deadline.
    while status.is_none() {
        status = child.try_wait()?;
        if status.is_none() {
            if Instant::now() >= deadline {
                kill_group(&mut child);
                timed_out = true;
                status = Some(child.wait()?);
            } else {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    while let Ok(line) = rx.try_recv() {
        push(&line, &mut output, on_line);
    }
    if timed_out {
        let note = format!("Timed out after {}s", timeout.as_secs());
        push(&note, &mut output, on_line);
    }
    Ok(Raw {
        code: status.and_then(|s| s.code()),
        timed_out,
        output,
        elapsed: start.elapsed(),
    })
}

/// Staged paths that still exist (added, copied, modified, renamed).
pub fn staged_paths(dir: &Path) -> Result<Vec<String>> {
    let out = git(
        dir,
        &[
            "diff",
            "--cached",
            "--name-only",
            "--diff-filter=ACMR",
            "-z",
        ],
    )?;
    Ok(out
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect())
}

/// Run a check in the user's worktree.
pub fn run_check(
    space: &Space,
    repo: &str,
    check: &Check,
    opts: &RunOptions,
) -> Result<CheckResult> {
    run_check_streaming(space, repo, check, opts, &mut |_| {})
}

/// Like [`run_check`], handing every output line to `on_line` as it appears. A cached
/// result replays its output through the callback at once.
pub fn run_check_streaming(
    space: &Space,
    repo: &str,
    check: &Check,
    opts: &RunOptions,
    on_line: &mut dyn FnMut(&str),
) -> Result<CheckResult> {
    let dir = Path::new(&repo_of(space, repo)?.worktree);
    let tree = index_tree(dir);
    let key = tree.as_deref().map(|t| cache_key(dir, check, t));
    if !opts.force
        && let Some(k) = &key
        && let Some(hit) = cache().lock().ok().and_then(|c| c.get(k).cloned())
    {
        for l in hit.output.lines() {
            on_line(l);
        }
        return Ok(CheckResult {
            cached: true,
            ..hit
        });
    }

    let mut command = check.command.clone();
    if command.contains("{files}") {
        let files = staged_paths(dir)?;
        if files.is_empty() {
            let msg = "No staged files to check.";
            on_line(msg);
            return Ok(CheckResult {
                repo: repo.to_string(),
                id: check.id.clone(),
                outcome: Outcome::Skipped,
                exit_code: None,
                timed_out: false,
                duration_ms: 0,
                output: format!("{msg}\n"),
                cached: false,
                tree,
            });
        }
        let quoted: Vec<String> = files.iter().map(|f| shell_quote(f)).collect();
        command = command.replace("{files}", &quoted.join(" "));
    }
    let raw = run_shell(dir, &command, opts.timeout, on_line)?;
    let result = CheckResult {
        repo: repo.to_string(),
        id: check.id.clone(),
        outcome: if raw.code == Some(0) && !raw.timed_out {
            Outcome::Pass
        } else {
            Outcome::Fail
        },
        exit_code: raw.code,
        timed_out: raw.timed_out,
        duration_ms: raw.elapsed.as_millis() as u64,
        output: raw.output,
        cached: false,
        tree,
    };
    // A timeout says nothing about the code: run again next time.
    if !result.timed_out
        && let Some(k) = key
        && let Ok(mut c) = cache().lock()
    {
        c.insert(k, result.clone());
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/// The panel row of a check, with the status its cached result gives (`Running` is the
/// caller's to set).
pub fn entry_for(repo: &str, check: &Check, last: Option<&CheckResult>) -> CheckEntry {
    let status = if !check.enabled {
        CheckStatus::Disabled
    } else if check.missing {
        CheckStatus::Missing
    } else {
        match last.map(|r| r.outcome) {
            Some(Outcome::Pass) => CheckStatus::Pass,
            Some(Outcome::Fail) => CheckStatus::Fail,
            Some(Outcome::Skipped) => CheckStatus::Skipped,
            None => CheckStatus::Idle,
        }
    };
    CheckEntry {
        repo: repo.to_string(),
        id: check.id.clone(),
        name: check.name.clone(),
        kind: check.kind,
        command: check.command.clone(),
        optional: check.optional,
        enabled: check.enabled,
        missing: check.missing,
        source: check.source.clone(),
        when: check.when,
        status,
        duration_ms: last.map(|r| r.duration_ms),
        cached: last.is_some_and(|r| r.cached),
        exit_code: last.and_then(|r| r.exit_code),
        timed_out: last.is_some_and(|r| r.timed_out),
    }
}

/// Config and checks of one repo of the space. The repo's worktree is where
/// `.vela/config.toml` is read from.
pub fn load_repo(vela: &Vela, r: &SpaceRepo) -> (LoadedConfig, Vec<Check>) {
    let cfg = config::load_repo_config(vela, Path::new(&r.worktree), &r.name);
    let checks = repo_checks(Path::new(&r.worktree), &cfg.config.checks);
    (cfg, checks)
}

/// Every repo of the space with its checks and their cached status.
pub fn space_checks(vela: &Vela, space: &Space) -> Vec<RepoChecks> {
    space
        .repos
        .iter()
        .map(|r| {
            let (cfg, checks) = load_repo(vela, r);
            let dir = Path::new(&r.worktree);
            RepoChecks {
                repo: r.name.clone(),
                auto: cfg.config.checks.auto,
                checks: checks
                    .iter()
                    .map(|c| entry_for(&r.name, c, cached_in(dir, c).as_ref()))
                    .collect(),
                warnings: cfg.warnings,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Commit integration
// ---------------------------------------------------------------------------

/// `Vela-Checks: pre-commit passed on <short tree>` when every enabled hook check of the
/// repo passed on the exact index tree about to be committed, else None (git runs its hooks).
pub fn hook_trailer(dir: &Path, checks: &[Check], cfg: &ChecksConfig) -> Option<String> {
    if !cfg.skip_hooks_on_commit_if_passed {
        return None;
    }
    let hooks: Vec<&Check> = checks
        .iter()
        .filter(|c| c.kind == CheckKind::Hook && c.enabled && !c.missing)
        .collect();
    if hooks.is_empty() {
        return None;
    }
    let tree = index_tree(dir)?;
    let cache = cache().lock().ok()?;
    for h in &hooks {
        let hit = cache.get(&cache_key(dir, h, &tree))?;
        if hit.outcome != Outcome::Pass || hit.timed_out {
            return None;
        }
    }
    let names: Vec<&str> = hooks.iter().map(|h| h.id.as_str()).collect();
    Some(format!(
        "Vela-Checks: {} passed on {}",
        names.join(", "),
        &tree[..tree.len().min(7)]
    ))
}

/// What `commit` and `commit_groups` ask before each commit: given the repo name and its
/// worktree, a trailer when the hooks can be skipped.
pub fn commit_skip(vela: &Vela, space: &Space) -> impl Fn(&str, &Path) -> Option<String> {
    let vela = vela.clone();
    let repos = space.repos.clone();
    move |name: &str, dir: &Path| {
        let r = repos.iter().find(|r| r.name == name)?;
        let (cfg, checks) = load_repo(&vela, r);
        hook_trailer(dir, &checks, &cfg.config.checks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        for (p, c) in files {
            let f = t.path().join(p);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, c).unwrap();
        }
        t
    }

    fn ids(c: &[Check]) -> Vec<&str> {
        c.iter().map(|c| c.id.as_str()).collect()
    }

    fn find<'a>(c: &'a [Check], id: &str) -> &'a Check {
        c.iter()
            .find(|c| c.id == id)
            .unwrap_or_else(|| panic!("no {id} in {:?}", ids(c)))
    }

    #[test]
    fn pre_commit_framework() {
        let t = dir_with(&[(".pre-commit-config.yaml", "repos: []\n")]);
        let c = detect_with_path(t.path(), OsStr::new(""));
        let h = find(&c, "pre-commit");
        assert_eq!(h.kind, CheckKind::Hook);
        assert_eq!(h.command, "pre-commit run --files {files}");
        assert!(h.enabled && !h.optional);
        assert!(h.missing, "no PATH, no tool");
    }

    #[test]
    fn missing_follows_the_path() {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir_with(&[("pre-commit", "#!/bin/sh\n")]);
        let f = bin.path().join("pre-commit");
        fs::set_permissions(&f, fs::Permissions::from_mode(0o755)).unwrap();
        let t = dir_with(&[(".pre-commit-config.yaml", "")]);
        let c = detect_with_path(t.path(), bin.path().as_os_str());
        assert!(!find(&c, "pre-commit").missing);
    }

    #[test]
    fn lefthook_and_husky() {
        let t = dir_with(&[("lefthook.yml", "")]);
        let c = detect_with_path(t.path(), OsStr::new(""));
        assert_eq!(find(&c, "lefthook").command, "lefthook run pre-commit");
        let t = dir_with(&[(".husky/pre-commit", "npm test\n")]);
        let c = detect_with_path(t.path(), OsStr::new(""));
        assert_eq!(find(&c, "husky").command, "sh .husky/pre-commit");
    }

    #[test]
    fn javascript_scripts_and_package_manager() {
        let pkg = r#"{"scripts":{"test":"vitest","lint":"eslint .","typecheck":"tsc","check":"svelte-check","build":"x"}}"#;
        for (lock, pm) in [
            ("pnpm-lock.yaml", "pnpm"),
            ("yarn.lock", "yarn"),
            ("bun.lockb", "bun"),
            ("package-lock.json", "npm"),
        ] {
            let t = dir_with(&[("package.json", pkg), (lock, "")]);
            let c = detect_with_path(t.path(), OsStr::new(""));
            assert_eq!(find(&c, "test").command, format!("{pm} test"));
            assert!(find(&c, "test").optional && !find(&c, "test").enabled);
            assert_eq!(find(&c, "lint").command, format!("{pm} run lint"));
            assert_eq!(find(&c, "typecheck").kind, CheckKind::Types);
            assert_eq!(find(&c, "check").command, format!("{pm} run check"));
            assert!(!ids(&c).contains(&"build"));
        }
    }

    #[test]
    fn npm_placeholder_test_script_is_ignored() {
        let t = dir_with(&[(
            "package.json",
            r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#,
        )]);
        assert!(detect_with_path(t.path(), OsStr::new("")).is_empty());
    }

    #[test]
    fn cargo_python_go_make() {
        let t = dir_with(&[
            ("Cargo.toml", "[package]\n"),
            ("pyproject.toml", "[tool.pytest.ini_options]\n[tool.ruff]\n"),
            ("go.mod", "module x\n"),
            ("Makefile", "build:\n\tx\ntest:\n\ty\n"),
        ]);
        let c = detect_with_path(t.path(), OsStr::new(""));
        assert_eq!(find(&c, "cargo-test").command, "cargo test");
        assert!(find(&c, "cargo-test").optional);
        assert_eq!(find(&c, "clippy").command, "cargo clippy -- -D warnings");
        assert!(find(&c, "clippy").enabled);
        assert_eq!(find(&c, "pytest").command, "pytest");
        assert_eq!(find(&c, "ruff").command, "ruff check");
        assert_eq!(find(&c, "go-test").command, "go test ./...");
        assert_eq!(find(&c, "make-test").command, "make test");
        let t = dir_with(&[("pytest.ini", ""), ("ruff.toml", "")]);
        let c = detect_with_path(t.path(), OsStr::new(""));
        assert!(ids(&c).contains(&"pytest") && ids(&c).contains(&"ruff"));
        let t = dir_with(&[("setup.cfg", "[tool:pytest]\n")]);
        assert!(ids(&detect_with_path(t.path(), OsStr::new(""))).contains(&"pytest"));
        let t = dir_with(&[("README.md", "")]);
        assert!(detect_with_path(t.path(), OsStr::new("")).is_empty());
    }

    #[test]
    fn config_overrides_and_custom_checks() {
        let t = dir_with(&[("Cargo.toml", ""), (".pre-commit-config.yaml", "")]);
        let mut cfg = ChecksConfig::default();
        cfg.detected.insert(
            "pre-commit".into(),
            crate::config::CheckOverride {
                enabled: Some(false),
            },
        );
        cfg.detected.insert(
            "cargo-test".into(),
            crate::config::CheckOverride {
                enabled: Some(true),
            },
        );
        cfg.custom.push(crate::config::CustomCheck {
            id: "secrets".into(),
            name: Some("Secret scan".into()),
            run: "echo scanning".into(),
            kind: CheckKind::Custom,
            when: CheckWhen::Manual,
            optional: false,
        });
        let c = repo_checks(t.path(), &cfg);
        assert!(!find(&c, "pre-commit").enabled);
        assert!(find(&c, "cargo-test").enabled);
        assert!(find(&c, "cargo-test").optional);
        let s = find(&c, "secrets");
        assert_eq!(s.name, "Secret scan");
        assert_eq!(s.when, CheckWhen::Manual);
        assert_eq!(s.source, "config");
        // Hooks first, custom last.
        assert_eq!(c.first().unwrap().kind, CheckKind::Hook);
        assert_eq!(c.last().unwrap().id, "secrets");
    }

    #[test]
    fn quoting() {
        assert_eq!(shell_quote("src/a.ts"), "src/a.ts");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }
}
