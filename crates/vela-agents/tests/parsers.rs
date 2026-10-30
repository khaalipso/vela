//! Parsers on recorded streams, the command lines the drivers build, and tier resolution.

use std::path::Path;

use vela_agents::claude::{self, ClaudeParser};
use vela_agents::codex::{self, CodexParser};
use vela_agents::opencode::{self, OpencodeParser};
use vela_agents::{AgentEvent, Overrides, RunSpec, parse_stream, resolve, resolve_pair};
use vela_core::config::{AgentsConfig, RoleConfig, TierModels};
use vela_core::model::{AgentRole, Tier};

const CLAUDE_DEV: &str = include_str!("fixtures/claude/dev_run.jsonl");
const CLAUDE_Q: &str = include_str!("fixtures/claude/question.jsonl");
const CLAUDE_DENIAL: &str = include_str!("fixtures/claude/denial.jsonl");
const CLAUDE_ERR: &str = include_str!("fixtures/claude/error.jsonl");
const CODEX_RUN: &str = include_str!("fixtures/codex/run.jsonl");
const CODEX_FAILED: &str = include_str!("fixtures/codex/failed.jsonl");
const OC_RUN: &str = include_str!("fixtures/opencode/run.jsonl");
const OC_ERR: &str = include_str!("fixtures/opencode/error.jsonl");
const OC_PLAIN: &str = include_str!("fixtures/opencode/plain.txt");

fn msg(t: &str) -> AgentEvent {
    AgentEvent::Message { text: t.into() }
}

fn spec(harness: &str) -> RunSpec {
    RunSpec {
        harness: harness.into(),
        model: None,
        effort: None,
        tier: None,
        role: AgentRole::Developer,
        prompt: "do it".into(),
        cwd: "/w/api".into(),
        session: None,
        read_only: false,
        extra_args: Vec::new(),
    }
}

// -- Claude -------------------------------------------------------------------

#[test]
fn claude_dev_run() {
    let mut p = ClaudeParser::new(Path::new("/w/api"), None);
    let mut ev = parse_stream(&mut p, CLAUDE_DEV);
    assert_eq!(
        ev[0],
        AgentEvent::SessionStarted {
            session: "sess-123".into()
        }
    );
    assert_eq!(
        ev[1],
        msg("I will handle charge.refunded in the webhook.\nFirst the plan.")
    );
    assert_eq!(
        ev[2],
        AgentEvent::Plan {
            steps: vec!["Read the webhook".into(), "Add the refund branch".into()]
        }
    );
    // The thinking block is reasoning; the malformed line and the unknown event give nothing.
    assert_eq!(ev.remove(3), AgentEvent::Reasoning { text: "hmm".into() });
    assert_eq!(
        ev[3],
        AgentEvent::ToolCall {
            name: "Read".into(),
            summary: "src/webhook.ts".into()
        }
    );
    assert_eq!(
        ev[4],
        AgentEvent::ToolCall {
            name: "Edit".into(),
            summary: "src/webhook.ts".into()
        }
    );
    assert_eq!(
        ev[5],
        AgentEvent::FileChanged {
            path: "src/webhook.ts".into()
        }
    );
    assert_eq!(
        ev[6],
        AgentEvent::ToolCall {
            name: "Bash".into(),
            summary: "pnpm test".into()
        }
    );
    assert_eq!(ev[7], msg("Added the refund branch to the webhook."));
    // Usage counts fresh and cache-written tokens as input, not cache reads.
    assert_eq!(
        ev[8],
        AgentEvent::Usage {
            input_tokens: 1500,
            output_tokens: 340,
            cost_usd: Some(0.0421),
            model: "claude-sonnet-4-5".into()
        }
    );
    assert_eq!(
        ev[9],
        AgentEvent::Done {
            summary: "Added the refund branch to the webhook.".into()
        }
    );
    assert_eq!(ev.len(), 10);
}

