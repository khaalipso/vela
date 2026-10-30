//! `#[tauri::command]` wrappers for the right-click menus (see `fileops.rs`).

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use vela_core::Vela;
use vela_core::model::Space;

use crate::error::{AppError, AppResult};
use crate::fileops::{self, Disposal};
use crate::tauri_cmds::emitter;
use crate::watch::{self, ChangeEvent, ChangeKind, Watchers};

async fn blocking<T, F>(vela: &Vela, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Vela) -> AppResult<T> + Send + 'static,
{
    let vela = vela.clone();
    tauri::async_runtime::spawn_blocking(move || f(&vela))
        .await
        .map_err(|e| AppError::new("internal", e.to_string()))?
}

fn notify(app: &AppHandle, space_id: &str, kind: ChangeKind) {
    crate::commands::invalidate_hunks(space_id);
    let _ = app.emit(
        watch::EVENT,
        ChangeEvent {
            space_id: space_id.to_string(),
            kind,
        },
    );
}

#[tauri::command]
pub async fn create_file(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| fileops::create_file(v, &id, &repo, &path)).await?;
    notify(&app, &space_id, ChangeKind::State);
    Ok(())
}

#[tauri::command]
pub async fn create_dir(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| fileops::create_dir(v, &id, &repo, &path)).await?;
    notify(&app, &space_id, ChangeKind::State);
    Ok(())
}

#[tauri::command]
pub async fn copy_path(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| fileops::copy_path(v, &id, &repo, &from, &to)).await?;
    notify(&app, &space_id, ChangeKind::State);
    Ok(())
}

#[tauri::command]
pub async fn rename_path(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| {
        fileops::rename_path(v, &id, &repo, &from, &to)
    })
    .await?;
    notify(&app, &space_id, ChangeKind::State);
    Ok(())
}

#[tauri::command]
pub async fn delete_path(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
    permanent: bool,
) -> AppResult<Disposal> {
    let id = space_id.clone();
    let d = blocking(&vela, move |v| {
        fileops::delete_path(v, &id, &repo, &path, permanent)
    })
    .await?;
    notify(&app, &space_id, ChangeKind::State);
    Ok(d)
}

#[tauri::command]
pub async fn discard_file(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| fileops::discard_file(v, &id, &repo, &path)).await?;
    notify(&app, &space_id, ChangeKind::State);
    Ok(())
}

/// Show a file, a folder or (empty path) the worktree in the file manager.
#[tauri::command]
pub async fn reveal_path(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let abs = blocking(&vela, move |v| {
        fileops::absolute_path(v, &space_id, &repo, &path)
    })
    .await?;
    app.opener()
        .reveal_item_in_dir(&abs)
        .map_err(|e| AppError::new("open", e.to_string()))
}

/// Absolute path of a file, folder or (empty path) worktree, for "Copy path".
#[tauri::command]
pub async fn absolute_path(
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
) -> AppResult<String> {
    blocking(&vela, move |v| {
        fileops::absolute_path(v, &space_id, &repo, &path)
    })
    .await
}

/// Open a terminal in the folder (or the folder of the file). Returns the program started.
#[tauri::command]
pub async fn open_terminal(
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
) -> AppResult<String> {
    blocking(&vela, move |v| {
        fileops::open_terminal(v, &space_id, &repo, &path)
    })
    .await
}

#[tauri::command]
pub async fn rename_space(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    name: String,
) -> AppResult<Space> {
    let id = space_id.clone();
    let s = blocking(&vela, move |v| fileops::rename_space(v, &id, &name)).await?;
    notify(&app, &space_id, ChangeKind::State);
    Ok(s)
}

#[tauri::command]
pub async fn set_space_color(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    color: String,
) -> AppResult<Space> {
    let id = space_id.clone();
    let s = blocking(&vela, move |v| fileops::set_space_color(v, &id, &color)).await?;
    notify(&app, &space_id, ChangeKind::State);
    Ok(s)
}

#[tauri::command]
pub async fn archive_space(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
) -> AppResult<Space> {
    let id = space_id.clone();
    let s = blocking(&vela, move |v| fileops::archive_space(v, &id)).await?;
    notify(&app, &space_id, ChangeKind::State);
    Ok(s)
}

#[tauri::command]
pub async fn unarchive_space(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
) -> AppResult<Space> {
    let id = space_id.clone();
    let s = blocking(&vela, move |v| fileops::unarchive_space(v, &id)).await?;
    notify(&app, &space_id, ChangeKind::State);
    Ok(s)
}

#[tauri::command]
pub async fn list_archived(vela: State<'_, Vela>) -> AppResult<Vec<Space>> {
    blocking(&vela, fileops::list_archived).await
}

#[tauri::command]
pub async fn remove_space(
    app: AppHandle,
    vela: State<'_, Vela>,
    watchers: State<'_, Arc<Watchers>>,
    agents: State<'_, Arc<vela_agents::AgentManager>>,
    space_id: String,
) -> AppResult<()> {
    let id = space_id.clone();
    let mgr = agents.inner().clone();
    blocking(&vela, move |v| {
        // Their processes run in the worktrees about to go.
        if mgr.cancel_space(&id) > 0 {
            mgr.wait_idle_space(&id, std::time::Duration::from_secs(5));
        }
        fileops::remove_space(v, &id)
    })
    .await?;
    let (v, w, e) = (
        vela.inner().clone(),
        watchers.inner().clone(),
        emitter(&app),
    );
    let _ = tauri::async_runtime::spawn_blocking(move || w.sync(&v, &e)).await;
    notify(&app, &space_id, ChangeKind::State);
    Ok(())
}
