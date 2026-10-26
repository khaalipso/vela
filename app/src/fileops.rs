//! File and space operations behind the right-click menus: create, rename, delete (system
//! trash), discard, reveal, open a terminal, and the space-level edits. Plain functions over a
//! [`Vela`] handle, like `commands.rs`; `tauri_menu.rs` wraps them.
//!
//! Every path goes through [`resolve_path`]: inside a space worktree only, never `.git`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use vela_core::git::git;
use vela_core::model::{ChangeKind, Space};
use vela_core::{Vela, space, status, store};

use crate::commands::resolve_path;
use crate::error::{AppError, AppResult};

fn load(vela: &Vela, id: &str) -> AppResult<Space> {
    Ok(store::load(vela, id)?)
}

fn io(e: std::io::Error) -> AppError {
    AppError::new("io", e.to_string())
}

/// What happened to a deleted path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Disposal {
    /// Moved to the system trash, it can be restored from there.
    Trashed,
    /// Removed for good.
    Deleted,
}

/// Moves a path to the system trash.
pub type Trasher<'a> = &'a dyn Fn(&Path) -> Result<(), String>;

/// The freedesktop / OS trash through the `trash` crate.
pub fn system_trash(p: &Path) -> Result<(), String> {
    trash::delete(p).map_err(|e| e.to_string())
}

fn worktree(space: &Space, repo: &str) -> AppResult<PathBuf> {
    let r = space
        .repos
        .iter()
        .find(|r| r.name == repo)
        .ok_or_else(|| vela_core::Error::RepoNotFound(repo.to_string()))?;
    fs::canonicalize(&r.worktree).map_err(io)
}

/// A path in the worktree, or the worktree root itself when `path` is empty.
pub fn resolve_or_root(space: &Space, repo: &str, path: &str) -> AppResult<PathBuf> {
    if path.is_empty() {
        worktree(space, repo)
    } else {
        resolve_path(space, repo, path)
    }
}

