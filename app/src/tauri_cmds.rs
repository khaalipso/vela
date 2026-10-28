//! Thin `#[tauri::command]` wrappers over `commands.rs`.
//!
//! Blocking git work runs on the blocking pool so the webview never waits on it.
//! The commands for notes, stack and gate return empty values until their milestones;
//! the UI renders them empty.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use vela_agents::registry::LogEntry;
use vela_agents::{AgentManager, HarnessInfo, QuestionView};
use vela_core::Vela;
use vela_core::model::{
    Agent, AgentUsage, CommitGroup, CommitPlan, CommitRules, FileChange, Hunk, Link, Problem,
    RepoChecks, RepoFiles, Space, StackItem,
};

use crate::agentrun::{self, Refresher};
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
        commands::invalidate_hunks(&space_id);
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
    commands::invalidate_hunks(space_id);
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
pub async fn create_repo(vela: State<'_, Vela>, parent: String, name: String) -> AppResult<String> {
    blocking(&vela, move |v| commands::create_repo(v, &parent, &name)).await
}

#[tauri::command]
pub fn default_repo_parent() -> String {
    commands::default_repo_parent()
}

#[tauri::command]
pub async fn declare_repo(vela: State<'_, Vela>, path: String) -> AppResult<Vec<String>> {
    blocking(&vela, move |v| commands::declare_repo(v, &path)).await
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
    branch: Option<String>,
    base: Option<String>,
) -> AppResult<Space> {
    let space = blocking(&vela, move |v| {
        commands::create_space(v, &name, &repos, branch.as_deref(), base.as_deref())
    })
    .await?;
    let (v, w, e) = (
        vela.inner().clone(),
        watchers.inner().clone(),
        emitter(&app),
    );
    let _ = tauri::async_runtime::spawn_blocking(move || w.sync(&v, &e)).await;
    Ok(space)
}

#[tauri::command]
pub async fn add_repo_to_space(
    app: AppHandle,
    vela: State<'_, Vela>,
    watchers: State<'_, Arc<Watchers>>,
    space_id: String,
    path: String,
) -> AppResult<Space> {
    let space = blocking(&vela, move |v| {
        commands::add_repo_to_space(v, &space_id, &path)
    })
    .await?;
    watchers.restart(&space, &emitter(&app));
    Ok(space)
}

#[tauri::command]
pub async fn remove_repo_from_space(
    app: AppHandle,
    vela: State<'_, Vela>,
    watchers: State<'_, Arc<Watchers>>,
    space_id: String,
    repo: String,
) -> AppResult<Space> {
    let space = blocking(&vela, move |v| {
        commands::remove_repo_from_space(v, &space_id, &repo)
    })
    .await?;
    watchers.restart(&space, &emitter(&app));
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
pub async fn discard_hunk(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    hunk_id: String,
) -> AppResult<()> {
    let sid = space_id.clone();
    blocking(&vela, move |v| commands::discard_hunk(v, &sid, &hunk_id)).await?;
    notify_state(&app, &space_id);
    Ok(())
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
pub async fn space_files(vela: State<'_, Vela>, space_id: String) -> AppResult<Vec<RepoFiles>> {
    blocking(&vela, move |v| commands::space_files(v, &space_id)).await
}

#[tauri::command]
pub async fn stage_file(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| commands::stage_file(v, &id, &repo, &path)).await?;
    notify_state(&app, &space_id);
    Ok(())
}

#[tauri::command]
pub async fn stage_files(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    files: Vec<(String, String)>,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| commands::stage_files(v, &id, &files)).await?;
    notify_state(&app, &space_id);
    Ok(())
}

#[tauri::command]
pub async fn unstage_files(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    files: Vec<(String, String)>,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| commands::unstage_files(v, &id, &files)).await?;
    notify_state(&app, &space_id);
    Ok(())
}

/// Accept several hunks at once (yours staged, proposals applied and staged).
#[tauri::command]
pub async fn accept_hunks(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    hunk_ids: Vec<String>,
) -> AppResult<Vec<String>> {
    let id = space_id.clone();
    let failed = blocking(&vela, move |v| commands::accept_hunks(v, &id, &hunk_ids)).await?;
    notify_state(&app, &space_id);
    Ok(failed)
}

