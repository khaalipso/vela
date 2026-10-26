//! Vela desktop app: a Tauri shell over `vela-core`.

use std::sync::Arc;

use tauri::{Manager, WindowEvent};
use vela_core::Vela;

pub mod checkrun;
pub mod commands;
pub mod error;
mod tauri_cmds;
pub mod watch;

use tauri_cmds as c;

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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(vela)
        .manage(watchers)
        .manage(runner)
        .setup(|app| {
            let vela = app.state::<Vela>().inner().clone();
            let watchers = app.state::<Arc<watch::Watchers>>().inner().clone();
            let emit = c::emitter(app.handle());
            // No window is open yet, so no space lives in another one.
            let _ = commands::clear_windows(&vela);
            std::thread::spawn(move || watchers.sync(&vela, &emit));
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
            c::agents,
            c::reasons,
            c::ask_agent,
            c::question,
            c::answer_agent,
            c::notes,
            c::ask_fix,
            c::stack,
            c::run_gate,
            c::set_checks_auto,
            c::checks,
            c::run_checks,
            c::check_log,
            c::set_check_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vela");
}
