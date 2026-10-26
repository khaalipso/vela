//! Agent worktrees, proposals (diff, accept, reject) and the registry, on temporary repos.

mod common;

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use common::*;
use vela_agents::AgentEvent;
use vela_agents::proposals::{accept, proposals, reasons};
use vela_agents::registry::{self, Entry};
use vela_agents::worktree;
use vela_core::model::{Agent, AgentRole, AgentStatus, AgentUsage, HunkState, Origin, Tier};
use vela_core::{diff, paths};

fn agent(id: &str, status: AgentStatus) -> Agent {
    Agent {
        id: id.into(),
        space: "refunds".into(),
        role: AgentRole::Developer,
        tool: "claude".into(),
        worktrees: vec![],
        status,
        summary: String::new(),
        model: None,
        tier: Some(Tier::Medium),
        session: None,
        prompt: "p".into(),
        last_message: String::new(),
        plan: vec![],
        question: None,
        options: vec![],
        usage: AgentUsage::default(),
        started: "2026-10-26T10:00:00Z".into(),
        finished: None,
    }
}

fn entry_with_trees(e: &Env, id: &str) -> Entry {
    let trees = worktree::create(&e.vela, &e.space, id).unwrap();
    let mut a = agent(id, AgentStatus::Done);
    a.summary = "Added a line to notes".into();
    a.worktrees = trees
        .iter()
        .map(|t| (t.repo.clone(), t.path.to_string_lossy().into_owned()))
        .collect();
    Entry {
        agent: a,
        bases: trees
            .iter()
            .map(|t| (t.repo.clone(), t.base.clone()))
            .collect(),
        read_only: false,
        pending_tools: vec![],
    }
}

// -- worktrees ------------------------------------------------------------------