/// One file of the Review: your file, what accepting gives, the last commit.
#[tauri::command]
pub async fn review_file(
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
) -> AppResult<commands::FileReview> {
    blocking(&vela, move |v| {
        commands::review_file(v, &space_id, &repo, &path)
    })
    .await
}

/// Accept one file: write what the Review shows (or `content`), stage it.
#[tauri::command]
pub async fn accept_file(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
    content: Option<String>,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| {
        commands::accept_file(v, &id, &repo, &path, content.as_deref())
    })
    .await?;
    notify_state(&app, &space_id);
    Ok(())
}

/// Accept several files as they are; returns the ones left for conflicts.
#[tauri::command]
pub async fn accept_files(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    files: Vec<(String, String)>,
) -> AppResult<Vec<String>> {
    let id = space_id.clone();
    let skipped = blocking(&vela, move |v| commands::accept_files(v, &id, &files)).await?;
    notify_state(&app, &space_id);
    Ok(skipped)
}

/// Reject what the agents propose in one file.
#[tauri::command]
pub async fn reject_file(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
) -> AppResult<usize> {
    let id = space_id.clone();
    let n = blocking(&vela, move |v| commands::reject_file(v, &id, &repo, &path)).await?;
    notify_state(&app, &space_id);
    Ok(n)
}