#[test]
fn claude_explicit_question_becomes_a_question() {
    let mut p = ClaudeParser::new(Path::new("/w/api"), None);
    let ev = parse_stream(&mut p, CLAUDE_Q);
    let q: Vec<_> = ev
        .iter()
        .filter(|e| matches!(e, AgentEvent::Question { .. }))
        .collect();
    // The AskUserQuestion denial of the result is not a second question.
    assert_eq!(q.len(), 1);
    assert_eq!(
        q[0],
        &AgentEvent::Question {
            text: "Keep pg_trgm or drop it?".into(),
            options: vec!["Keep it".into(), "Drop it".into()],
            tools: vec![]
        }
    );
    assert!(matches!(ev.last(), Some(AgentEvent::Done { .. })));
}

#[test]
fn claude_permission_denials_become_one_question() {
    let mut p = ClaudeParser::new(Path::new("/w/api"), None);
    let ev = parse_stream(&mut p, CLAUDE_DENIAL);
    let q = ev
        .iter()
        .find_map(|e| match e {
            AgentEvent::Question {
                text,
                options,
                tools,
            } => Some((text, options, tools)),
            _ => None,
        })
        .expect("a question");
    assert!(q.0.contains("Bash: rm -rf build"), "{}", q.0);
    assert_eq!(q.1, &vec!["Allow".to_string(), "Deny".to_string()]);
    assert_eq!(q.2, &vec!["Bash".to_string()]);
    // The question comes before the end of the run.
    assert!(ev.last().unwrap().is_terminal());
}

#[test]
fn claude_error_result_fails() {
    let mut p = ClaudeParser::new(Path::new("/w/api"), Some("opus"));
    let ev = parse_stream(&mut p, CLAUDE_ERR);
    assert_eq!(
        ev.last(),
        Some(&AgentEvent::Failed {
            error: "error_max_turns".into()
        })
    );
    assert!(ev.iter().any(|e| matches!(
        e,
        AgentEvent::Usage { cost_usd: Some(c), .. } if (*c - 0.5).abs() < 1e-9
    )));
}

#[test]
fn claude_args() {
    let mut s = spec("claude");
    let a = claude::args(&s);
    assert_eq!(
        a,
        [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "acceptEdits",
            "--allowed-tools",
            "Read,Grep,Glob,LS,Edit,Write,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch,TodoWrite,Task"
        ]
    );
    s.model = Some("opus".into());
    s.read_only = true;
    s.session = Some("sess-1".into());
    s.extra_args = vec!["--allowed-tools".into(), "Bash".into()];
    let a = claude::args(&s);
    assert!(a.windows(2).any(|w| w == ["--model", "opus"]));
    assert!(a.windows(2).any(|w| w == ["--permission-mode", "dontAsk"]));
    let allowed = a.iter().position(|x| x == "--allowed-tools").unwrap();
    assert!(a[allowed + 1].contains("Read") && a[allowed + 1].contains("Bash(git diff:*)"));
    assert!(!a[allowed + 1].contains("Edit"));
    assert!(
        a.windows(2)
            .any(|w| w[0] == "--disallowed-tools" && w[1].contains("Write"))
    );
    assert!(a.windows(2).any(|w| w == ["--resume", "sess-1"]));
    assert!(a.windows(2).any(|w| w == ["--allowed-tools", "Bash"]));
}

// -- Codex --------------------------------------------------------------------

