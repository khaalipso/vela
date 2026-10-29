//! Agents through the command layer: their work in your files when a run ends, the question
//! as Up next, and the debounced refresh. A fake `claude` on a temporary PATH stands
//! in for the real harness; no model is called.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use vela_agents::{AgentEvent, AgentManager, Drivers, Emit};
use vela_app::agentrun::{self, Refresher};
use vela_app::commands;
use vela_app::watch::{ChangeEvent, ChangeKind};
use vela_core::Vela;
use vela_core::model::{AgentStatus, HunkState, Origin, UpNext};

const NOTES: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen\nfourteen\nfifteen\nsixteen\nseventeen\neighteen\nnineteen\ntwenty\n";

const FAKE_CLAUDE: &str = r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Fake)"; exit 0; fi
cat > /dev/null
case "$*" in
*--resume*)
echo '{"type":"result","subtype":"success","is_error":false,"result":"Kept it.","session_id":"fs","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[]}'
;;
*)
sed -i 's/^ten$/TEN by the agent/' notes.txt
cat <<EOF
{"type":"system","subtype":"init","session_id":"fs","model":"fake"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Raised ten to TEN."},{"type":"tool_use","id":"e","name":"Edit","input":{"file_path":"$PWD/notes.txt"}}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q","name":"AskUserQuestion","input":{"questions":[{"question":"Keep the extension?","options":[{"label":"Keep it"},{"label":"Drop it"}]}]}}]}}
{"type":"result","subtype":"success","is_error":false,"result":"Waiting.","session_id":"fs","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":2},"permission_denials":[]}
EOF
;;
esac
"#;

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

struct Env {
    _tmp: tempfile::TempDir,
    vela: Vela,
    wt: PathBuf,
    mgr: Arc<AgentManager>,
    emit: Emit,
    seen: Arc<Mutex<Vec<AgentEvent>>>,
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
    fs::write(api.join("notes.txt"), NOTES).unwrap();
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
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let emit: Emit = Arc::new(move |n| s.lock().unwrap().push(n.event));
    Env {
        _tmp: tmp,
        vela,
        wt: PathBuf::from(&space.repos[0].worktree),
        mgr,
        emit,
        seen,
    }
}

fn run_developer(e: &Env) {
    let a = commands::ask_agent(
        &e.vela,
        &e.mgr,
        "refunds",
        "developer",
        "raise ten",
        None,
        Some("low"),
        &e.emit,
    )
    .unwrap();
    assert_eq!(a.id, "developer-1");
    assert!(e.mgr.wait_idle(Duration::from_secs(20)));
}

#[test]
fn the_work_of_an_agent_lands_in_your_files_when_its_run_ends() {
    let e = env();
    // The user has uncommitted work of their own; the agent must not undo it.
    fs::write(e.wt.join("mine.txt"), "mine\n").unwrap();
    run_developer(&e);

    // No proposals to review: the agent's edit is in the worktree, as an ordinary change.
    assert!(
        fs::read_to_string(e.wt.join("notes.txt"))
            .unwrap()
            .contains("TEN by the agent")
    );
    let hs = commands::hunks(&e.vela, "refunds").unwrap();
    assert!(!hs.iter().any(|h| matches!(h.origin, Origin::Agent { .. })));
    assert!(
        hs.iter()
            .any(|h| h.path == "notes.txt" && h.state == HunkState::Pending)
    );
    // The user's own file was left alone.
    assert_eq!(fs::read_to_string(e.wt.join("mine.txt")).unwrap(), "mine\n");

    // The question is the space's Up next.
    assert_eq!(
        commands::up_next(&e.vela, "refunds").unwrap(),
        UpNext::AgentQuestion {
            agent: "developer-1".into(),
            text: "Keep the extension?".into()
        }
    );
    let q = commands::question(&e.vela, &e.mgr, "refunds")
        .unwrap()
        .unwrap();
    assert_eq!((q.yes.as_str(), q.no.as_str()), ("Keep it", "Drop it"));
}

