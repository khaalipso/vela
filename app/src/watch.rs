//! File watching: one debounced watcher per space, emitting a change event.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{Debouncer, new_debouncer};
use serde::Serialize;
use vela_core::Vela;
use vela_core::git::git;
use vela_core::model::Space;
use vela_core::store;

pub const EVENT: &str = "vela://changed";
pub const DEBOUNCE: Duration = Duration::from_millis(200);

/// Mirrors `BackendEvent` of the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    /// Content of a file changed.
    File,
    /// The git index or HEAD changed.
    State,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub space_id: String,
    pub kind: ChangeKind,
}

/// One watched worktree: its root and the git dir that holds its `index` and `HEAD`.
#[derive(Debug, Clone)]
pub struct Root {
    pub worktree: PathBuf,
    pub git_dir: Option<PathBuf>,
}

/// Decide what a changed path means. `.git` internals count only for `index` and `HEAD`,
/// `node_modules` and `target` are noise.
pub fn classify(roots: &[Root], path: &Path) -> Option<ChangeKind> {
    for r in roots {
        if let Some(gd) = &r.git_dir
            && let Ok(rel) = path.strip_prefix(gd)
        {
            return match rel.to_str() {
                Some("index") | Some("HEAD") => Some(ChangeKind::State),
                _ => None,
            };
        }
        if let Ok(rel) = path.strip_prefix(&r.worktree) {
            let noisy = rel.components().any(|c| {
                matches!(
                    c.as_os_str().to_str(),
                    Some(".git") | Some("node_modules") | Some("target")
                )
            });
            return if noisy { None } else { Some(ChangeKind::File) };
        }
    }
    None
}

/// Fold the paths of one debounce batch: a state change wins over file changes.
pub fn classify_batch<'a>(
    roots: &[Root],
    paths: impl IntoIterator<Item = &'a Path>,
) -> Option<ChangeKind> {
    let mut out = None;
    for p in paths {
        match classify(roots, p) {
            Some(ChangeKind::State) => return Some(ChangeKind::State),
            Some(ChangeKind::File) => out = Some(ChangeKind::File),
            None => {}
        }
    }
    out
}

pub type Emit = Arc<dyn Fn(ChangeEvent) + Send + Sync>;

fn roots_of(space: &Space) -> Vec<Root> {
    space
        .repos
        .iter()
        .filter_map(|r| {
            let worktree = std::fs::canonicalize(&r.worktree).ok()?;
            let git_dir = git(&worktree, &["rev-parse", "--absolute-git-dir"])
                .ok()
                .and_then(|s| std::fs::canonicalize(s.trim()).ok());
            Some(Root { worktree, git_dir })
        })
        .collect()
}

type Handle = Debouncer<notify::RecommendedWatcher>;

/// The set of live watchers, keyed by space id.
#[derive(Default)]
pub struct Watchers {
    live: Mutex<HashMap<String, Handle>>,
}

impl Watchers {
    /// Start watchers for new spaces and drop those of spaces that are gone.
    pub fn sync(&self, vela: &Vela, emit: &Emit) {
        let Ok(spaces) = store::list(vela) else {
            return;
        };
        let Ok(mut live) = self.live.lock() else {
            return;
        };
        live.retain(|id, _| spaces.iter().any(|s| &s.id == id && !s.archived));
        for space in spaces.iter().filter(|s| !s.archived) {
            if live.contains_key(&space.id) {
                continue;
            }
            if let Some(h) = start(space, emit.clone()) {
                live.insert(space.id.clone(), h);
            }
        }
    }
}

impl Watchers {
    /// Watch the space again from scratch, after its repos changed.
    pub fn restart(&self, space: &Space, emit: &Emit) {
        let Ok(mut live) = self.live.lock() else {
            return;
        };
        live.remove(&space.id);
        if let Some(h) = start(space, emit.clone()) {
            live.insert(space.id.clone(), h);
        }
    }
}

fn start(space: &Space, emit: Emit) -> Option<Handle> {
    let roots = roots_of(space);
    if roots.is_empty() {
        return None;
    }
    let id = space.id.clone();
    let cb_roots = roots.clone();
    let mut deb = new_debouncer(
        DEBOUNCE,
        move |res: notify_debouncer_mini::DebounceEventResult| {
            let Ok(events) = res else { return };
            if let Some(kind) = classify_batch(&cb_roots, events.iter().map(|e| e.path.as_path())) {
                emit(ChangeEvent {
                    space_id: id.clone(),
                    kind,
                });
            }
        },
    )
    .ok()?;
    for r in &roots {
        let _ = deb.watcher().watch(&r.worktree, RecursiveMode::Recursive);
        if let Some(gd) = &r.git_dir {
            let _ = deb.watcher().watch(gd, RecursiveMode::NonRecursive);
        }
    }
    Some(deb)
}
