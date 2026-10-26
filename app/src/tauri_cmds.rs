//! Thin `#[tauri::command]` wrappers over `commands.rs`.
//!
//! Blocking git work runs on the blocking pool so the webview never waits on it.
//! The commands for agents, notes, questions, stack and gate return empty values until
//! their milestones; the UI renders them empty.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use vela_core::Vela;
use vela_core::model::{
    Agent, CommitGroup, CommitPlan, CommitRules, FileChange, Hunk, Link, Problem, RepoChecks,
    Space, StackItem,
};

use crate::checkrun::{self, CheckEvent, CheckRunner, EmitCheck};
use crate::commands::{self, CommitResult, FileRef};
use crate::error::{AppError, AppResult};
use crate::watch::{self, ChangeEvent, ChangeKind, Emit, Watchers};

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

/// Emitter that broadcasts the change event to every window. A change of the index or HEAD
/// also schedules the automatic rerun of the checks (debounced).
pub fn emitter(app: &AppHandle) -> Emit {
    let app = app.clone();
    Arc::new(move |e: ChangeEvent| {
        let auto = e.kind == ChangeKind::State;
        let space_id = e.space_id.clone();
        let _ = app.emit(watch::EVENT, e);
        if auto {
            let vela = app.state::<Vela>().inner().clone();
            let runner = app.state::<Arc<CheckRunner>>().inner().clone();
            runner.schedule_auto(&vela, &space_id, &check_emitter(&app));
        }
    })
}

/// Emitter that broadcasts check events (`vela://check`) to every window.
pub fn check_emitter(app: &AppHandle) -> EmitCheck {
    let app = app.clone();
    Arc::new(move |e: CheckEvent| {
        let _ = app.emit(checkrun::EVENT, e);
    })
}

fn notify_state(app: &AppHandle, space_id: &str) {
    let _ = app.emit(
        watch::EVENT,
        ChangeEvent {
            space_id: space_id.to_string(),
            kind: ChangeKind::State,
        },
    );
}

pub fn window_label(space_id: &str) -> String {
    format!("space-{space_id}")
}

// -- spaces -----------------------------------------------------------------

#[tauri::command]
pub async fn list_repos(vela: State<'_, Vela>) -> AppResult<Vec<String>> {
    blocking(&vela, commands::list_repos).await
}

#[tauri::command]
pub async fn list_spaces(vela: State<'_, Vela>) -> AppResult<Vec<Space>> {
    blocking(&vela, commands::list_spaces).await
}

#[tauri::command]
pub async fn create_space(
    app: AppHandle,
    vela: State<'_, Vela>,
    watchers: State<'_, Arc<Watchers>>,
    name: String,
    repos: Vec<String>,
) -> AppResult<Space> {
    let space = blocking(&vela, move |v| commands::create_space(v, &name, &repos)).await?;
    let (v, w, e) = (
        vela.inner().clone(),
        watchers.inner().clone(),
        emitter(&app),
    );
    let _ = tauri::async_runtime::spawn_blocking(move || w.sync(&v, &e)).await;
    Ok(space)
}

/// Store the window of a space. `None` also closes its own window if one is open.
#[tauri::command]
pub async fn set_window(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    window: Option<u32>,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| commands::set_window(v, &id, window)).await?;
    if window.is_none()
        && let Some(w) = app.get_webview_window(&window_label(&space_id))
    {
        let _ = w.close();
    }
    notify_state(&app, &space_id);
    Ok(())
}

/// Open the space in its own window: label `space-<id>`, same UI, pinned by the URL hash.
#[tauri::command]
pub async fn open_space_window(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
) -> AppResult<()> {
    let label = window_label(&space_id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let id = space_id.clone();
    let space = blocking(&vela, move |v| {
        let s = vela_core::store::load(v, &id)?;
        let n = commands::next_window(v)?;
        commands::set_window(v, &id, Some(n))?;
        Ok(s)
    })
    .await?;
    let hash = format!("#{label}");
    let script = format!(
        "if (!location.hash.startsWith('#space-')) location.hash = {};",
        serde_json::to_string(&hash).unwrap_or_default()
    );
    let built = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html{hash}").into()),
    )
    .title(format!("Vela · {}", space.name))
    .inner_size(1280.0, 860.0)
    .decorations(true)
    .initialization_script(script)
    .build();
    if let Err(e) = built {
        let id = space_id.clone();
        let _ = blocking(&vela, move |v| commands::set_window(v, &id, None)).await;
        return Err(AppError::new("window", e.to_string()));
    }
    notify_state(&app, &space_id);
    Ok(())
}

