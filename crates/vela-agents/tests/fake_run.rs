//! Whole runs through a fake `claude` executable on a temporary PATH. No real model is called:
//! the script prints a recorded stream and edits a file in its working directory.

mod common;

use std::fs;
use std::path::Path;
use std::time::Duration;

use common::*;
use vela_agents::registry;
use vela_agents::{AgentEvent, AskRequest, detect};
use vela_core::model::{AgentRole, AgentStatus, Origin, Tier};

/// First call: edit `notes.txt` in the working directory, ask a question, end.
/// Resumed call (`--resume`): say it is done and end.
const FAKE_CLAUDE: &str = r#"
here=$(dirname "$0")
if [ "$1" = "--version" ]; then echo "9.9.9 (Fake Claude)"; exit 0; fi
n=$(cat "$here/count" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "$here/count"
echo "$@" > "$here/call-$n.args"
cat > "$here/call-$n.stdin"
pwd > "$here/call-$n.cwd"
case "$*" in
*--resume*)
cat <<EOF
{"type":"system","subtype":"init","session_id":"fake-sess","model":"fake-model"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Thanks, keeping the extension."}]},"session_id":"fake-sess"}
{"type":"result","subtype":"success","is_error":false,"result":"Kept the extension.","session_id":"fake-sess","total_cost_usd":0.02,"usage":{"input_tokens":30,"output_tokens":10},"permission_denials":[]}
EOF
;;
*)
sed -i 's/^ten$/TEN by the agent/' notes.txt
cat <<EOF
{"type":"system","subtype":"init","session_id":"fake-sess","model":"fake-model"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Editing notes.txt."},{"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"$PWD/notes.txt","old_string":"ten","new_string":"TEN by the agent"}}]},"session_id":"fake-sess"}
{"type":"mystery","x":1}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"q1","name":"AskUserQuestion","input":{"questions":[{"question":"Keep the extension?","options":[{"label":"Keep it"},{"label":"Drop it"}]}]}}]},"session_id":"fake-sess"}
{"type":"result","subtype":"success","is_error":false,"result":"Waiting for your answer.","session_id":"fake-sess","total_cost_usd":0.01,"usage":{"input_tokens":50,"output_tokens":20},"permission_denials":[]}
EOF
;;
esac
"#;

fn ask(role: AgentRole, prompt: &str) -> AskRequest {
    AskRequest {
        role,
        prompt: prompt.into(),
        harness: None,
        tier: None,
    }
}

fn read(p: &Path) -> String {
    fs::read_to_string(p).unwrap_or_default()
}