#[test]
fn worktree_is_created_from_head_on_its_own_branch_and_removed() {
    let e = env();
    let user_wt = Path::new(&e.space.repos[0].worktree);
    // The user's uncommitted work is not copied.
    write(user_wt, "notes.txt", "mine\n");
    write(user_wt, "untracked.txt", "u\n");
    let trees = worktree::create(&e.vela, &e.space, "developer-1").unwrap();
    assert_eq!(trees.len(), 1);
    let wt = &trees[0].path;
    assert_eq!(
        wt,
        &paths::agent_worktree(&e.vela.home, "refunds", "developer-1", "api")
    );
    assert_eq!(fs::read_to_string(wt.join("notes.txt")).unwrap(), NOTES);
    assert!(!wt.join("untracked.txt").exists());
    assert_eq!(
        sh(wt, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "feat/refunds--developer-1"
    );
    assert_eq!(trees[0].base, sh(user_wt, &["rev-parse", "HEAD"]).trim());

    worktree::remove(
        &e.vela,
        &e.space,
        "developer-1",
        &[("api".into(), wt.to_string_lossy().into_owned())],
    )
    .unwrap();
    assert!(!wt.exists());
    assert!(!worktree::agent_root(&e.vela, &e.space, "developer-1").exists());
    let branches = sh(user_wt, &["branch", "--list", "feat/refunds--*"]);
    assert!(branches.trim().is_empty(), "{branches}");
}

#[test]
fn a_failing_repo_rolls_back_the_others() {
    let e = env_with(&["api", "web"]);
    // Make the branch exist in the second repo so its worktree cannot be created.
    let web = Path::new(&e.space.repos[1].worktree);
    sh(web, &["branch", "feat/refunds--developer-1"]);
    let err = worktree::create(&e.vela, &e.space, "developer-1");
    assert!(err.is_err());
    let api = Path::new(&e.space.repos[0].worktree);
    assert!(
        sh(api, &["branch", "--list", "feat/refunds--*"])
            .trim()
            .is_empty()
    );
    assert!(!worktree::agent_root(&e.vela, &e.space, "developer-1").exists());
}

#[test]
fn run_dir_is_the_worktree_for_one_repo_and_the_agent_root_for_several() {
    let e = env_with(&["api", "web"]);
    let one = vec![("api".to_string(), "/x/api".to_string())];
    assert_eq!(
        worktree::run_dir(&e.vela, &e.space, "developer-1", &one),
        Path::new("/x/api")
    );
    let two = vec![
        ("api".to_string(), "/x/api".to_string()),
        ("web".to_string(), "/x/web".to_string()),
    ];
    assert_eq!(
        worktree::run_dir(&e.vela, &e.space, "developer-1", &two),
        worktree::agent_root(&e.vela, &e.space, "developer-1")
    );
}

// -- proposals ------------------------------------------------------------------

#[test]
fn proposals_are_what_the_agent_changed_not_what_the_user_changed() {
    let e = env();
    let user_wt = Path::new(&e.space.repos[0].worktree);
    let entry = entry_with_trees(&e, "developer-1");
    let agent_wt = Path::new(&entry.agent.worktrees[0].1);

    // The user edits other.txt (uncommitted); the agent edits notes.txt and adds a file.
    write(user_wt, "other.txt", "x\nY\nz\n");
    write(agent_wt, "notes.txt", &NOTES.replace("ten\n", "TEN\n"));
    write(agent_wt, "added.txt", "new file\n");

    let list = proposals(
        &e.space,
        std::slice::from_ref(&entry),
        &BTreeSet::new(),
        false,
    )
    .unwrap();
    let paths: Vec<_> = list.iter().map(|p| p.hunk.path.as_str()).collect();
    assert_eq!(paths.len(), 2, "{paths:?}");
    assert!(paths.contains(&"notes.txt") && paths.contains(&"added.txt"));
    // The user's own edit to other.txt is not undone by the agent.
    assert!(!paths.contains(&"other.txt"));
    for p in &list {
        assert_eq!(
            p.hunk.origin,
            Origin::Agent {
                agent: "developer-1".into()
            }
        );
        assert_eq!(p.hunk.state, HunkState::Pending);
        assert_eq!(p.hunk.repo, "api");
    }
    // Reason = the agent's latest message.
    let hunks: Vec<_> = list.iter().map(|p| p.hunk.clone()).collect();
    let r = reasons(&[entry], &hunks);
    assert_eq!(r[&hunks[0].id], "Added a line to notes");
}

#[test]
fn accepting_applies_to_the_user_worktree_and_stages() {
    let e = env();
    let user_wt = Path::new(&e.space.repos[0].worktree);
    let entry = entry_with_trees(&e, "developer-1");
    let agent_wt = Path::new(&entry.agent.worktrees[0].1);
    write(user_wt, "other.txt", "x\nY\nz\n"); // uncommitted work stays untouched
    write(agent_wt, "notes.txt", &NOTES.replace("ten\n", "TEN\n"));
    write(agent_wt, "added.txt", "new file\n");

    let list = proposals(
        &e.space,
        std::slice::from_ref(&entry),
        &BTreeSet::new(),
        false,
    )
    .unwrap();
    let notes = list.iter().find(|p| p.hunk.path == "notes.txt").unwrap();
    let h = accept(&e.space, notes).unwrap();
    assert_eq!(h.state, HunkState::Staged);
    assert_eq!(
        h.origin,
        Origin::Agent {
            agent: "developer-1".into()
        }
    );
    assert_eq!(
        fs::read_to_string(user_wt.join("notes.txt")).unwrap(),
        NOTES.replace("ten\n", "TEN\n")
    );
    assert_eq!(
        fs::read_to_string(user_wt.join("other.txt")).unwrap(),
        "x\nY\nz\n"
    );
    // Staged: the index has it.
    let staged = sh(user_wt, &["diff", "--cached", "--name-only"]);
    assert_eq!(staged.trim(), "notes.txt");
    // Accepted hunks are no longer proposals; the other one still is.
    let again = proposals(
        &e.space,
        std::slice::from_ref(&entry),
        &BTreeSet::new(),
        false,
    )
    .unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].hunk.path, "added.txt");
    // And a new file can be accepted too.
    accept(&e.space, &again[0]).unwrap();
    assert_eq!(
        fs::read_to_string(user_wt.join("added.txt")).unwrap(),
        "new file\n"
    );
    assert!(
        proposals(&e.space, &[entry], &BTreeSet::new(), false)
            .unwrap()
            .is_empty()
    );
    // Both are now staged hunks of the user worktree.
    assert_eq!(diff::staged_hunks(&e.space).unwrap().len(), 2);
}

