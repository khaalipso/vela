//! Vela core: spaces, git, proposals, stack and AI config.
//!
//! State lives under a [`Vela`] handle (the home directory) so tests and
//! embedders never depend on the global `VELA_HOME` variable.

use std::path::{Path, PathBuf};

pub mod checks;
pub mod commit;
pub mod commitplan;
pub mod config;
pub mod diff;
pub mod error;
pub mod git;
pub mod links;
pub mod model;
pub mod paths;
pub mod space;
pub mod stage;
pub mod status;
pub mod store;
pub mod upnext;

pub use error::{Error, Result};

/// Handle on a Vela home directory.
#[derive(Debug, Clone)]
pub struct Vela {
    pub home: PathBuf,
}

impl Vela {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Vela { home: home.into() }
    }

    /// Home from `VELA_HOME`, `XDG_DATA_HOME` or `~/.local/share/vela`.
    pub fn from_env() -> Result<Self> {
        Ok(Vela::new(paths::home_from_env()?))
    }

    pub fn home(&self) -> &Path {
        &self.home
    }
}
