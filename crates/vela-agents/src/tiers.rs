//! Roles and tiers to a harness and a model, from the layered config.
//!
//! ```toml
//! [agents.tiers.claude]
//! high = "opus"
//! medium = "sonnet"
//! low = "haiku"
//!
//! [agents.roles]
//! planner = { tier = "high", harness = "claude" }
//! tester = { harness = "opencode" }
//! ```
//!
//! A tier with no model configured passes no model flag: the harness picks its default.

use vela_core::config::AgentsConfig;
use vela_core::model::{AgentRole, Tier};

/// The harnesses Vela can drive, in the order it falls back to them.
pub const HARNESSES: [&str; 3] = ["claude", "codex", "opencode"];

pub fn harness_label(name: &str) -> &str {
    match name {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "opencode",
        other => other,
    }
}

/// Default tier of a role (docs/HARNESS.md).
pub fn default_tier(role: AgentRole) -> Tier {
    match role {
        AgentRole::Planner | AgentRole::Reviewer | AgentRole::Debugger => Tier::High,
        AgentRole::Developer => Tier::Medium,
        AgentRole::Tester => Tier::Low,
    }
}

/// Default harness of a role when the config says nothing.
pub fn default_harness(_role: AgentRole) -> &'static str {
    "claude"
}

/// What a single request asks for on top of the role.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Overrides {
    pub harness: Option<String>,
    pub tier: Option<Tier>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub harness: String,
    pub tier: Tier,
    /// None: pass no model flag.
    pub model: Option<String>,
}

/// Pick the harness, tier and model for a role.
///
/// Order, first match wins: the request, the `[agents.roles]` entry, the built in default.
/// `available` (installed harnesses) only matters when the harness came from the config or
/// the default and is not installed: the first installed one, in [`HARNESSES`] order, is used.
/// A harness named by the request is never replaced.
pub fn resolve(
    cfg: &AgentsConfig,
    role: AgentRole,
    overrides: &Overrides,
    available: Option<&[String]>,
) -> Resolved {
    let entry = cfg.roles.get(role.as_str());
    let tier = overrides
        .tier
        .or_else(|| entry.and_then(|e| e.tier))
        .unwrap_or_else(|| default_tier(role));
    let mut harness = overrides
        .harness
        .clone()
        .or_else(|| entry.and_then(|e| e.harness.clone()))
        .unwrap_or_else(|| default_harness(role).to_string());
    if overrides.harness.is_none()
        && let Some(av) = available
        && !av.is_empty()
        && !av.contains(&harness)
        && let Some(first) = HARNESSES.iter().find(|h| av.iter().any(|a| a == *h))
    {
        harness = (*first).to_string();
    }
    let model = cfg
        .tiers
        .get(&harness)
        .and_then(|t| t.get(tier))
        .map(str::to_string);
    Resolved {
        harness,
        tier,
        model,
    }
}

/// [`resolve`] reduced to `(harness, model)`.
pub fn resolve_pair(
    cfg: &AgentsConfig,
    role: AgentRole,
    overrides: &Overrides,
) -> (String, Option<String>) {
    let r = resolve(cfg, role, overrides, None);
    (r.harness, r.model)
}