#[test]
fn a_hunk_that_clashes_with_the_users_lines_does_not_apply() {
    let e = env();
    let user_wt = Path::new(&e.space.repos[0].worktree);
    let entry = entry_with_trees(&e, "developer-1");
    let agent_wt = Path::new(&entry.agent.worktrees[0].1);
    write(user_wt, "notes.txt", &NOTES.replace("ten\n", "my ten\n"));
    write(agent_wt, "notes.txt", &NOTES.replace("ten\n", "TEN\n"));
    let list = proposals(&e.space, &[entry], &BTreeSet::new(), false).unwrap();
    assert_eq!(list.len(), 1);
    let err = accept(&e.space, &list[0]).unwrap_err();
    assert!(matches!(err, vela_core::Error::PatchFailed(_)), "{err}");
    // Nothing was touched.
    assert_eq!(
        fs::read_to_string(user_wt.join("notes.txt")).unwrap(),
        NOTES.replace("ten\n", "my ten\n")
    );
}

#[test]
fn rejected_proposals_are_hidden_but_can_be_listed() {
    let e = env();
    let entry = entry_with_trees(&e, "developer-1");
    let agent_wt = Path::new(&entry.agent.worktrees[0].1);
    write(agent_wt, "notes.txt", &NOTES.replace("ten\n", "TEN\n"));
    let list = proposals(
        &e.space,
        std::slice::from_ref(&entry),
        &BTreeSet::new(),
        false,
    )
    .unwrap();
    let id = list[0].hunk.id.clone();
    let rejected: BTreeSet<String> = [id.clone()].into();
    assert!(
        proposals(&e.space, std::slice::from_ref(&entry), &rejected, false)
            .unwrap()
            .is_empty()
    );
    let all = proposals(&e.space, &[entry], &rejected, true).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].hunk.state, HunkState::Rejected);
}

#[test]
fn committed_changes_in_the_agent_worktree_are_proposed_too() {
    let e = env();
    let entry = entry_with_trees(&e, "developer-1");
    let agent_wt = Path::new(&entry.agent.worktrees[0].1);
    write(agent_wt, "notes.txt", &NOTES.replace("ten\n", "TEN\n"));
    sh(agent_wt, &["add", "-A"]);
    sh(
        agent_wt,
        &[
            "-c",
            "user.name=A",
            "-c",
            "user.email=a@b.c",
            "commit",
            "-q",
            "-m",
            "agent commit",
        ],
    );
    let list = proposals(&e.space, &[entry], &BTreeSet::new(), false).unwrap();
    assert_eq!(list.len(), 1);
}

// -- registry -------------------------------------------------------------------

#[test]
fn registry_round_trips_and_recovers_after_a_restart() {
    let e = env();
    let id = "developer-1";
    let mut working = entry_with_trees(&e, id);
    working.agent.status = AgentStatus::Working;
    working.agent.usage.cost_usd = 0.25;
    registry::insert(&e.vela, "refunds", working.clone()).unwrap();
    let mut waiting = working.clone();
    waiting.agent.id = "developer-2".into();
    waiting.agent.status = AgentStatus::Waiting;
    waiting.agent.question = Some("Keep it?".into());
    registry::insert(&e.vela, "refunds", waiting).unwrap();
    let mut done = working.clone();
    done.agent.id = "developer-3".into();
    done.agent.status = AgentStatus::Done;
    registry::insert(&e.vela, "refunds", done).unwrap();

    let back = registry::load(&e.vela, "refunds").unwrap();
    assert_eq!(back.len(), 3);
    assert_eq!(back[0], working);

    // A new manager is a restart: nothing is live, so the working agent was interrupted.
    let m = manager(&e);
    let agents = m.list(&e.vela, "refunds").unwrap();
    let by = |id: &str| agents.iter().find(|a| a.id == id).unwrap();
    assert_eq!(by("developer-1").status, AgentStatus::Interrupted);
    assert!(by("developer-1").finished.is_some());
    assert_eq!(by("developer-2").status, AgentStatus::Waiting);
    assert_eq!(by("developer-3").status, AgentStatus::Done);
    // The recovery is saved.
    let again = registry::load(&e.vela, "refunds").unwrap();
    assert_eq!(again[0].agent.status, AgentStatus::Interrupted);
    // Newest first.
    assert_eq!(agents[0].id, "developer-3");
    // The waiting agent is the space's question.
    let q = m.question(&e.vela, "refunds").unwrap().unwrap();
    assert_eq!(q.agent_id, "developer-2");
    assert_eq!((q.yes.as_str(), q.no.as_str()), ("Yes", "No"));
    // Usage adds up over the agents.
    assert!((m.usage(&e.vela, "refunds").unwrap().cost_usd - 0.75).abs() < 1e-9);
}