#[tauri::command]
pub async fn unstage_file(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    path: String,
) -> AppResult<()> {
    let id = space_id.clone();
    blocking(&vela, move |v| commands::unstage_file(v, &id, &repo, &path)).await?;
    notify_state(&app, &space_id);
    Ok(())
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

#[tauri::command]
pub async fn set_checks_auto(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    auto: bool,
) -> AppResult<()> {
    let sid = space_id.clone();
    blocking(&vela, move |v| {
        commands::set_checks_auto(v, &sid, &repo, auto)
    })
    .await?;
    notify_state(&app, &space_id);
    Ok(())
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

// -- agents -----------------------------------------------------------------

/// Emitter for agent events: `vela://agent` to every window, plus a debounced refresh of the
/// proposals when an agent writes files or ends a run.
pub fn agent_emitter(app: &AppHandle) -> vela_agents::Emit {
    let handle = app.clone();
    let send: Arc<dyn Fn(&vela_agents::Notice) + Send + Sync> = Arc::new(move |n| {
        let _ = handle.emit(agentrun::EVENT, n);
        crate::desktop::notify(&handle, n);
    });
    agentrun::sink(
        send,
        emitter(app),
        app.state::<Arc<Refresher>>().inner().clone(),
        agentrun::REFRESH_DEBOUNCE,
    )
}

/// Which harnesses are installed (`claude`, `codex`, `opencode`) and their versions.
#[tauri::command]
pub async fn harnesses(agents: State<'_, Arc<AgentManager>>) -> AppResult<Vec<HarnessInfo>> {
    let agents = agents.inner().clone();
    tauri::async_runtime::spawn_blocking(move || commands::harnesses(&agents))
        .await
        .map_err(|e| AppError::new("internal", e.to_string()))
}

/// Harness, tier and model each role gets by default in this space.
#[tauri::command]
pub async fn agent_defaults(
    vela: State<'_, Vela>,
    agents: State<'_, Arc<AgentManager>>,
    space_id: String,
) -> AppResult<Vec<commands::RoleDefault>> {
    let agents = agents.inner().clone();
    blocking(&vela, move |v| {
        commands::agent_defaults(v, &agents, &space_id)
    })
    .await
}

#[tauri::command]
pub async fn agents(
    vela: State<'_, Vela>,
    agents: State<'_, Arc<AgentManager>>,
    space_id: String,
) -> AppResult<Vec<Agent>> {
    let agents = agents.inner().clone();
    blocking(&vela, move |v| commands::agents(v, &agents, &space_id)).await
}

/// Why each proposed hunk exists, by hunk id.
#[tauri::command]
pub async fn reasons(
    vela: State<'_, Vela>,
    space_id: String,
) -> AppResult<std::collections::HashMap<String, String>> {
    blocking(&vela, move |v| commands::reasons(v, &space_id)).await
}

/// Start an agent. Progress arrives as `vela://agent` events.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ask_agent(
    app: AppHandle,
    vela: State<'_, Vela>,
    agents: State<'_, Arc<AgentManager>>,
    space_id: String,
    role: String,
    prompt: String,
    harness: Option<String>,
    tier: Option<String>,
) -> AppResult<Agent> {
    let agents = agents.inner().clone();
    let emit = agent_emitter(&app);
    blocking(&vela, move |v| {
        commands::ask_agent(
            v,
            &agents,
            &space_id,
            &role,
            &prompt,
            harness.as_deref(),
            tier.as_deref(),
            &emit,
        )
    })
    .await
}

/// The question an agent of the space waits on.
#[tauri::command]
pub async fn question(
    vela: State<'_, Vela>,
    agents: State<'_, Arc<AgentManager>>,
    space_id: String,
) -> AppResult<Option<QuestionView>> {
    let agents = agents.inner().clone();
    blocking(&vela, move |v| commands::question(v, &agents, &space_id)).await
}

/// Answer an agent: a resumed run of its session.
#[tauri::command]
pub async fn answer_agent(
    app: AppHandle,
    vela: State<'_, Vela>,
    agents: State<'_, Arc<AgentManager>>,
    space_id: String,
    agent: String,
    text: String,
) -> AppResult<Agent> {
    let agents = agents.inner().clone();
    let emit = agent_emitter(&app);
    blocking(&vela, move |v| {
        commands::answer_agent(v, &agents, &space_id, &agent, &text, &emit)
    })
    .await
}

#[tauri::command]
pub fn cancel_agent(agents: State<'_, Arc<AgentManager>>, space_id: String, agent: String) -> bool {
    commands::cancel_agent(&agents, &space_id, &agent)
}

#[tauri::command]
pub async fn agent_log(
    vela: State<'_, Vela>,
    agents: State<'_, Arc<AgentManager>>,
    space_id: String,
    agent: String,
) -> AppResult<Vec<LogEntry>> {
    let agents = agents.inner().clone();
    blocking(&vela, move |v| {
        commands::agent_log(v, &agents, &space_id, &agent)
    })
    .await
}

#[tauri::command]
pub async fn agent_usage(vela: State<'_, Vela>, space_id: String) -> AppResult<AgentUsage> {
    blocking(&vela, move |v| commands::agent_usage(v, &space_id)).await
}

/// Apply a proposal of an agent to your worktree and stage it.
#[tauri::command]
pub async fn accept_proposal(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    hunk_id: String,
) -> AppResult<Hunk> {
    let sid = space_id.clone();
    let h = blocking(&vela, move |v| commands::accept_proposal(v, &sid, &hunk_id)).await?;
    notify_state(&app, &space_id);
    Ok(h)
}

// -- later milestones: empty or neutral --------------------------------------

/// The notes of the reviewer and security agents of the space.
#[tauri::command]
pub async fn notes(
    vela: State<'_, Vela>,
    agents: State<'_, Arc<AgentManager>>,
    space_id: String,
) -> AppResult<Vec<vela_agents::notes::Note>> {
    let agents = agents.inner().clone();
    blocking(&vela, move |v| commands::notes(v, &agents, &space_id)).await
}

/// Send a note to its author (or a new developer agent) for a fix.
#[tauri::command]
pub async fn ask_fix(
    app: AppHandle,
    vela: State<'_, Vela>,
    agents: State<'_, Arc<AgentManager>>,
    space_id: String,
    note_id: String,
) -> AppResult<Agent> {
    let agents = agents.inner().clone();
    let emit = agent_emitter(&app);
    let sid = space_id.clone();
    let a = blocking(&vela, move |v| {
        commands::ask_fix(v, &agents, &sid, &note_id, &emit)
    })
    .await?;
    notify_state(&app, &space_id);
    Ok(a)
}

/// The comment threads of the space.
#[tauri::command]
pub async fn comments(
    vela: State<'_, Vela>,
    agents: State<'_, Arc<AgentManager>>,
    space_id: String,
) -> AppResult<Vec<vela_agents::comments::CommentView>> {
    let agents = agents.inner().clone();
    blocking(&vela, move |v| commands::comments(v, &agents, &space_id)).await
}

/// Comment a line: an agent answers.
#[tauri::command]
pub async fn add_comment(
    app: AppHandle,
    vela: State<'_, Vela>,
    agents: State<'_, Arc<AgentManager>>,
    space_id: String,
    comment: commands::NewComment,
) -> AppResult<()> {
    let agents = agents.inner().clone();
    let emit = agent_emitter(&app);
    let sid = space_id.clone();
    blocking(&vela, move |v| {
        commands::add_comment(v, &agents, &sid, &comment, &emit)
    })
    .await?;
    notify_state(&app, &space_id);
    Ok(())
}

/// Answer in a comment thread.
#[tauri::command]
pub async fn reply_comment(
    app: AppHandle,
    vela: State<'_, Vela>,
    agents: State<'_, Arc<AgentManager>>,
    space_id: String,
    thread: String,
    text: String,
) -> AppResult<()> {
    let agents = agents.inner().clone();
    let emit = agent_emitter(&app);
    let sid = space_id.clone();
    blocking(&vela, move |v| {
        commands::reply_comment(v, &agents, &sid, &thread, &text, &emit)
    })
    .await?;
    notify_state(&app, &space_id);
    Ok(())
}

#[tauri::command]
pub async fn resolve_comment(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    thread: String,
    resolved: bool,
) -> AppResult<()> {
    let sid = space_id.clone();
    blocking(&vela, move |v| {
        commands::resolve_comment(v, &sid, &thread, resolved)
    })
    .await?;
    notify_state(&app, &space_id);
    Ok(())
}

#[tauri::command]
pub async fn delete_comment(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    thread: String,
) -> AppResult<()> {
    let sid = space_id.clone();
    blocking(&vela, move |v| commands::delete_comment(v, &sid, &thread)).await?;
    notify_state(&app, &space_id);
    Ok(())
}

#[tauri::command]
pub async fn resolve_note(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    note_id: String,
    resolved: bool,
) -> AppResult<()> {
    let sid = space_id.clone();
    blocking(&vela, move |v| {
        commands::resolve_note(v, &sid, &note_id, resolved)
    })
    .await?;
    notify_state(&app, &space_id);
    Ok(())
}

/// Model and effort of each tier, per harness.
#[tauri::command]
pub async fn agent_tiers(
    agents: State<'_, Arc<AgentManager>>,
) -> AppResult<Vec<commands::HarnessTiers>> {
    let agents = agents.inner().clone();
    tauri::async_runtime::spawn_blocking(move || commands::agent_tiers(&agents))
        .await
        .map_err(|e| AppError::new("internal", e.to_string()))
}

#[tauri::command]
pub async fn agent_prompts(
    agents: State<'_, Arc<AgentManager>>,
) -> AppResult<Vec<commands::RolePrompt>> {
    let agents = agents.inner().clone();
    tauri::async_runtime::spawn_blocking(move || commands::agent_prompts(&agents))
        .await
        .map_err(|e| AppError::new("internal", e.to_string()))
}

#[tauri::command]
pub async fn set_agent_prompt(
    agents: State<'_, Arc<AgentManager>>,
    role: String,
    text: Option<String>,
) -> AppResult<()> {
    let agents = agents.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        commands::set_agent_prompt(&agents, &role, text.as_deref())
    })
    .await
    .map_err(|e| AppError::new("internal", e.to_string()))?
}

