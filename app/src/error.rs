//! Errors that cross to the UI as `{ kind, message }`.

use serde::Serialize;
use vela_core::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub kind: String,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        AppError {
            kind: kind.to_string(),
            message: message.into(),
        }
    }

    /// A path that escapes the space worktrees.
    pub fn forbidden(message: impl Into<String>) -> Self {
        AppError::new("forbidden_path", message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        AppError::new("invalid_input", message)
    }

    /// A feature that arrives in a later milestone.
    pub fn unsupported(message: impl Into<String>) -> Self {
        AppError::new("unsupported", message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<Error> for AppError {
    fn from(e: Error) -> Self {
        let kind = match &e {
            Error::Git { .. } => "git",
            Error::Io(_) => "io",
            Error::TomlDe(_) | Error::TomlSer(_) | Error::Parse(_) => "parse",
            Error::NotARepo(_) => "not_a_repo",
            Error::SpaceExists(_) => "space_exists",
            Error::SpaceNotFound(_) => "space_not_found",
            Error::RepoNotFound(_) => "repo_not_found",
            Error::HunkNotFound(_) => "hunk_not_found",
            Error::PatchFailed(_) => "patch_failed",
            Error::NothingToCommit => "nothing_to_commit",
            Error::InvalidName(_) | Error::NoRepos | Error::Invalid(_) => "invalid_input",
            Error::LinkNotFound(_) => "link_not_found",
            Error::NoHome => "no_home",
        };
        AppError::new(kind, e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new("io", e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::new("parse", e.to_string())
    }
}