#[test]
fn ids_count_per_role() {
    let e = env();
    let a = entry_with_trees(&e, "developer-1");
    let mut b = a.clone();
    b.agent.id = "developer-4".into();
    let mut c = a.clone();
    c.agent.id = "tester-2".into();
    let all = vec![a, b, c];
    assert_eq!(registry::next_id(&all, AgentRole::Developer), "developer-5");
    assert_eq!(registry::next_id(&all, AgentRole::Tester), "tester-3");
    assert_eq!(registry::next_id(&all, AgentRole::Reviewer), "reviewer-1");
}

#[test]
fn the_log_is_append_only_and_survives_a_cut_line() {
    let e = env();
    let m = manager(&e);
    for ev in [
        AgentEvent::Prompt {
            text: "do it".into(),
        },
        AgentEvent::Message { text: "ok".into() },
        AgentEvent::Done {
            summary: "ok".into(),
        },
    ] {
        registry::append_log(&e.vela, "refunds", "developer-1", &ev).unwrap();
    }
    // A crash can leave half a line.
    let file = registry::log_file(&e.vela, "refunds", "developer-1");
    let mut text = fs::read_to_string(&file).unwrap();
    text.push_str("{\"ts\":\"2026-10-26T10:00:00Z\",\"event\":{\"type\":\"mess");
    fs::write(&file, text).unwrap();
    let log = m.log(&e.vela, "refunds", "developer-1").unwrap();
    assert_eq!(log.len(), 3);
    assert_eq!(
        log[0].event,
        AgentEvent::Prompt {
            text: "do it".into()
        }
    );
    assert!(log[2].event.is_terminal());
    assert!(m.log(&e.vela, "refunds", "nobody").unwrap().is_empty());
}

#[test]
fn events_fold_into_the_entry() {
    let e = env();
    let mut en = entry_with_trees(&e, "developer-1");
    en.agent.status = AgentStatus::Working;
    let ts = "2026-10-26T10:05:00Z";
    for ev in [
        AgentEvent::SessionStarted {
            session: "s1".into(),
        },
        AgentEvent::Message {
            text: "First line\nsecond".into(),
        },
        AgentEvent::Plan {
            steps: vec!["a".into(), "b".into()],
        },
        AgentEvent::Usage {
            input_tokens: 10,
            output_tokens: 5,
            cost_usd: Some(0.5),
            model: "claude-x".into(),
        },
        AgentEvent::Usage {
            input_tokens: 1,
            output_tokens: 1,
            cost_usd: None,
            model: "claude-x".into(),
        },
        AgentEvent::Question {
            text: "Allow Bash?".into(),
            options: vec!["Allow".into(), "Deny".into()],
            tools: vec!["Bash".into()],
        },
        AgentEvent::Done {
            summary: "all done".into(),
        },
    ] {
        registry::apply_event(&mut en, &ev, ts);
    }
    let a = &en.agent;
    assert_eq!(a.session.as_deref(), Some("s1"));
    assert_eq!(a.last_message, "First line\nsecond");
    assert_eq!(a.plan, ["a", "b"]);
    assert_eq!((a.usage.input_tokens, a.usage.output_tokens), (11, 6));
    assert!((a.usage.cost_usd - 0.5).abs() < 1e-9);
    assert_eq!(a.model.as_deref(), Some("claude-x"));
    // A question at the end of the run: the agent waits, it is not finished.
    assert_eq!(a.status, AgentStatus::Waiting);
    assert_eq!(a.finished, None);
    assert_eq!(en.pending_tools, ["Bash"]);
    registry::begin_run(&mut en);
    assert_eq!(en.agent.status, AgentStatus::Working);
    assert!(en.agent.question.is_none() && en.pending_tools.is_empty());
    registry::apply_event(
        &mut en,
        &AgentEvent::Failed {
            error: "cancelled".into(),
        },
        ts,
    );
    assert_eq!(en.agent.status, AgentStatus::Failed);
    assert_eq!(en.agent.summary, "Cancelled");
    assert_eq!(en.agent.finished.as_deref(), Some(ts));
}