#[test]
fn a_run_edits_asks_is_answered_and_finishes() {
    let e = env();
    script(&e.bin, "claude", FAKE_CLAUDE);
    let m = manager(&e);
    let (emit, seen) = collector();
    let user_wt = Path::new(&e.space.repos[0].worktree).to_path_buf();

    let started = m
        .ask(
            &e.vela,
            &e.space,
            AskRequest {
                tier: Some(Tier::High),
                ..ask(AgentRole::Developer, "Handle charge.refunded")
            },
            &emit,
        )
        .unwrap();
    assert_eq!(started.id, "developer-1");
    assert_eq!(started.tool, "claude");
    assert_eq!(started.tier, Some(Tier::High));
    assert_eq!(started.status, AgentStatus::Working);
    let wt = Path::new(&started.worktrees[0].1).to_path_buf();
    assert!(wt.ends_with(".agents/developer-1/api"));
    idle(&m);

    // The run left the agent waiting on its question.
    let agents = m.list(&e.vela, "refunds").unwrap();
    assert_eq!(agents.len(), 1);
    let a = &agents[0];
    assert_eq!(a.status, AgentStatus::Waiting);
    assert_eq!(a.session.as_deref(), Some("fake-sess"));
    assert_eq!(a.question.as_deref(), Some("Keep the extension?"));
    assert_eq!(a.options, ["Keep it", "Drop it"]);
    assert_eq!(a.model.as_deref(), Some("fake-model"));
    assert!((a.usage.cost_usd - 0.01).abs() < 1e-9);
    let q = m.question(&e.vela, "refunds").unwrap().unwrap();
    assert_eq!(
        (q.text.as_str(), q.yes.as_str(), q.no.as_str()),
        ("Keep the extension?", "Keep it", "Drop it")
    );

    // The harness ran in the agent worktree with the prompt on stdin and no model flag.
    let args = read(&e.bin.join("call-1.args"));
    assert!(
        args.contains("-p --output-format stream-json --verbose"),
        "{args}"
    );
    assert!(args.contains("--permission-mode acceptEdits"), "{args}");
    assert!(!args.contains("--model"), "{args}");
    assert!(!args.contains("--resume"), "{args}");
    assert!(read(&e.bin.join("call-1.stdin")).contains("Handle charge.refunded"));
    assert_eq!(
        fs::canonicalize(read(&e.bin.join("call-1.cwd")).trim()).unwrap(),
        fs::canonicalize(&wt).unwrap()
    );

    // The edit happened in the agent worktree only, and shows up as a proposal.
    assert!(read(&user_wt.join("notes.txt")).contains("\nten\n"));
    assert!(read(&wt.join("notes.txt")).contains("TEN by the agent"));
    let entries = m.entries(&e.vela, "refunds").unwrap();
    let list =
        vela_agents::proposals::proposals(&e.space, &entries, &Default::default(), false).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(
        list[0].hunk.origin,
        Origin::Agent {
            agent: "developer-1".into()
        }
    );

    // Answer: a resumed run of the same session with the answer as the prompt.
    let r = m
        .answer(&e.vela, &e.space, "developer-1", "Keep it", &emit)
        .unwrap();
    assert_eq!(r.status, AgentStatus::Working);
    assert!(r.question.is_none());
    idle(&m);
    let args = read(&e.bin.join("call-2.args"));
    assert!(args.contains("--resume fake-sess"), "{args}");
    assert_eq!(read(&e.bin.join("call-2.stdin")), "Keep it");

    let a = m.list(&e.vela, "refunds").unwrap().remove(0);
    assert_eq!(a.status, AgentStatus::Done);
    assert_eq!(a.summary, "Kept the extension.");
    assert!(a.finished.is_some());
    assert!(a.question.is_none());
    // Usage accumulates over both runs.
    assert!((a.usage.cost_usd - 0.03).abs() < 1e-9);
    assert_eq!((a.usage.input_tokens, a.usage.output_tokens), (80, 30));
    assert!(m.question(&e.vela, "refunds").unwrap().is_none());

    // Every event was forwarded, in order, and logged.
    let types: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|n| {
            assert_eq!(
                (n.space_id.as_str(), n.agent_id.as_str()),
                ("refunds", "developer-1")
            );
            serde_json::to_value(&n.event).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(
        types,
        [
            "prompt",
            "sessionStarted",
            "message",
            "toolCall",
            "fileChanged",
            "question",
            "usage",
            "done",
            "prompt",
            "sessionStarted",
            "message",
            "usage",
            "done"
        ]
    );
    let log = m.log(&e.vela, "refunds", "developer-1").unwrap();
    assert_eq!(log.len(), types.len());
    assert!(log.iter().any(|l| l.event
        == AgentEvent::FileChanged {
            path: "notes.txt".into()
        }));

    // Cleaning up removes the worktree and branch.
    m.discard(&e.vela, &e.space, "developer-1").unwrap();
    assert!(!wt.exists());
    assert!(m.list(&e.vela, "refunds").unwrap().is_empty());
}

#[test]
fn the_model_comes_from_the_tier_config() {
    let e = env();
    script(&e.bin, "claude", FAKE_CLAUDE);
    let cfg_dir = e.root.join("cfg");
    write(
        &cfg_dir,
        "config.toml",
        "[agents.tiers.claude]\nhigh = \"opus\"\nmedium = \"sonnet\"\n\n[agents.roles]\ndeveloper = { tier = \"high\" }\n",
    );
    let m = vela_agents::AgentManager::with_config_dir(
        vela_agents::Drivers::with_path(e.bin.clone()),
        Some(cfg_dir),
    );
    let (emit, _) = collector();
    m.ask(&e.vela, &e.space, ask(AgentRole::Developer, "x"), &emit)
        .unwrap();
    idle(&m);
    assert!(read(&e.bin.join("call-1.args")).contains("--model opus"));
    let a = m.list(&e.vela, "refunds").unwrap().remove(0);
    assert_eq!(a.tier, Some(Tier::High));
    assert_eq!(a.model.as_deref(), Some("opus"));
    // A bump to a lower tier at ask time picks that tier's model.
    m.ask(
        &e.vela,
        &e.space,
        AskRequest {
            tier: Some(Tier::Medium),
            ..ask(AgentRole::Developer, "y")
        },
        &emit,
    )
    .unwrap();
    idle(&m);
    assert!(read(&e.bin.join("call-2.args")).contains("--model sonnet"));
}

#[test]
fn a_reviewer_runs_read_only_in_the_users_worktree_without_a_worktree() {
    let e = env();
    script(&e.bin, "claude", FAKE_CLAUDE);
    let m = manager(&e);
    let (emit, _) = collector();
    let a = m
        .ask(
            &e.vela,
            &e.space,
            ask(AgentRole::Reviewer, "Review my change"),
            &emit,
        )
        .unwrap();
    assert!(a.worktrees.is_empty());
    idle(&m);
    let args = read(&e.bin.join("call-1.args"));
    assert!(args.contains("--permission-mode dontAsk"), "{args}");
    assert_eq!(
        fs::canonicalize(read(&e.bin.join("call-1.cwd")).trim()).unwrap(),
        fs::canonicalize(&e.space.repos[0].worktree).unwrap()
    );
    assert!(!e.root.join("home/worktrees/refunds/.agents").exists());
}

#[test]
fn a_permission_denial_waits_and_a_yes_grants_the_tool() {
    let e = env();
    script(
        &e.bin,
        "claude",
        r#"
here=$(dirname "$0")
if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi
n=$(cat "$here/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$here/count"
echo "$@" > "$here/call-$n.args"; cat > "$here/call-$n.stdin"
case "$*" in
*--resume*) echo '{"type":"result","subtype":"success","is_error":false,"result":"ran it","session_id":"s9","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[]}' ;;
*) echo '{"type":"system","subtype":"init","session_id":"s9"}'
   echo '{"type":"result","subtype":"success","is_error":false,"result":"blocked","session_id":"s9","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[{"tool_name":"Bash","tool_use_id":"b","tool_input":{"command":"cargo test"}}]}' ;;
esac
"#,
    );
    let m = manager(&e);
    let (emit, _) = collector();
    m.ask(
        &e.vela,
        &e.space,
        ask(AgentRole::Tester, "run the tests"),
        &emit,
    )
    .unwrap();
    idle(&m);
    let q = m.question(&e.vela, "refunds").unwrap().expect("a question");
    assert!(q.text.contains("cargo test"));
    assert_eq!((q.yes.as_str(), q.no.as_str()), ("Allow", "Deny"));
    m.answer(&e.vela, &e.space, "tester-1", "Allow", &emit)
        .unwrap();
    idle(&m);
    let args = read(&e.bin.join("call-2.args"));
    assert!(args.contains("--allowed-tools Bash"), "{args}");
    assert!(read(&e.bin.join("call-2.stdin")).contains("Permission granted"));
    assert_eq!(
        m.list(&e.vela, "refunds").unwrap()[0].status,
        AgentStatus::Done
    );
}

