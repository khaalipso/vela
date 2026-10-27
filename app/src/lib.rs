//! Vela desktop app: a Tauri shell over `vela-core`.

use std::sync::Arc;

use tauri::{Manager, WindowEvent};
use vela_core::Vela;

pub mod agentrun;
pub mod checkrun;
pub mod commands;
pub mod desktop;
pub mod error;
pub mod fileops;
pub mod prs;
pub mod shellenv;
mod tauri_cmds;
mod tauri_menu;
pub mod term;
pub mod watch;

use tauri_cmds as c;
use tauri_menu as m;

pub fn run() {
    let vela = match Vela::from_env() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("vela: {e}");
            std::process::exit(1);
        }
    };
    let watchers = Arc::new(watch::Watchers::default());
    let runner = Arc::new(checkrun::CheckRunner::default());
    let agents = vela_agents::AgentManager::new(vela_agents::Drivers::system());
    let refresher = Arc::new(agentrun::Refresher::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(vela)
        .manage(watchers)
        .manage(runner)
        .manage(agents)
        .manage(refresher)
        .manage(Arc::new(term::Terminals::default()))
        .setup(|app| {
            let vela = app.state::<Vela>().inner().clone();
            let watchers = app.state::<Arc<watch::Watchers>>().inner().clone();
            let emit = c::emitter(app.handle());
            // No window is open yet, so no space lives in another one.
            let _ = commands::clear_windows(&vela);
            std::thread::spawn(move || watchers.sync(&vela, &emit));
            // Warm the caches the agent sheets read: harness versions, opencode's models.
            let agents = app
                .state::<Arc<vela_agents::AgentManager>>()
                .inner()
                .clone();
            std::thread::spawn(move || {
                agents.harnesses();
                commands::agent_models(&agents, "opencode");
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing a space window puts the space back in the main window.
            if let WindowEvent::Destroyed = event
                && let Some(id) = window.label().strip_prefix("space-")
            {
                let vela = window.state::<Vela>();
                let _ = commands::set_window(&vela, id, None);
                let _ = tauri::Emitter::emit(
                    window,
                    watch::EVENT,
                    watch::ChangeEvent {
                        space_id: id.to_string(),
                        kind: watch::ChangeKind::State,
                    },
                );
            }
        })
        .invoke_handler(tauri::generate_handler![
            c::list_repos,
            c::declare_repo,
            c::create_repo,
            c::add_repo_to_space,
            c::remove_repo_from_space,
            c::default_repo_parent,
            c::list_spaces,
            c::create_space,
            c::set_window,
            c::open_space_window,
            c::status,
            c::hunks,
            c::stage_hunk,
            c::edit_hunk,
            c::unstage_hunk,
            c::reject_hunk,
            c::list_files,
            c::space_files,
            c::stage_file,
            c::unstage_file,
            c::read_file,
            c::write_file,
            c::draft_commit,
            c::commit,
            c::commit_plan,
            c::validate_message,
            c::commit_groups,
            c::links,
            c::add_link,
            c::remove_link,
            c::open_url,
            c::harnesses,
            c::agent_defaults,
            c::agents,
            c::reasons,
            c::ask_agent,
            c::question,
            c::answer_agent,
            c::cancel_agent,
            c::agent_log,
            c::agent_usage,
            c::accept_proposal,
            c::notes,
            c::ask_fix,
            c::resolve_note,
            c::agent_tiers,
            c::set_agent_tier,
            c::agent_models,
            c::pull_requests,
            c::create_pull_request,
            c::comment_pull_request,
            c::agent_prompts,
            c::set_agent_prompt,
            c::term_open,
            c::term_write,
            c::term_resize,
            c::term_close,
            c::stack,
            c::run_gate,
            c::set_checks_auto,
            c::checks,
            c::run_checks,
            c::check_log,
            c::set_check_enabled,
            m::create_file,
            m::create_dir,
            m::rename_path,
            m::delete_path,
            m::discard_file,
            m::reveal_path,
            m::absolute_path,
            m::open_terminal,
            m::rename_space,
            m::set_space_color,
            m::archive_space,
            m::unarchive_space,
            m::list_archived,
            m::remove_space,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vela");
}