/// Models to suggest for a harness (slow the first time for opencode, then cached).
#[tauri::command]
pub async fn agent_models(
    agents: State<'_, Arc<AgentManager>>,
    harness: String,
) -> AppResult<Vec<String>> {
    let agents = agents.inner().clone();
    tauri::async_runtime::spawn_blocking(move || commands::agent_models(&agents, &harness))
        .await
        .map_err(|e| AppError::new("internal", e.to_string()))
}

#[tauri::command]
pub async fn set_agent_tier(
    agents: State<'_, Arc<AgentManager>>,
    harness: String,
    tier: String,
    model: Option<String>,
    effort: Option<String>,
) -> AppResult<()> {
    let agents = agents.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        commands::set_agent_tier(
            &agents,
            &harness,
            &tier,
            model.as_deref(),
            effort.as_deref(),
        )
    })
    .await
    .map_err(|e| AppError::new("internal", e.to_string()))?
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

// -- terminals ---------------------------------------------------------------

/// Start a shell in the worktree of `repo` (or the first repo, or the space directory).
#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    vela: State<'_, Vela>,
    terms: State<'_, Arc<crate::term::Terminals>>,
    space_id: String,
    repo: Option<String>,
    cols: u16,
    rows: u16,
) -> AppResult<u64> {
    let space = vela_core::store::load(&vela, &space_id)?;
    let cwd = repo
        .as_deref()
        .and_then(|r| space.repos.iter().find(|x| x.name == r))
        .or(space.repos.first())
        .map(|r| std::path::PathBuf::from(&r.worktree))
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| vela_core::paths::space_root(&vela.home, &space_id));
    let handle = app.clone();
    let emit: crate::term::EmitTerm = Arc::new(move |e| {
        let _ = handle.emit(crate::term::EVENT, e);
    });
    terms.inner().open(cwd, cols, rows, emit)
}