#[test]
fn cancel_kills_the_process_and_fails_the_run() {
    let e = env();
    script(
        &e.bin,
        "claude",
        r#"
if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"slow"}'
sleep 60 &
wait
"#,
    );
    let m = manager(&e);
    let (emit, seen) = collector();
    m.ask(&e.vela, &e.space, ask(AgentRole::Developer, "slow"), &emit)
        .unwrap();
    // Wait for the session to show the process is up.
    for _ in 0..200 {
        if seen
            .lock()
            .unwrap()
            .iter()
            .any(|n| matches!(n.event, AgentEvent::SessionStarted { .. }))
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(m.cancel("refunds", "developer-1"));
    idle(&m);
    let a = m.list(&e.vela, "refunds").unwrap().remove(0);
    assert_eq!(a.status, AgentStatus::Failed);
    assert_eq!(a.summary, "Cancelled");
    assert!(!m.cancel("refunds", "developer-1"));
}

#[test]
fn a_crashing_harness_fails_with_its_stderr() {
    let e = env();
    script(
        &e.bin,
        "claude",
        "if [ \"$1\" = \"--version\" ]; then echo 1; exit 0; fi\necho 'login required' >&2\nexit 3\n",
    );
    let m = manager(&e);
    let (emit, _) = collector();
    m.ask(&e.vela, &e.space, ask(AgentRole::Developer, "x"), &emit)
        .unwrap();
    idle(&m);
    let a = m.list(&e.vela, "refunds").unwrap().remove(0);
    assert_eq!(a.status, AgentStatus::Failed);
    assert_eq!(a.summary, "login required");
}

