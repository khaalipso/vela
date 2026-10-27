//! The review flow on real git: an agent changes several files, the user accepts, and the
//! space must end clean (everything staged, nothing proposed again), also after a commit and
//! after the user edits the same lines by hand.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use vela_agents::{AgentManager, Drivers, Emit};
use vela_app::commands;
use vela_core::Vela;
use vela_core::model::{HunkState, Origin};

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

const FAKE_CLAUDE: &str = r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Fake)"; exit 0; fi
cat > /dev/null
case "$*" in
*--resume*)
sed -i 's/^line 3$/LINE THREE/' a.txt
echo '{"type":"result","subtype":"success","is_error":false,"result":"Also three.","session_id":"fs","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[]}'
exit 0
;;
esac
sed -i 's/^line 2$/LINE TWO/; s/^line 4$/LINE FOUR/; s/^line 30$/LINE THIRTY/' a.txt
sed -i 's/^line 10$/LINE TEN/' b.txt
mkdir -p src && printf 'fn main() {}\n' > src/new.rs
rm gone.txt
echo '{"type":"system","subtype":"init","session_id":"fs","model":"fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"fs","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[]}'
"#;

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

struct Env {
    _tmp: tempfile::TempDir,
    vela: Vela,
    wt: PathBuf,
    mgr: Arc<AgentManager>,
    emit: Emit,
}

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let vela = Vela::new(root.join("home"));
    let api = root.join("api");
    fs::create_dir_all(&api).unwrap();
    sh(&api, &["init", "-q", "-b", "main"]);
    sh(&api, &["config", "user.name", "T"]);
    sh(&api, &["config", "user.email", "t@e.c"]);
    sh(&api, &["config", "commit.gpgsign", "false"]);
    fs::write(api.join("a.txt"), numbered(40)).unwrap();
    fs::write(api.join("b.txt"), numbered(20)).unwrap();
    fs::write(api.join("gone.txt"), "bye\n").unwrap();
    sh(&api, &["add", "-A"]);
    sh(&api, &["commit", "-q", "-m", "init"]);
    let space = commands::create_space(
        &vela,
        "Refunds",
        &[api.to_string_lossy().into_owned()],
        None,
        None,
    )
    .unwrap();
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let claude = bin.join("claude");
    fs::write(&claude, FAKE_CLAUDE).unwrap();
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o755)).unwrap();
    let mgr = AgentManager::with_config_dir(Drivers::with_path(bin), None);
    let emit: Emit = Arc::new(|_| {});
    let wt = PathBuf::from(&space.repos[0].worktree);
    sh(&wt, &["config", "user.name", "T"]);
    sh(&wt, &["config", "user.email", "t@e.c"]);
    sh(&wt, &["config", "commit.gpgsign", "false"]);
    Env {
        _tmp: tmp,
        vela,
        wt,
        mgr,
        emit,
    }
}

fn run_developer(e: &Env) {
    commands::ask_agent(
        &e.vela,
        &e.mgr,
        "refunds",
        "developer",
        "do it",
        None,
        Some("low"),
        &e.emit,
    )
    .unwrap();
    assert!(e.mgr.wait_idle(Duration::from_secs(20)));
}

fn proposals(e: &Env) -> Vec<String> {
    commands::hunks(&e.vela, "refunds")
        .unwrap()
        .into_iter()
        .filter(|h| matches!(h.origin, Origin::Agent { .. }) && h.state == HunkState::Pending)
        .map(|h| format!("{}:{}", h.path, h.new_start))
        .collect()
}

fn pending_mine(e: &Env) -> Vec<String> {
    commands::hunks(&e.vela, "refunds")
        .unwrap()
        .into_iter()
        .filter(|h| h.origin == Origin::You && h.state == HunkState::Pending)
        .map(|h| format!("{}:{}", h.path, h.new_start))
        .collect()
}

