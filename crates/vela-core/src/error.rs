//! Error type of the core.

use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("git {args} failed: {stderr}")]
    Git { args: String, stderr: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("cannot read toml: {0}")]
    TomlDe(#[from] toml::de::Error),
    #[error("cannot write toml: {0}")]
    TomlSer(#[from] toml::ser::Error),
    #[error("not a git repository: {}", .0.display())]
    NotARepo(PathBuf),
    #[error("space already exists: {0}")]
    SpaceExists(String),
    #[error("space not found: {0}")]
    SpaceNotFound(String),
    #[error("repo not found in space: {0}")]
    RepoNotFound(String),
    #[error("hunk not found: {0}")]
    HunkNotFound(String),
    #[error("patch failed: {0}")]
    PatchFailed(String),
    #[error("nothing to commit: no repo has staged changes")]
    NothingToCommit,
    #[error("invalid space name: {0}")]
    InvalidName(String),
    #[error("a space needs at least one repo")]
    NoRepos,
    #[error("cannot locate the Vela home: set VELA_HOME or HOME")]
    NoHome,
    #[error("cannot parse git output: {0}")]
    Parse(String),
}