#[tauri::command]
pub fn term_write(
    terms: State<'_, Arc<crate::term::Terminals>>,
    id: u64,
    data: String,
) -> AppResult<()> {
    terms.write(id, &data)
}

#[tauri::command]
pub fn term_resize(
    terms: State<'_, Arc<crate::term::Terminals>>,
    id: u64,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    terms.resize(id, cols, rows)
}

#[tauri::command]
pub fn term_close(terms: State<'_, Arc<crate::term::Terminals>>, id: u64) {
    terms.close(id);
}

// -- pull requests -------------------------------------------------------------

/// The PR of the space branch in each repo (GitHub CLI).
#[tauri::command]
pub async fn pull_requests(
    vela: State<'_, Vela>,
    space_id: String,
) -> AppResult<Vec<crate::prs::RepoPr>> {
    blocking(&vela, move |v| {
        let space = vela_core::store::load(v, &space_id)?;
        Ok(crate::prs::space_prs(&space))
    })
    .await
}

/// Push the space branch of `repo` and open a PR. Returns its URL.
#[tauri::command]
pub async fn create_pull_request(
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    draft: bool,
) -> AppResult<String> {
    blocking(&vela, move |v| {
        let space = vela_core::store::load(v, &space_id)?;
        crate::prs::create_pr(&space, &repo, draft)
    })
    .await
}

#[tauri::command]
pub async fn comment_pull_request(
    vela: State<'_, Vela>,
    space_id: String,
    repo: String,
    body: String,
) -> AppResult<()> {
    blocking(&vela, move |v| {
        let space = vela_core::store::load(v, &space_id)?;
        crate::prs::comment_pr(&space, &repo, &body)
    })
    .await
}

// -- branches ----------------------------------------------------------------

#[tauri::command]
pub async fn repo_branches(
    vela: State<'_, Vela>,
    path: String,
) -> AppResult<Vec<vela_core::branches::BranchInfo>> {
    blocking(&vela, move |_| commands::repo_branches(&path)).await
}

#[tauri::command]
pub fn branch_naming(agents: State<'_, Arc<AgentManager>>, name: String) -> commands::BranchNaming {
    commands::branch_naming(agents.config_dir(), &name)
}

#[tauri::command]
pub fn set_branch_template(
    agents: State<'_, Arc<AgentManager>>,
    template: String,
) -> AppResult<commands::BranchNaming> {
    commands::set_branch_template(agents.config_dir(), &template)
}

#[tauri::command]
pub async fn rename_branch(
    app: AppHandle,
    vela: State<'_, Vela>,
    space_id: String,
    branch: String,
) -> AppResult<Space> {
    let sid = space_id.clone();
    let s = blocking(&vela, move |v| commands::rename_branch(v, &sid, &branch)).await?;
    notify_state(&app, &space_id);
    Ok(s)
}

#[tauri::command]
pub async fn push_branch(vela: State<'_, Vela>, space_id: String) -> AppResult<Vec<String>> {
    blocking(&vela, move |v| commands::push_branch(v, &space_id)).await
}