#[test]
fn codex_run() {
    let mut p = CodexParser::new(Path::new("/w/api"), Some("gpt-5"));
    let ev = parse_stream(&mut p, CODEX_RUN);
    assert_eq!(
        ev[0],
        AgentEvent::SessionStarted {
            session: "0199a213-81c0-7800-8aa1-bbab2a035a53".into()
        }
    );
    // The plan is announced once: ticking a step off does not change its text.
    let plans: Vec<_> = ev
        .iter()
        .filter(|e| matches!(e, AgentEvent::Plan { .. }))
        .collect();
    assert_eq!(plans.len(), 1);
    // A command is one tool call even though started and completed both arrive.
    let shells: Vec<_> = ev
        .iter()
        .filter(|e| matches!(e, AgentEvent::ToolCall { name, .. } if name == "shell"))
        .collect();
    assert_eq!(shells.len(), 1);
    let files: Vec<_> = ev
        .iter()
        .filter_map(|e| match e {
            AgentEvent::FileChanged { path } => Some(path.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(files, ["src/webhook.ts", "src/new.ts"]);
    assert!(ev.contains(&msg("Handled charge.refunded in the webhook.")));
    assert!(ev.contains(&AgentEvent::Usage {
        input_tokens: 24763,
        output_tokens: 122,
        cost_usd: None,
        model: "gpt-5".into()
    }));
    assert_eq!(
        ev.last(),
        Some(&AgentEvent::Done {
            summary: "Handled charge.refunded in the webhook.".into()
        })
    );
}

#[test]
fn codex_turn_failed_is_the_only_terminal() {
    let mut p = CodexParser::new(Path::new("/w/api"), None);
    let ev = parse_stream(&mut p, CODEX_FAILED);
    let terminal: Vec<_> = ev.iter().filter(|e| e.is_terminal()).collect();
    assert_eq!(
        terminal,
        [&AgentEvent::Failed {
            error: "stream disconnected before completion".into()
        }]
    );
}

#[test]
fn codex_approval_events_become_questions() {
    let mut p = CodexParser::new(Path::new("/w"), None);
    let ev = parse_stream(
        &mut p,
        r#"{"type":"exec_approval_request","command":"rm -rf target"}"#,
    );
    assert!(matches!(&ev[0], AgentEvent::Question { text, .. } if text.contains("rm -rf target")));
}

#[test]
fn codex_args() {
    let mut s = spec("codex");
    s.model = Some("gpt-5".into());
    let a = codex::args(&s);
    assert_eq!(
        a,
        [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "-C",
            "/w/api",
            "-s",
            "workspace-write",
            "-m",
            "gpt-5",
            "-"
        ]
    );
    s.read_only = true;
    assert!(codex::args(&s).windows(2).any(|w| w == ["-s", "read-only"]));
    s.session = Some("thread-1".into());
    let a = codex::args(&s);
    assert_eq!(&a[..3], ["exec", "resume", "--json"]);
    assert_eq!(&a[a.len() - 2..], ["thread-1", "-"]);
    assert!(!a.contains(&"-C".to_string()));
    assert!(a.iter().any(|x| x == "sandbox_mode=\"read-only\""));
}

// -- opencode -----------------------------------------------------------------

#[test]
fn opencode_json_run() {
    let mut p = OpencodeParser::new(Path::new("/w/api"), Some("anthropic/sonnet"));
    let ev = parse_stream(&mut p, OC_RUN);
    assert_eq!(
        ev[0],
        AgentEvent::SessionStarted {
            session: "ses_abc123".into()
        }
    );
    assert!(ev.contains(&AgentEvent::ToolCall {
        name: "read".into(),
        summary: "src/webhook.ts".into()
    }));
    let files: Vec<_> = ev
        .iter()
        .filter(|e| matches!(e, AgentEvent::FileChanged { .. }))
        .collect();
    // The failed edit is not a change.
    assert_eq!(
        files,
        [&AgentEvent::FileChanged {
            path: "src/webhook.ts".into()
        }]
    );
    assert!(ev.contains(&msg("Handled the refund event.")));
    // Once JSON was seen, a stray text line is not a message.
    assert_eq!(
        ev.iter()
            .filter(|e| matches!(e, AgentEvent::Message { .. }))
            .count(),
        1
    );
    assert_eq!(
        ev.last(),
        Some(&AgentEvent::Usage {
            input_tokens: 960,
            output_tokens: 120,
            cost_usd: Some(0.0123),
            model: "anthropic/sonnet".into()
        })
    );
}

#[test]
fn opencode_error() {
    let mut p = OpencodeParser::new(Path::new("/w/api"), None);
    let ev = parse_stream(&mut p, OC_ERR);
    assert_eq!(
        ev.last(),
        Some(&AgentEvent::Failed {
            error: "No credentials for provider anthropic".into()
        })
    );
}

#[test]
fn opencode_plain_text_is_messages() {
    let mut p = OpencodeParser::new(Path::new("/w/api"), None);
    let ev = parse_stream(&mut p, OC_PLAIN);
    assert_eq!(
        ev,
        [
            msg("I looked at the webhook."),
            msg("Added the refund branch.")
        ]
    );
}

#[test]
fn opencode_args() {
    let mut s = spec("opencode");
    s.model = Some("anthropic/sonnet".into());
    s.read_only = true;
    s.session = Some("ses_1".into());
    let a = opencode::args(&s);
    assert_eq!(&a[..3], ["run", "--format", "json"]);
    assert!(a.windows(2).any(|w| w == ["-m", "anthropic/sonnet"]));
    assert!(a.windows(2).any(|w| w == ["--dir", "/w/api"]));
    assert!(a.windows(2).any(|w| w == ["--session", "ses_1"]));
    assert!(a.windows(2).any(|w| w == ["--agent", "plan"]));
    assert_eq!(a.last().unwrap(), "do it");
    s.prompt = "--help me".into();
    assert_eq!(opencode::args(&s).last().unwrap(), " --help me");
}

#[test]
fn garbage_never_panics() {
    let junk = "\u{0}\n{\n[1,2\n{\"type\":5}\n{\"type\":\"assistant\",\"message\":7}\n{\"type\":\"item.completed\",\"item\":null}\n\"str\"\n";
    let mut c = ClaudeParser::new(Path::new("/"), None);
    let mut x = CodexParser::new(Path::new("/"), None);
    let mut o = OpencodeParser::new(Path::new("/"), None);
    let _ = parse_stream(&mut c, junk);
    let _ = parse_stream(&mut x, junk);
    let _ = parse_stream(&mut o, junk);
}

// -- Tiers --------------------------------------------------------------------

fn cfg() -> AgentsConfig {
    let mut c = AgentsConfig::default();
    c.tiers.insert(
        "claude".into(),
        TierModels {
            high: Some("opus".into()),
            medium: Some("sonnet".into()),
            low: Some("haiku".into()),
        },
    );
    c.tiers.insert(
        "codex".into(),
        TierModels {
            high: Some("big".into()),
            medium: None,
            low: Some(" ".into()),
        },
    );
    c.roles.insert(
        "tester".into(),
        RoleConfig {
            tier: None,
            harness: Some("codex".into()),
        },
    );
    c.roles.insert(
        "developer".into(),
        RoleConfig {
            tier: Some(Tier::High),
            harness: None,
        },
    );
    c
}

#[test]
fn default_tiers_follow_the_design() {
    let none = AgentsConfig::default();
    let t = |r| resolve(&none, r, &Overrides::default(), None).tier;
    assert_eq!(t(AgentRole::Planner), Tier::High);
    assert_eq!(t(AgentRole::Reviewer), Tier::High);
    assert_eq!(t(AgentRole::Debugger), Tier::High);
    assert_eq!(t(AgentRole::Developer), Tier::Medium);
    assert_eq!(t(AgentRole::Tester), Tier::Low);
    // No model configured: no model flag.
    assert_eq!(
        resolve_pair(&none, AgentRole::Developer, &Overrides::default()),
        ("claude".to_string(), None)
    );
}

#[test]
fn config_and_overrides_pick_harness_tier_and_model() {
    let c = cfg();
    let r = resolve(&c, AgentRole::Planner, &Overrides::default(), None);
    assert_eq!(
        (r.harness.as_str(), r.tier, r.model.as_deref()),
        ("claude", Tier::High, Some("opus"))
    );
    // Role entry sets only the tier.
    let r = resolve(&c, AgentRole::Developer, &Overrides::default(), None);
    assert_eq!((r.tier, r.model.as_deref()), (Tier::High, Some("opus")));
    // Role entry sets only the harness; its tier has no model (blank counts as none).
    let r = resolve(&c, AgentRole::Tester, &Overrides::default(), None);
    assert_eq!(
        (r.harness.as_str(), r.tier, r.model),
        ("codex", Tier::Low, None)
    );
    // The request wins over the config.
    let ov = Overrides {
        harness: Some("claude".into()),
        tier: Some(Tier::Low),
    };
    let r = resolve(&c, AgentRole::Tester, &ov, None);
    assert_eq!(
        (r.harness.as_str(), r.tier, r.model.as_deref()),
        ("claude", Tier::Low, Some("haiku"))
    );
}

#[test]
fn a_missing_harness_falls_back_but_a_requested_one_does_not() {
    let c = cfg();
    let only_codex = vec!["codex".to_string()];
    let r = resolve(
        &c,
        AgentRole::Planner,
        &Overrides::default(),
        Some(&only_codex),
    );
    assert_eq!(r.harness, "codex");
    assert_eq!(r.model.as_deref(), Some("big"));
    let ov = Overrides {
        harness: Some("opencode".into()),
        tier: None,
    };
    let r = resolve(&c, AgentRole::Planner, &ov, Some(&only_codex));
    assert_eq!(r.harness, "opencode");
}

#[test]
fn tier_shift_stops_at_the_ends() {
    assert_eq!(Tier::Medium.shift(1), Tier::High);
    assert_eq!(Tier::High.shift(1), Tier::High);
    assert_eq!(Tier::Medium.shift(-1), Tier::Low);
    assert_eq!(Tier::Low.shift(-1), Tier::Low);
}

#[test]
fn effort_goes_to_each_harness_flag() {
    let mut s = spec("claude");
    s.effort = Some("max".into());
    let a = claude::args(&s).join(" ");
    assert!(a.contains("--effort max"), "{a}");
    let mut s = spec("codex");
    s.effort = Some("high".into());
    let a = codex::args(&s).join(" ");
    assert!(a.contains("-c model_reasoning_effort=\"high\""), "{a}");
    let mut s = spec("opencode");
    s.effort = Some("high".into());
    let a = opencode::args(&s).join(" ");
    assert!(a.contains("--variant high"), "{a}");
    assert!(!claude::args(&spec("claude")).join(" ").contains("--effort"));
}

#[test]
fn opencode_always_names_its_agent() {
    let a = opencode::args(&spec("opencode")).join(" ");
    assert!(a.contains("--agent build"), "{a}");
    let mut s = spec("opencode");
    s.read_only = true;
    let a = opencode::args(&s).join(" ");
    assert!(
        a.contains("--agent plan") && !a.contains("--agent build"),
        "{a}"
    );
}

#[test]
fn effort_resolves_per_harness_and_tier() {
    let mut cfg = AgentsConfig::default();
    cfg.effort.insert(
        "claude".into(),
        TierModels {
            high: Some("max".into()),
            ..Default::default()
        },
    );
    let r = resolve(&cfg, AgentRole::Security, &Overrides::default(), None);
    assert_eq!(r.tier, Tier::High);
    assert_eq!(r.effort.as_deref(), Some("max"));
    let r = resolve(&cfg, AgentRole::Developer, &Overrides::default(), None);
    assert_eq!(r.effort, None);
}

#[test]
fn reasoning_of_codex_and_opencode() {
    let mut c = CodexParser::new(Path::new("/w"), None);
    let ev = parse_stream(
        &mut c,
        r#"{"type":"item.completed","item":{"id":"r1","type":"reasoning","text":"Look at the config first"}}"#,
    );
    assert_eq!(
        ev,
        vec![AgentEvent::Reasoning {
            text: "Look at the config first".into()
        }]
    );
    let mut o = OpencodeParser::new(Path::new("/w"), None);
    let ev = parse_stream(
        &mut o,
        r#"{"type":"reasoning","sessionID":"s1","part":{"type":"reasoning","text":"Which file?"}}"#,
    );
    assert!(ev.contains(&AgentEvent::Reasoning {
        text: "Which file?".into()
    }));
}
