//! Agents on real git: an agent works in its own worktree and, when its run ends, its work
//! lands in the user's files. There is no review of agent changes: the Review holds what goes
//! in the next commit. When its work conflicts with edits the user made meanwhile, the agent
//! is resumed to resolve the conflict, and after two tries the markers go to the user.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use vela_agents::{AgentEvent, AgentManager, Drivers, Emit};
use vela_app::commands;
use vela_core::Vela;
use vela_core::model::{HunkState, Origin};

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

/// `__BIN__` and `__USER__` are replaced by the test. A `conflict` file in the bin directory
/// makes the user edit line 2 while the agent works; `stubborn` makes the agent leave its
/// conflict markers.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Fake)"; exit 0; fi
input=$(cat)
n=$(ls __BIN__ | grep -c '^call-')
echo "$input" > "__BIN__/call-$n"
case "$*" in
*--resume*)
case "$input" in
*"conflict markers"*)
if [ ! -f __BIN__/stubborn ]; then
sed -i '/^<<<<<<< /d; /^=======$/d; /^>>>>>>> /d; /^MINE 2$/d' a.txt
fi
;;
*)
sed -i 's/^line 3$/LINE THREE/' a.txt
;;
esac
echo '{"type":"result","subtype":"success","is_error":false,"result":"Done again.","session_id":"fs","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[]}'
exit 0
;;
esac
sed -i 's/^line 2$/LINE TWO/; s/^line 30$/LINE THIRTY/' a.txt
sed -i 's/^line 10$/LINE TEN/' b.txt
mkdir -p src && printf 'fn main() {}\n' > src/new.rs
rm gone.txt
if [ -f __BIN__/conflict ]; then sed -i 's/^line 2$/MINE 2/' __USER__/a.txt; fi
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
    bin: PathBuf,
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
    let wt = PathBuf::from(&space.repos[0].worktree);
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let claude = bin.join("claude");
    let script = FAKE_CLAUDE
        .replace("__BIN__", &bin.to_string_lossy())
        .replace("__USER__", &wt.to_string_lossy());
    fs::write(&claude, script).unwrap();
    fs::set_permissions(&claude, fs::Permissions::from_mode(0o755)).unwrap();
    let mgr = AgentManager::with_config_dir(Drivers::with_path(bin.clone()), None);
    let emit: Emit = Arc::new(|_| {});
    Env {
        _tmp: tmp,
        vela,
        wt,
        bin,
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

fn file(e: &Env, path: &str) -> String {
    fs::read_to_string(e.wt.join(path)).unwrap_or_default()
}

fn applied(e: &Env) -> Vec<(Vec<String>, Vec<String>, bool)> {
    commands::agent_log(&e.vela, &e.mgr, "refunds", "developer-1")
        .unwrap()
        .into_iter()
        .filter_map(|l| match l.event {
            AgentEvent::Applied {
                files,
                conflicts,
                to_you,
            } => Some((files, conflicts, to_you)),
            _ => None,
        })
        .collect()
}

fn prompts(e: &Env) -> usize {
    fs::read_dir(&e.bin)
        .unwrap()
        .filter(|f| {
            f.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("call-")
        })
        .count()
}

#[test]
fn a_run_lands_in_your_files_with_nothing_to_review_apart() {
    let e = env();
    fs::write(e.wt.join("mine.txt"), "mine\n").unwrap();
    run_developer(&e);
    let a = file(&e, "a.txt");
    assert!(
        a.contains("LINE TWO\n") && a.contains("LINE THIRTY\n"),
        "{a}"
    );
    assert!(file(&e, "b.txt").contains("LINE TEN\n"));
    assert_eq!(file(&e, "src/new.rs"), "fn main() {}\n");
    assert!(!e.wt.join("gone.txt").exists());
    // The user's own work is untouched.
    assert_eq!(file(&e, "mine.txt"), "mine\n");
    // Everything is an ordinary change of the worktree, nothing staged, nothing proposed.
    let hs = commands::hunks(&e.vela, "refunds").unwrap();
    assert!(
        hs.iter()
            .all(|h| h.origin == Origin::You && h.state == HunkState::Pending)
    );
    assert!(sh(&e.wt, &["diff", "--cached", "--name-only"]).is_empty());
    let mut files = applied(&e)[0].0.clone();
    files.sort();
    assert_eq!(files, ["a.txt", "b.txt", "gone.txt", "src/new.rs"]);
}

#[test]
fn a_follow_up_applies_its_new_change_on_top_of_your_edits() {
    let e = env();
    run_developer(&e);
    // The user edits by hand, then gives the agent more work.
    let a = file(&e, "a.txt").replace("line 20\n", "line 20 by hand\n");
    fs::write(e.wt.join("a.txt"), a).unwrap();
    commands::answer_agent(
        &e.vela,
        &e.mgr,
        "refunds",
        "developer-1",
        "also three",
        &e.emit,
    )
    .unwrap();
    assert!(e.mgr.wait_idle(Duration::from_secs(20)));
    let a = file(&e, "a.txt");
    for l in [
        "LINE TWO\n",
        "LINE THREE\n",
        "line 20 by hand\n",
        "LINE THIRTY\n",
    ] {
        assert!(a.contains(l), "{l} missing in {a}");
    }
    let runs = applied(&e);
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[1].0, ["a.txt"]);
}

#[test]
fn a_conflict_with_your_edits_is_resolved_by_the_agent() {
    let e = env();
    fs::write(e.bin.join("conflict"), "").unwrap();
    run_developer(&e);
    // First run: everything but the conflicting file applied, then the agent was resumed
    // with the markers, resolved them, and its work applied.
    let runs = applied(&e);
    assert_eq!(runs.len(), 2, "{runs:?}");
    assert_eq!(runs[0].1, ["a.txt"]);
    assert!(!runs[0].0.contains(&"a.txt".to_string()));
    assert_eq!(runs[1], (vec!["a.txt".to_string()], vec![], false));
    assert_eq!(prompts(&e), 2);
    let a = file(&e, "a.txt");
    assert!(
        a.contains("LINE TWO\n") && a.contains("LINE THIRTY\n"),
        "{a}"
    );
    assert!(!a.contains("<<<<<<<"), "{a}");
    assert!(file(&e, "b.txt").contains("LINE TEN\n"));
}

#[test]
fn conflicts_the_agent_cannot_resolve_come_to_you_with_their_markers() {
    let e = env();
    fs::write(e.bin.join("conflict"), "").unwrap();
    fs::write(e.bin.join("stubborn"), "").unwrap();
    run_developer(&e);
    // Two tries to resolve, then the file comes to you with the markers.
    let runs = applied(&e);
    assert_eq!(runs.len(), 3, "{runs:?}");
    assert!(!runs[0].2 && !runs[1].2);
    assert_eq!(runs[2].1, ["a.txt"]);
    assert!(runs[2].2);
    assert_eq!(prompts(&e), 3);
    let a = file(&e, "a.txt");
    assert!(
        a.contains("<<<<<<< yours") && a.contains(">>>>>>> agent"),
        "{a}"
    );
}