#[test]
fn asking_without_the_harness_installed_is_an_error_and_leaves_nothing() {
    let e = env();
    let m = manager(&e); // empty bin
    let (emit, _) = collector();
    let err = m
        .ask(&e.vela, &e.space, ask(AgentRole::Developer, "x"), &emit)
        .unwrap_err();
    assert!(err.to_string().contains("not installed"), "{err}");
    assert!(registry::load(&e.vela, "refunds").unwrap().is_empty());
    assert!(
        m.ask(&e.vela, &e.space, ask(AgentRole::Developer, "  "), &emit)
            .is_err()
    );
}

#[test]
fn detect_reports_installed_harnesses_with_versions() {
    let e = env();
    script(&e.bin, "claude", FAKE_CLAUDE);
    script(&e.bin, "codex", "echo 'codex-cli 0.0.1'\n");
    let found = detect(Some(e.bin.as_os_str()));
    assert_eq!(found.len(), 3);
    let by = |n: &str| found.iter().find(|h| h.name == n).unwrap();
    assert!(by("claude").available);
    assert_eq!(by("claude").version.as_deref(), Some("9.9.9 (Fake Claude)"));
    assert_eq!(by("codex").version.as_deref(), Some("codex-cli 0.0.1"));
    assert!(!by("opencode").available);
    assert_eq!(by("opencode").path, None);
}

fn fixture(rel: &str) -> String {
    format!("{}/tests/fixtures/{rel}", env!("CARGO_MANIFEST_DIR"))
}

fn recording(fixture_file: &str) -> String {
    format!(
        "here=$(dirname \"$0\")\nif [ \"$1\" = \"--version\" ]; then echo 1.2.3; exit 0; fi\n\
         echo \"$@\" > \"$here/args\"\ncat > \"$here/stdin\"\ncat '{fixture_file}'\n"
    )
}

#[test]
fn codex_runs_through_its_driver() {
    let e = env();
    script(&e.bin, "codex", &recording(&fixture("codex/run.jsonl")));
    let m = manager(&e);
    let (emit, _) = collector();
    m.ask(
        &e.vela,
        &e.space,
        AskRequest {
            harness: Some("codex".into()),
            ..ask(AgentRole::Developer, "refunds")
        },
        &emit,
    )
    .unwrap();
    idle(&m);
    let a = m.list(&e.vela, "refunds").unwrap().remove(0);
    assert_eq!(a.tool, "codex");
    assert_eq!(a.status, AgentStatus::Done);
    assert_eq!(
        a.session.as_deref(),
        Some("0199a213-81c0-7800-8aa1-bbab2a035a53")
    );
    assert_eq!(a.plan.len(), 2);
    assert_eq!(a.summary, "Handled charge.refunded in the webhook.");
    assert_eq!(a.usage.output_tokens, 122);
    let args = read(&e.bin.join("args"));
    assert!(
        args.starts_with("exec --json --skip-git-repo-check -C "),
        "{args}"
    );
    assert!(args.contains("-s workspace-write"), "{args}");
    assert!(args.trim_end().ends_with(" -"), "{args}");
    assert!(read(&e.bin.join("stdin")).contains("## Request\nrefunds"));
}

