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
    },
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
            SpaceCmd::New { name, repos, base } => {
                let s = space::create(&vela, &name, &repos, base.as_deref())?;
                if cli.json {
                    print_json(&s)?;
                } else {
                    println!("created {} on {}", s.id, s.branch);
                    for r in &s.repos {
                        println!("  {}  {}", r.name, r.worktree);
                    }
                }
            }
            SpaceCmd::Ls => {
                let all = store::list(&vela)?;
                if cli.json {
                    print_json(&all)?;
                } else {
                    for s in &all {
                        let repos: Vec<&str> = s.repos.iter().map(|r| r.name.as_str()).collect();
                        println!(
                            "{}  {}  {}{}",
                            s.id,
                            s.branch,
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
    }
    Ok(())
}

fn main() {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
