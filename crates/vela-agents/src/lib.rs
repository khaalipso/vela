//! Vela drives existing coding agent CLIs ("harnesses") instead of shipping its own.
//!
//! - [`driver`]: the [`AgentDriver`] contract, [`RunSpec`], [`RunHandle`] and the process plumbing.
//! - [`claude`], [`codex`], [`opencode`]: one driver and one stream parser each.
//! - [`event`]: the normalized [`AgentEvent`] every driver produces.
//! - [`tiers`]: role and tier to harness and model, from the layered config.
//! - [`detect`]: which harnesses are installed.
//! - [`worktree`]: the worktree and branch of each agent.
//! - [`proposals`]: the agents' changes as hunks the user accepts or rejects.
//! - [`registry`]: agents and their event logs on disk, restart recovery.
//! - [`manager`]: runs agents on background threads and ties it all together.

pub mod claude;
pub mod codex;
pub mod detect;
pub mod driver;
pub mod event;
pub mod manager;
pub mod opencode;
pub mod proposals;
pub mod registry;
pub mod tiers;
mod util;
pub mod worktree;

pub use claude::ClaudeDriver;
pub use codex::CodexDriver;
pub use detect::{HarnessInfo, detect};
pub use driver::{AgentDriver, LineParser, RunHandle, RunSpec, locate, parse_stream};
pub use event::AgentEvent;
pub use manager::{AgentManager, AskRequest, Drivers, Emit, Notice, QuestionView};
pub use opencode::OpencodeDriver;
pub use tiers::{Overrides, Resolved, resolve, resolve_pair};