fn agent_ids(e: &Env) -> Vec<String> {
    commands::hunks(&e.vela, "refunds")
        .unwrap()
        .into_iter()
        .filter(|h| matches!(h.origin, Origin::Agent { .. }) && h.state == HunkState::Pending)
        .map(|h| h.id)
        .collect()
}

#[test]
fn accept_all_leaves_everything_staged_and_nothing_proposed() {
    let e = env();
    run_developer(&e);
    let before = proposals(&e);
    assert!(before.len() >= 5, "{before:?}");
    let failed = commands::accept_hunks(&e.vela, "refunds", &agent_ids(&e)).unwrap();
    assert!(failed.is_empty(), "{failed:?}");
    assert_eq!(proposals(&e), Vec::<String>::new());
    assert_eq!(pending_mine(&e), Vec::<String>::new());
    let st = commands::status(&e.vela, "refunds").unwrap();
    assert!(
        st.iter()
            .all(|c| c.staged.is_some() && c.unstaged.is_none()),
        "{st:?}"
    );
}

#[test]
fn accepting_one_by_one_ends_the_same() {
    let e = env();
    run_developer(&e);
    while let Some(id) = agent_ids(&e).first().cloned() {
        commands::stage_hunk(&e.vela, "refunds", &id).unwrap();
    }
    assert_eq!(pending_mine(&e), Vec::<String>::new());
    let st = commands::status(&e.vela, "refunds").unwrap();
    assert!(
        st.iter()
            .all(|c| c.staged.is_some() && c.unstaged.is_none()),
        "{st:?}"
    );
}

#[test]
fn accepted_work_does_not_come_back_after_a_commit_or_an_edit() {
    let e = env();
    run_developer(&e);
    commands::accept_hunks(&e.vela, "refunds", &agent_ids(&e)).unwrap();
    sh(&e.wt, &["commit", "-q", "-m", "take it"]);
    assert_eq!(proposals(&e), Vec::<String>::new());
    // The user reworks a line the agent wrote: the agent's version must not be offered again.
    let a = fs::read_to_string(e.wt.join("a.txt"))
        .unwrap()
        .replace("LINE TWO", "line two, by me");
    fs::write(e.wt.join("a.txt"), a).unwrap();
    assert_eq!(proposals(&e), Vec::<String>::new());
}

#[test]
fn rejected_work_does_not_come_back() {
    let e = env();
    run_developer(&e);
    for id in agent_ids(&e) {
        commands::reject_hunk(&e.vela, "refunds", &id).unwrap();
    }
    assert_eq!(proposals(&e), Vec::<String>::new());
}

#[test]
fn a_follow_up_next_to_accepted_lines_offers_only_the_new_change() {
    let e = env();
    run_developer(&e);
    commands::accept_hunks(&e.vela, "refunds", &agent_ids(&e)).unwrap();
    assert_eq!(proposals(&e), Vec::<String>::new());
    commands::answer_agent(
        &e.vela,
        &e.mgr,
        "refunds",
        "developer-1",
        "line 3 too",
        &e.emit,
    )
    .unwrap();
    assert!(e.mgr.wait_idle(Duration::from_secs(20)));
    let hs: Vec<_> = commands::hunks(&e.vela, "refunds")
        .unwrap()
        .into_iter()
        .filter(|h| matches!(h.origin, Origin::Agent { .. }) && h.state == HunkState::Pending)
        .collect();
    assert_eq!(hs.len(), 1, "{hs:?}");
    let changed: Vec<_> = hs[0]
        .lines
        .iter()
        .filter(|l| l.kind != vela_core::model::LineKind::Context)
        .map(|l| l.text.as_str())
        .collect();
    assert_eq!(changed, ["line 3", "LINE THREE"]);
    commands::accept_hunks(&e.vela, "refunds", &agent_ids(&e)).unwrap();
    assert_eq!(proposals(&e), Vec::<String>::new());
    assert_eq!(pending_mine(&e), Vec::<String>::new());
}
