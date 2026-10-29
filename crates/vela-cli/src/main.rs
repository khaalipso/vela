//! `vela`: headless access to every core feature.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use serde::Serialize;
use vela_core::Vela;
use vela_core::model::{ChangeKind, Hunk, LineKind, Space, UpNext};
use vela_core::{commit, diff, space, stage, status, store, upnext};

#[derive(Parser)]
#[command(name = "vela", version, about = "Task-centred IDE core")]
struct Cli {
    /// Print the model as JSON instead of human output.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Manage spaces.
    Space {
        #[command(subcommand)]
        action: SpaceCmd,
    },
    /// Files changed in a space, staged and unstaged.
    Status { space: String },
    /// Hunks of a space.
    Diff {
        space: String,
        /// Show staged hunks instead of unstaged ones.
        #[arg(long)]
        staged: bool,
    },
    /// Stage one hunk.
    Stage { space: String, hunk_id: String },
    /// Unstage one hunk.
    Unstage { space: String, hunk_id: String },
    /// Commit every repo with staged changes.
    Commit {
        space: String,
        #[arg(short, long)]
        message: String,
    },
    /// What to do next in a space.
    Next { space: String },
    /// Notes of the reviewer and security agents of a space.
    Notes { space: String },
    /// Run an agent in a space and print its events until it ends. A question is answered
    /// on stdin.
    Ask {
        space: String,
        /// developer, reviewer, tester, planner, debugger, product, security.
        role: String,
        prompt: String,
        /// claude, codex or opencode (default: the role's).
        #[arg(long)]
        harness: Option<String>,
        /// high, medium or low (default: the role's).
        #[arg(long)]
        tier: Option<String>,
    },
}

#[derive(Subcommand)]
enum SpaceCmd {
    /// Create a space with one worktree per repo.
    New {
        name: String,
        #[arg(long = "repo", required = true, num_args = 1..)]
        repos: Vec<PathBuf>,
        #[arg(long)]
        base: Option<String>,
        /// The branch of the space: an existing local or remote branch is used as it is.
        /// Default: the `[spaces] branch` template (feat/{slug}).
        #[arg(long)]
        branch: Option<String>,
        /// The ticket of the task (PAY-412): `{ticket}` in the template, `Refs:` in commits.
        #[arg(long)]
        ticket: Option<String>,
    },
    /// Rename the branch of a space (and of its agents): one repo with --repo, else every repo.
    RenameBranch {
        id: String,
        branch: String,
        #[arg(long)]
        repo: Option<String>,
    },
    /// Set the ticket of a space (an empty one clears it).
    Ticket { id: String, ticket: String },
    /// List spaces.
    Ls,
    /// Remove a space and its worktrees.
    Rm { id: String },
}