// -- status, hunks, files ---------------------------------------------------

#[tauri::command]
pub async fn status(vela: State<'_, Vela>, space_id: String) -> AppResult<Vec<FileChange>> {
    blocking(&vela, move |v| commands::status(v, &space_id)).await
}

#[tauri::command]
pub async fn hunks(vela: State<'_, Vela>, space_id: String) -> AppResult<Vec<Hunk>> {
    blocking(&vela, move |v| commands::hunks(v, &space_id)).await
}

#[tauri::command]
pub async fn stage_hunk(
    vela: State<'_, Vela>,
    space_id: String,
    hunk_id: String,
) -> AppResult<Hunk> {
    blocking(&vela, move |v| commands::stage_hunk(v, &space_id, &hunk_id)).await
}

/// Accept and edit: the same as staging, the UI then opens the lines in the editor.
#[tauri::command]
pub async fn edit_hunk(
    vela: State<'_, Vela>,
    space_id: String,
    hunk_id: String,
) -> AppResult<Hunk> {
    blocking(&vela, move |v| commands::stage_hunk(v, &space_id, &hunk_id)).await
}

#[tauri::command]
pub async fn unstage_hunk(
    vela: State<'_, Vela>,
    space_id: String,
    hunk_id: String,
) -> AppResult<Hunk> {
    blocking(&vela, move |v| {
        commands::unstage_hunk(v, &space_id, &hunk_id)
    })
    .await
}

#[tauri::command]
pub async fn reject_hunk(
    vela: State<'_, Vela>,
    space_id: String,
    hunk_id: String,
) -> AppResult<Hunk> {
    blocking(&vela, move |v| {
        commands::reject_hunk(v, &space_id, &hunk_id)
    })
    .await
}

#[tauri::command]
pub async fn list_files(vela: State<'_, Vela>, space_id: String) -> AppResult<Vec<FileRef>> {
    blocking(&vela, move |v| commands::list_files(v, &space_id)).await
}

#[tauri::command]
pub async fn read_file(
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
) -> AppResult<String> {
    blocking(&vela, move |v| {
        commands::read_file(v, &space_id, &repo, &path)
    })
    .await
}

#[tauri::command]
pub async fn write_file(
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
    content: String,
) -> AppResult<()> {
    blocking(&vela, move |v| {
        commands::write_file(v, &space_id, &repo, &path, &content)
    })
    .await
}

// -- commit -----------------------------------------------------------------

#[tauri::command]
pub async fn draft_commit(vela: State<'_, Vela>, space_id: String) -> AppResult<String> {
    blocking(&vela, move |v| commands::draft_commit(v, &space_id)).await
}

