//! Where Vela keeps its files.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// Pure resolution of the home directory, so it can be tested without touching the environment.
pub fn resolve_home(
    vela_home: Option<OsString>,
    xdg_data_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<PathBuf> {
    let non_empty = |v: Option<OsString>| v.filter(|s| !s.is_empty());
    if let Some(v) = non_empty(vela_home) {
        return Ok(PathBuf::from(v));
    }
    if let Some(x) = non_empty(xdg_data_home) {
        return Ok(PathBuf::from(x).join("vela"));
    }
    if let Some(h) = non_empty(home) {
        return Ok(PathBuf::from(h).join(".local/share/vela"));
    }
    Err(Error::NoHome)
}

/// `VELA_HOME`, else `$XDG_DATA_HOME/vela`, else `~/.local/share/vela`.
pub fn home_from_env() -> Result<PathBuf> {
    resolve_home(
        std::env::var_os("VELA_HOME"),
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("HOME"),
    )
}

pub fn spaces_dir(home: &Path) -> PathBuf {
    home.join("spaces")
}

pub fn space_file(home: &Path, space: &str) -> PathBuf {
    spaces_dir(home).join(format!("{space}.toml"))
}

/// `worktrees/<space>`
pub fn space_root(home: &Path, space: &str) -> PathBuf {
    home.join("worktrees").join(space)
}

/// `worktrees/<space>/<repo>`
pub fn space_worktree(home: &Path, space: &str, repo: &str) -> PathBuf {
    space_root(home, space).join(repo)
}

/// `worktrees/<space>/.agents/<agent>/<repo>`
pub fn agent_worktree(home: &Path, space: &str, agent: &str, repo: &str) -> PathBuf {
    space_root(home, space)
        .join(".agents")
        .join(agent)
        .join(repo)
}