fn print_json<T: Serialize + ?Sized>(v: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

fn letter(k: Option<ChangeKind>) -> char {
    match k {
        None => ' ',
        Some(ChangeKind::Added) => 'A',
        Some(ChangeKind::Modified) => 'M',
        Some(ChangeKind::Deleted) => 'D',
        Some(ChangeKind::Renamed) => 'R',
        Some(ChangeKind::Untracked) => '?',
        Some(ChangeKind::Conflicted) => 'U',
    }
}

fn print_hunks(hunks: &[Hunk]) {
    for h in hunks {
        println!(
            "{} {}/{} @@ -{},{} +{},{} @@ {}",
            h.id, h.repo, h.path, h.old_start, h.old_lines, h.new_start, h.new_lines, h.section
        );
        for l in &h.lines {
            let sign = match l.kind {
                LineKind::Context => ' ',
                LineKind::Add => '+',
                LineKind::Del => '-',
            };
            println!("{sign}{}", l.text);
        }
    }
}

fn describe(next: &UpNext) -> String {
    match next {
        UpNext::AgentQuestion { agent, text } => format!("answer {agent}: {text}"),
        UpNext::Review { count } => format!("review {count} hunk(s)"),
        UpNext::Commit { repos, files } => format!("commit {files} file(s) in {repos} repo(s)"),
        UpNext::Nothing => "nothing to do".to_string(),
    }
}

fn run(cli: Cli) -> Result<()> {
    let vela = Vela::from_env()?;
    let load = |id: &str| -> Result<Space> { Ok(store::load(&vela, id)?) };
    match cli.command {
        Command::Space { action } => match action {
            SpaceCmd::RenameBranch { id, branch, repo } => {
                let s = vela_core::branches::rename(&vela, &id, &branch, repo.as_deref())?;
                for r in &s.repos {
                    println!("{}  {}", r.name, r.branch);
                }
            }
            SpaceCmd::Ticket { id, ticket } => {
                let s = space::set_ticket(&vela, &id, &ticket)?;
                println!("{}: {}", s.id, s.ticket.as_deref().unwrap_or("no ticket"));
            }
            SpaceCmd::New {
                name,
                repos,
                base,
                branch,
                ticket,
            } => {
                let s = space::create_with(
                    &vela,
                    &name,
                    &repos,
                    &space::CreateOptions {
                        base,
                        branch,
                        ticket,
                        ..Default::default()
                    },
                )?;
                if cli.json {
                    print_json(&s)?;
                } else {
                    println!("created {}", s.id);
                    for r in &s.repos {
                        println!("  {}  {}  {}", r.name, r.branch, r.worktree);
                    }
                }
            }
            SpaceCmd::Ls => {
                let all = store::list(&vela)?;
                if cli.json {
                    print_json(&all)?;
                } else {
                    for s in &all {
                        let repos: Vec<String> = s
                            .repos
                            .iter()
                            .map(|r| format!("{}@{}", r.name, r.branch))
                            .collect();
                        println!(
                            "{}  {}{}",
                            s.id,
                            repos.join(","),
                            if s.archived { "  (archived)" } else { "" }
                        );
                    }
                }
            }
            SpaceCmd::Rm { id } => {
                space::remove(&vela, &id)?;
                if !cli.json {
                    println!("removed {id}");
                }
            }
        },
        Command::Status { space } => {
            let changes = status::space_status(&load(&space)?)?;
            if cli.json {
                print_json(&changes)?;
            } else {
                for c in &changes {
                    let from = c
                        .from
                        .as_deref()
                        .map(|f| format!("{f} -> "))
                        .unwrap_or_default();
                    println!(
                        "{}{} {}/{}{}",
                        letter(c.staged),
                        letter(c.unstaged),
                        c.repo,
                        from,
                        c.path
                    );
                }
            }
        }
        Command::Diff { space, staged } => {
            let s = load(&space)?;
            let hunks = if staged {
                diff::staged_hunks(&s)?
            } else {
                diff::worktree_hunks(&s)?
            };
            if cli.json {
                print_json(&hunks)?;
            } else {
                print_hunks(&hunks);
            }
        }
        Command::Stage { space, hunk_id } => {
            stage::stage_hunk(&load(&space)?, &hunk_id)?;
            if !cli.json {
                println!("staged {hunk_id}");
            }
        }
        Command::Unstage { space, hunk_id } => {
            stage::unstage_hunk(&load(&space)?, &hunk_id)?;
            if !cli.json {
                println!("unstaged {hunk_id}");
            }
        }
        Command::Commit { space, message } => {
            let done = commit::commit(&load(&space)?, &message)?;
            if cli.json {
                print_json(&done)?;
            } else {
                for (repo, sha) in &done {
                    println!("{repo} {}", &sha[..sha.len().min(10)]);
                }
            }
        }
        Command::Next { space } => {
            let next = upnext::space_up_next(&load(&space)?)?;
            if cli.json {
                print_json(&next)?;
            } else {
                println!("{}", describe(&next));
            }
        }
        Command::Notes { space } => {
            let sp = load(&space)?;
            let entries = vela_agents::registry::load(&vela, &sp.id)?;
            let mut hunks = diff::worktree_hunks(&sp)?;
            hunks.extend(diff::staged_hunks(&sp)?);
            let notes = vela_agents::notes::notes(&vela, &sp, &entries, &hunks);
            if cli.json {
                print_json(&notes)?;
            } else {
                for n in notes {
                    println!(
                        "{:?} {}/{}:{} [{}] {}{}",
                        n.level,
                        n.repo,
                        n.path,
                        n.line,
                        if n.hunk_id.is_empty() {
                            "-"
                        } else {
                            &n.hunk_id
                        },
                        n.text,
                        if n.resolved { " (resolved)" } else { "" }
                    );
                }
            }
        }
        Command::Ask {
            space,
            role,
            prompt,
            harness,
            tier,
        } => ask(
            &vela,
            &space,
            &role,
            &prompt,
            harness,
            tier.as_deref(),
            cli.json,
        )?,
    }
    Ok(())
}

fn ask(
    vela: &Vela,
    space_id: &str,
    role: &str,
    prompt: &str,
    harness: Option<String>,
    tier: Option<&str>,
    json: bool,
) -> Result<()> {
    use std::sync::mpsc::channel;
    use vela_agents::{AgentEvent, AgentManager, AskRequest, Drivers};
    use vela_core::model::{AgentRole, AgentStatus, Tier};
    let space = store::load(vela, space_id)?;
    let role = AgentRole::parse(role).ok_or_else(|| anyhow::anyhow!("unknown role: {role}"))?;
    let tier = match tier {
        None => None,
        Some(t) => Some(
            Tier::ALL
                .into_iter()
                .find(|x| x.as_str() == t)
                .ok_or_else(|| anyhow::anyhow!("unknown tier: {t}"))?,
        ),
    };
    let m = AgentManager::new(Drivers::system());
    let (tx, rx) = channel();
    let tx = std::sync::Mutex::new(tx);
    let emit: vela_agents::Emit = std::sync::Arc::new(move |n| {
        let _ = tx.lock().map(|t| t.send(n));
    });
    let agent = m.ask(
        vela,
        &space,
        AskRequest {
            role,
            prompt: prompt.to_string(),
            harness,
            tier,
        },
        &emit,
    )?;
    eprintln!(
        "{} on {} ({})",
        agent.id,
        agent.tool,
        agent.model.as_deref().unwrap_or("default model")
    );
    while let Ok(n) = rx.recv() {
        if json {
            println!("{}", serde_json::to_string(&n.event)?);
        } else {
            match &n.event {
                AgentEvent::Message { text } => println!("{text}"),
                AgentEvent::ToolCall { name, summary } => println!("  · {name} {summary}"),
                AgentEvent::FileChanged { path } => println!("  ~ {path}"),
                AgentEvent::Plan { steps } => steps.iter().for_each(|s| println!("  - {s}")),
                AgentEvent::Question { text, options, .. } => {
                    println!("? {text} [{}]", options.join(" / "))
                }
                AgentEvent::Done { .. } => println!("done"),
                AgentEvent::Failed { error } => println!("failed: {error}"),
                _ => {}
            }
        }
        if let AgentEvent::Question { .. } = n.event {
            let mut line = String::new();
            std::io::stdin().read_line(&mut line)?;
            // A line based run ends at its question: retry until it has ended (ACP takes the
            // answer at once).
            let end = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while let Err(e) = m.answer(vela, &space, &agent.id, line.trim(), &emit) {
                if std::time::Instant::now() > end {
                    return Err(e.into());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            continue;
        }
        if n.event.is_terminal() {
            let a = m
                .list(vela, &space.id)?
                .into_iter()
                .find(|a| a.id == agent.id);
            if a.is_none_or(|a| a.status != AgentStatus::Waiting) {
                break;
            }
        }
    }
    Ok(())
}

fn main() {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