#[tauri::command]
pub async fn commit(
    vela: State<'_, Vela>,
    space_id: String,
    message: String,
    override_reason: Option<String>,
) -> AppResult<CommitResult> {
    blocking(&vela, move |v| {
        commands::commit(v, &space_id, &message, override_reason.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn commit_plan(vela: State<'_, Vela>, space_id: String) -> AppResult<CommitPlan> {
    blocking(&vela, move |v| commands::commit_plan(v, &space_id)).await
}

#[tauri::command]
pub fn validate_message(
    message: String,
    rules: CommitRules,
    conventional: Option<bool>,
) -> Vec<Problem> {
    commands::validate_message(&message, &rules, conventional.unwrap_or(true))
}

#[tauri::command]
pub async fn commit_groups(
    vela: State<'_, Vela>,
    space_id: String,
    groups: Vec<CommitGroup>,
    conventional: Option<bool>,
    override_reason: Option<String>,
) -> AppResult<CommitResult> {
    blocking(&vela, move |v| {
        commands::commit_groups(
            v,
            &space_id,
            conventional.unwrap_or(true),
            groups,
            override_reason.as_deref(),
        )
    })
    .await
}

// -- links ------------------------------------------------------------------

#[tauri::command]
pub async fn links(vela: State<'_, Vela>, space_id: String) -> AppResult<Vec<Link>> {
    blocking(&vela, move |v| commands::list_links(v, &space_id)).await
}

#[tauri::command]
pub async fn add_link(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    url: String,
    title: Option<String>,
    source: Option<String>,
) -> AppResult<Link> {
    let id = space_id.clone();
    let link = blocking(&vela, move |v| {
        commands::add_link(v, &id, &url, title.as_deref(), source.as_deref())
    })
    .await?;
    notify_state(&app, &space_id);
    Ok(link)
}

#[tauri::command]
pub async fn remove_link(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    link_id: String,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| commands::remove_link(v, &id, &link_id)).await?;
    notify_state(&app, &space_id);
    Ok(())
}

/// Open a link in the default browser. Only http and https.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let url = commands::check_openable(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::new("open", e.to_string()))
}

// -- checks -----------------------------------------------------------------

#[tauri::command]
pub async fn checks(
    vela: State<'_, Vela>,
    runner: State<'_, Arc<CheckRunner>>,
    space_id: String,
) -> AppResult<Vec<RepoChecks>> {
    let runner = runner.inner().clone();
    blocking(&vela, move |v| commands::checks(v, &runner, &space_id)).await
}

/// Start checks in the background. Progress arrives as `vela://check` events.
#[tauri::command]
pub async fn run_checks(
    app: AppHandle,
    vela: State<'_, Vela>,
    runner: State<'_, Arc<CheckRunner>>,
    space_id: String,
    ids: Option<Vec<String>>,
    force: Option<bool>,
) -> AppResult<Vec<(String, String)>> {
    let runner = runner.inner().clone();
    let emit = check_emitter(&app);
    blocking(&vela, move |v| {
        commands::run_checks(
            v,
            &runner,
            &space_id,
            ids.as_deref(),
            force.unwrap_or(false),
            &emit,
        )
    })
    .await
}

#[tauri::command]
pub async fn check_log(
    vela: State<'_, Vela>,
    runner: State<'_, Arc<CheckRunner>>,
    space_id: String,
    repo: String,
    id: String,
) -> AppResult<String> {
    let runner = runner.inner().clone();
    blocking(&vela, move |v| {
        commands::check_log(v, &runner, &space_id, &repo, &id)
    })
    .await
}

#[tauri::command]
pub async fn set_check_enabled(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    id: String,
    enabled: bool,
) -> AppResult<()> {
    let sid = space_id.clone();
    blocking(&vela, move |v| {
        commands::set_check_enabled(v, &sid, &repo, &id, enabled)
    })
    .await?;
    notify_state(&app, &space_id);
    Ok(())
}

// -- later milestones: empty or neutral --------------------------------------

/// TODO(M2): agents.
#[tauri::command]
pub fn agents(_space_id: String) -> Vec<Agent> {
    Vec::new()
}

/// TODO(M2): reasons agents give for their proposals.
#[tauri::command]
pub fn reasons(_space_id: String) -> std::collections::HashMap<String, String> {
    std::collections::HashMap::new()
}

/// TODO(M2): launch an agent CLI in its own worktree.
#[tauri::command]
pub fn ask_agent(_space_id: String, _role: String, _prompt: String) -> AppResult<Agent> {
    Err(AppError::unsupported("agents arrive in a later milestone"))
}

/// TODO(M2): a question an agent waits on.
#[tauri::command]
pub fn question(_space_id: String) -> Option<serde_json::Value> {
    None
}

/// TODO(M2): answer an agent.
#[tauri::command]
pub fn answer_agent(_space_id: String, _yes: bool) -> AppResult<()> {
    Err(AppError::unsupported("no agent is waiting for an answer"))
}

/// TODO(M3): reviewer notes.
#[tauri::command]
pub fn notes(_space_id: String) -> Vec<serde_json::Value> {
    Vec::new()
}

/// TODO(M4): ask the author to fix a reviewer note.
#[tauri::command]
pub fn ask_fix(_space_id: String, _hunk_id: String) -> AppResult<()> {
    Err(AppError::unsupported("there is no reviewer note to fix"))
}

/// TODO(M3): runtimes and containers of the space.
#[tauri::command]
pub fn stack(_space_id: String) -> Vec<StackItem> {
    Vec::new()
}

/// TODO(M4): the commit gate. No checks yet.
#[tauri::command]
pub fn run_gate(_space_id: String) -> Vec<serde_json::Value> {
    Vec::new()
}