#[test]
fn answering_resumes_the_agent_and_clears_the_question() {
    let e = env();
    run_developer(&e);
    let a = commands::answer_agent(
        &e.vela,
        &e.mgr,
        "refunds",
        "developer-1",
        "Keep it",
        &e.emit,
    )
    .unwrap();
    assert_eq!(a.status, AgentStatus::Working);
    assert!(e.mgr.wait_idle(Duration::from_secs(20)));
    let agents = commands::agents(&e.vela, &e.mgr, "refunds").unwrap();
    assert_eq!(agents[0].status, AgentStatus::Done);
    assert!(
        commands::question(&e.vela, &e.mgr, "refunds")
            .unwrap()
            .is_none()
    );
    assert!(!matches!(
        commands::up_next(&e.vela, "refunds").unwrap(),
        UpNext::AgentQuestion { .. }
    ));
    let log = commands::agent_log(&e.vela, &e.mgr, "refunds", "developer-1").unwrap();
    assert!(
        log.iter()
            .any(|l| matches!(&l.event, AgentEvent::Prompt { text } if text == "Keep it"))
    );
    let usage = commands::agent_usage(&e.vela, "refunds").unwrap();
    assert_eq!(usage.input_tokens, 6);
    // Unknown roles and tiers are typed errors.
    let bad = commands::ask_agent(
        &e.vela, &e.mgr, "refunds", "wizard", "x", None, None, &e.emit,
    )
    .unwrap_err();
    assert_eq!(bad.kind, "invalid_input");
    let bad = commands::ask_agent(
        &e.vela,
        &e.mgr,
        "refunds",
        "tester",
        "x",
        None,
        Some("max"),
        &e.emit,
    )
    .unwrap_err();
    assert_eq!(bad.kind, "invalid_input");
    assert_eq!(
        commands::harnesses(&e.mgr)
            .iter()
            .filter(|h| h.available)
            .count(),
        1
    );
}

#[test]
fn a_burst_of_file_changes_gives_one_refresh() {
    let refresher = Arc::new(Refresher::default());
    let got: Arc<Mutex<Vec<ChangeEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let g = got.clone();
    let change: vela_app::watch::Emit = Arc::new(move |c| g.lock().unwrap().push(c));
    let delivered = Arc::new(Mutex::new(0));
    let d = delivered.clone();
    let sink = agentrun::sink(
        Arc::new(move |_| *d.lock().unwrap() += 1),
        change,
        refresher,
        Duration::from_millis(60),
    );
    let note = |event| vela_agents::Notice {
        space_id: "s".into(),
        agent_id: "a".into(),
        event,
    };
    for i in 0..5 {
        sink(note(AgentEvent::FileChanged {
            path: format!("f{i}"),
        }));
    }
    // Messages do not change proposals.
    sink(note(AgentEvent::Message { text: "hi".into() }));
    std::thread::sleep(Duration::from_millis(250));
    let got = got.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].space_id, "s");
    assert_eq!(got[0].kind, ChangeKind::File);
    // Every event reached the UI.
    assert_eq!(*delivered.lock().unwrap(), 6);
}

#[test]
fn recorded_events_reach_the_sink_in_order() {
    let e = env();
    run_developer(&e);
    let kinds: Vec<&str> = e
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|ev| match ev {
            AgentEvent::Prompt { .. } => "prompt",
            AgentEvent::SessionStarted { .. } => "session",
            AgentEvent::Message { .. } => "message",
            AgentEvent::ToolCall { .. } => "tool",
            AgentEvent::FileChanged { .. } => "file",
            AgentEvent::Question { .. } => "question",
            AgentEvent::Usage { .. } => "usage",
            AgentEvent::Applied { .. } => "applied",
            AgentEvent::Done { .. } => "done",
            _ => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "prompt", "session", "message", "tool", "file", "question", "usage", "applied", "done"
        ]
    );
}