#[test]
fn opencode_runs_through_its_driver() {
    let e = env();
    script(
        &e.bin,
        "opencode",
        &recording(&fixture("opencode/run.jsonl")),
    );
    let m = manager_cfg(&e, "[agents.transport]\nopencode = \"cli\"\n");
    let (emit, _) = collector();
    m.ask(
        &e.vela,
        &e.space,
        AskRequest {
            harness: Some("opencode".into()),
            ..ask(AgentRole::Planner, "plan refunds")
        },
        &emit,
    )
    .unwrap();
    idle(&m);
    let a = m.list(&e.vela, "refunds").unwrap().remove(0);
    assert_eq!(a.tool, "opencode");
    // The stream has no terminal event: a clean exit makes it Done with the last message.
    assert_eq!(a.status, AgentStatus::Done);
    assert_eq!(a.summary, "Handled the refund event.");
    assert_eq!(a.session.as_deref(), Some("ses_abc123"));
    let args = read(&e.bin.join("args"));
    assert!(args.starts_with("run --format json "), "{args}");
    assert!(args.contains("--agent plan"), "{args}");
    assert!(args.contains("## Request\nplan refunds"), "{args}");
}

/// A manager whose global config layer holds `toml`.
fn manager_cfg(e: &Env, toml: &str) -> std::sync::Arc<vela_agents::AgentManager> {
    let dir = e.root.join("cfg");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("config.toml"), toml).unwrap();
    vela_agents::AgentManager::with_config_dir(
        vela_agents::Drivers::with_path(e.bin.clone()),
        Some(dir),
    )
}

/// A fake `opencode acp`: answers initialize and session/new, then on the prompt edits
/// notes.txt, asks a permission, waits for the answer (recorded in `answer`), ends the turn.
const FAKE_ACP: &str = r#"here=$(dirname "$0")
if [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi
echo "$@" > "$here/args"
while IFS= read -r line; do
  echo "$line" >> "$here/requests"
  case "$line" in
    *'"method":"initialize"'*)
      echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}' ;;
    *'"method":"session/new"'*)
      echo '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"ses_acp1","configOptions":[{"id":"mode","category":"mode","currentValue":"build","options":[{"value":"build"},{"value":"plan"}]},{"id":"effort","category":"thought_level","currentValue":"none","options":[{"value":"none"},{"value":"high"}]}]}}' ;;
    *'"method":"session/set_config_option"'*)
      id=$(echo "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
      echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{}}" ;;
    *'"method":"session/prompt"'*)
      printf 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen\nfourteen\nfifteen\nsixteen\nseventeen\neighteen\nnineteen\ntwenty\n' > notes.txt
      echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_acp1","update":{"sessionUpdate":"plan","entries":[{"content":"Edit notes","status":"pending"}]}}}'
      echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_acp1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"write","kind":"edit","status":"pending","rawInput":{}}}}'
      echo "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"ses_acp1\",\"update\":{\"sessionUpdate\":\"tool_call_update\",\"toolCallId\":\"t1\",\"status\":\"completed\",\"rawInput\":{\"filePath\":\"$PWD/notes.txt\"}}}}"
      echo '{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"ses_acp1","toolCall":{"toolCallId":"t2","title":"rm -rf build"},"options":[{"optionId":"ok","name":"Allow once","kind":"allow_once"},{"optionId":"no","name":"Reject","kind":"reject_once"}]}}' ;;
    *'"id":7'*'"result"'*)
      echo "$line" > "$here/answer"
      echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_acp1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Changed line "}}}}'
      echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_acp1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"two."}}}}'
      echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_acp1","update":{"sessionUpdate":"usage_update","used":10,"size":100,"cost":{"amount":0.25,"currency":"USD"}}}}'
      echo '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":{"inputTokens":100,"outputTokens":20,"cachedReadTokens":5}}}' ;;
  esac