/// The absolute path of a file, folder or (with an empty path) repo worktree, for copy and reveal.
pub fn absolute_path(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<String> {
    let space = load(vela, id)?;
    Ok(resolve_or_root(&space, repo, path)?
        .to_string_lossy()
        .into_owned())
}

// ---------------------------------------------------------------------------
// Create, rename, delete
// ---------------------------------------------------------------------------

fn check_name(path: &str) -> AppResult<()> {
    let last = path.rsplit('/').next().unwrap_or("");
    if last.is_empty() || last == "." || last == ".." || path.chars().any(char::is_control) {
        return Err(AppError::invalid(format!("invalid name: {path:?}")));
    }
    Ok(())
}

/// Create an empty file (and its folders). Refuses to touch one that exists.
pub fn create_file(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<()> {
    let space = load(vela, id)?;
    check_name(path)?;
    let full = resolve_path(&space, repo, path)?;
    if fs::symlink_metadata(&full).is_ok() {
        return Err(AppError::invalid(format!("{path} already exists")));
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(io)?;
    }
    fs::write(&full, "").map_err(io)
}

/// Create a folder (and its parents). Git only shows it once it holds a file.
pub fn create_dir(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<()> {
    let space = load(vela, id)?;
    check_name(path)?;
    let full = resolve_path(&space, repo, path)?;
    if fs::symlink_metadata(&full).is_ok() {
        return Err(AppError::invalid(format!("{path} already exists")));
    }
    fs::create_dir_all(&full).map_err(io)
}

/// Move a file or folder inside the worktree. The target must not exist.
pub fn rename_path(vela: &Vela, id: &str, repo: &str, from: &str, to: &str) -> AppResult<()> {
    let space = load(vela, id)?;
    check_name(to)?;
    let src = resolve_path(&space, repo, from)?;
    let dst = resolve_path(&space, repo, to)?;
    if fs::symlink_metadata(&src).is_err() {
        return Err(AppError::invalid(format!("{from} does not exist")));
    }
    if fs::symlink_metadata(&dst).is_ok() {
        return Err(AppError::invalid(format!("{to} already exists")));
    }
    if dst.starts_with(&src) {
        return Err(AppError::invalid("cannot move a folder into itself"));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(io)?;
    }
    fs::rename(&src, &dst).map_err(io)
}

fn remove_for_good(p: &Path) -> AppResult<()> {
    let meta = fs::symlink_metadata(p).map_err(io)?;
    if meta.is_dir() {
        fs::remove_dir_all(p).map_err(io)
    } else {
        fs::remove_file(p).map_err(io)
    }
}

/// Delete a file or folder: to the system trash, or for good with `permanent`. When the trash
/// is not available the error kind is `no_trash`, and the UI asks before calling again with
/// `permanent`.
pub fn delete_path_with(
    vela: &Vela,
    id: &str,
    repo: &str,
    path: &str,
    permanent: bool,
    trash: Trasher,
) -> AppResult<Disposal> {
    let space = load(vela, id)?;
    let full = resolve_path(&space, repo, path)?;
    if fs::symlink_metadata(&full).is_err() {
        return Err(AppError::invalid(format!("{path} does not exist")));
    }
    if permanent {
        remove_for_good(&full)?;
        return Ok(Disposal::Deleted);
    }
    trash(&full).map_err(|e| AppError::new("no_trash", format!("no system trash: {e}")))?;
    Ok(Disposal::Trashed)
}

pub fn delete_path(
    vela: &Vela,
    id: &str,
    repo: &str,
    path: &str,
    permanent: bool,
) -> AppResult<Disposal> {
    delete_path_with(vela, id, repo, path, permanent, &system_trash)
}

// ---------------------------------------------------------------------------
// Discard
// ---------------------------------------------------------------------------

/// Throw away the changes in the worktree for one file. A tracked file goes back to HEAD (or to
/// the index when part of it is staged, so staged work survives); an untracked file is deleted
/// (to the trash when it can).
pub fn discard_file_with(
    vela: &Vela,
    id: &str,
    repo: &str,
    path: &str,
    trash: Trasher,
) -> AppResult<()> {
    let space = load(vela, id)?;
    let full = resolve_path(&space, repo, path)?;
    let change = status::space_status(&space)?
        .into_iter()
        .find(|c| c.repo == repo && c.path == path);
    let Some(change) = change else {
        return Err(AppError::invalid(format!("{path} has no changes")));
    };
    if change.unstaged.is_none() {
        return Err(AppError::invalid(format!(
            "{path} has no unstaged changes; unstage it first"
        )));
    }
    if change.unstaged == Some(ChangeKind::Untracked) {
        if trash(&full).is_err() {
            remove_for_good(&full)?;
        }
        return Ok(());
    }
    let dir = worktree(&space, repo)?;
    if change.staged.is_some() {
        git(&dir, &["restore", "--worktree", "--", path])?;
    } else {
        git(
            &dir,
            &["restore", "--worktree", "--source=HEAD", "--", path],
        )?;
    }
    Ok(())
}

pub fn discard_file(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<()> {
    discard_file_with(vela, id, repo, path, &system_trash)
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

/// Terminals tried after `$TERMINAL` and `xdg-terminal-exec`.
pub const TERMINALS: &[&str] = &[
    "x-terminal-emulator",
    "ghostty",
    "kitty",
    "alacritty",
    "foot",
    "wezterm",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "xterm",
];

/// The command that opens a terminal: `$TERMINAL` (may carry arguments), else
/// `xdg-terminal-exec`, else the first common terminal found. `exists` says if a program is on
/// the PATH. Pure, so the order is tested without a desktop.
pub fn terminal_command(
    env_terminal: Option<&str>,
    exists: &dyn Fn(&str) -> bool,
) -> Option<Vec<String>> {
    if let Some(t) = env_terminal.map(str::trim).filter(|t| !t.is_empty()) {
        let parts: Vec<String> = t.split_whitespace().map(String::from).collect();
        if exists(&parts[0]) {
            return Some(parts);
        }
    }
    std::iter::once("xdg-terminal-exec")
        .chain(TERMINALS.iter().copied())
        .find(|t| exists(t))
        .map(|t| vec![t.to_string()])
}

pub fn on_path(program: &str) -> bool {
    if program.contains('/') {
        return Path::new(program).is_file();
    }
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(program).is_file()))
        .unwrap_or(false)
}

/// Directory to open a terminal in: the folder itself, or the parent of a file.
pub fn terminal_dir(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<PathBuf> {
    let space = load(vela, id)?;
    let full = resolve_or_root(&space, repo, path)?;
    if full.is_dir() {
        Ok(full)
    } else {
        full.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| AppError::invalid(format!("no folder for {path}")))
    }
}

/// Spawn a terminal in `dir`, detached. Returns the program used.
pub fn spawn_terminal(dir: &Path, cmd: &[String]) -> AppResult<String> {
    let (prog, args) = cmd
        .split_first()
        .ok_or_else(|| AppError::new("no_terminal", "no terminal found"))?;
    Command::new(prog)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AppError::new("no_terminal", format!("cannot start {prog}: {e}")))?;
    Ok(prog.clone())
}

pub fn open_terminal(vela: &Vela, id: &str, repo: &str, path: &str) -> AppResult<String> {
    let dir = terminal_dir(vela, id, repo, path)?;
    let env = std::env::var("TERMINAL").ok();
    let cmd = terminal_command(env.as_deref(), &on_path).ok_or_else(|| {
        AppError::new(
            "no_terminal",
            "no terminal found: set $TERMINAL or install one",
        )
    })?;
    spawn_terminal(&dir, &cmd)
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

pub fn rename_space(vela: &Vela, id: &str, name: &str) -> AppResult<Space> {
    Ok(space::rename(vela, id, name)?)
}

pub fn set_space_color(vela: &Vela, id: &str, color: &str) -> AppResult<Space> {
    Ok(space::set_color(vela, id, color)?)
}

pub fn archive_space(vela: &Vela, id: &str) -> AppResult<Space> {
    Ok(space::archive(vela, id)?)
}

pub fn unarchive_space(vela: &Vela, id: &str) -> AppResult<Space> {
    Ok(space::unarchive(vela, id)?)
}

/// Spaces hidden from the rail, oldest first.
pub fn list_archived(vela: &Vela) -> AppResult<Vec<Space>> {
    Ok(store::list(vela)?
        .into_iter()
        .filter(|s| s.archived)
        .collect())
}

/// Remove a space: its worktrees go, its branch is deleted only when fully merged.
pub fn remove_space(vela: &Vela, id: &str) -> AppResult<()> {
    space::remove(vela, id)?;
    let rejected = vela_core::paths::spaces_dir(&vela.home).join(format!("{id}.rejected.json"));
    let _ = fs::remove_file(rejected);
    Ok(())
}