done
"#;

#[test]
fn acp_runs_and_takes_an_answer_in_the_live_run() {
    let e = env();
    script(&e.bin, "opencode", FAKE_ACP);
    let m = manager_cfg(&e, "[agents.effort.opencode]\nmedium = \"high\"\n");
    let (emit, seen) = collector();
    m.ask(
        &e.vela,
        &e.space,
        AskRequest {
            harness: Some("opencode".into()),
            ..ask(AgentRole::Developer, "change two")
        },
        &emit,
    )
    .unwrap();
    // Wait for the permission question; the process stays alive meanwhile.
    let end = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let a = m.list(&e.vela, "refunds").unwrap().remove(0);
        if a.status == AgentStatus::Waiting {
            assert_eq!(a.question.as_deref(), Some("Allow rm -rf build?"));
            assert_eq!(a.options, vec!["Allow once", "Reject"]);
            assert!(m.is_live("refunds", &a.id));
            break;
        }
        assert!(std::time::Instant::now() < end, "no question");
        std::thread::sleep(Duration::from_millis(20));
    }
    let id = m.list(&e.vela, "refunds").unwrap().remove(0).id;
    m.answer(&e.vela, &e.space, &id, "yes", &emit).unwrap();
    idle(&m);
    let a = m.list(&e.vela, "refunds").unwrap().remove(0);
    assert_eq!(a.status, AgentStatus::Done, "{a:?}");
    assert_eq!(a.summary, "Changed line two.");
    assert_eq!(a.session.as_deref(), Some("ses_acp1"));
    assert_eq!(a.plan, vec!["Edit notes"]);
    assert_eq!(a.usage.input_tokens, 105);
    assert!((a.usage.cost_usd - 0.25).abs() < 1e-9);
    assert_eq!(read(&e.bin.join("args")).trim(), "acp");
    assert!(read(&e.bin.join("answer")).contains(r#""optionId":"ok""#));
    let reqs = read(&e.bin.join("requests"));
    // Developer runs at medium: its effort is set; the mode is already build.
    assert!(
        reqs.contains(r#""configId":"effort","sessionId":"ses_acp1","value":"high""#),
        "{reqs}"
    );
    assert!(!reqs.contains(r#""configId":"mode""#), "{reqs}");
    let events: Vec<AgentEvent> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|n| n.event.clone())
        .collect();
    assert!(
        events.contains(&AgentEvent::FileChanged {
            path: "notes.txt".into()
        }),
        "{events:?}"
    );
    // The edit shows as a proposal.
    let entries = registry::load(&e.vela, "refunds").unwrap();
    let props =
        vela_agents::proposals::proposals(&e.space, &entries, &Default::default(), false).unwrap();
    assert_eq!(props.len(), 1);
}

#[test]
fn acp_read_only_roles_switch_to_plan_mode() {
    let e = env();
    script(&e.bin, "opencode", FAKE_ACP);
    let m = manager_cfg(&e, "");
    let (emit, _) = collector();
    m.ask(
        &e.vela,
        &e.space,
        AskRequest {
            harness: Some("opencode".into()),
            ..ask(AgentRole::Security, "audit")
        },
        &emit,
    )
    .unwrap();
    let end = std::time::Instant::now() + Duration::from_secs(10);
    while !read(&e.bin.join("requests")).contains("session/prompt") {
        assert!(std::time::Instant::now() < end);
        std::thread::sleep(Duration::from_millis(20));
    }
    let id = m.list(&e.vela, "refunds").unwrap().remove(0).id;
    m.cancel("refunds", &id);
    idle(&m);
    let reqs = read(&e.bin.join("requests"));
    assert!(
        reqs.contains(r#""configId":"mode","sessionId":"ses_acp1","value":"plan""#),
        "{reqs}"
    );
    assert!(
        reqs.contains("NOTE <blocking|warning|info>"),
        "the security brief asks for notes"
    );
}
