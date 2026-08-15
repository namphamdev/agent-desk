//! `MinsweConfig` + `AgentConfig` — limits, timeout, cost tracking.
//!
//! Defaults mirror `src/minisweagent/config/default.yaml`. Every field is
//! overridable so tests can run with tight limits and a fast command timeout.

/// Per-run agent control knobs. `0` for the numeric limits means unlimited
/// (matching mini-swe-agent's convention).
#[derive(Debug, Clone, Copy)]
pub struct AgentConfig {
    /// Maximum model calls before the run ends. `0` = unlimited.
    pub step_limit: u32,
    /// USD spend ceiling; the run ends once exceeded. `0.0` = unlimited.
    /// (Cost is best-effort in this port — see [`MinsweConfig::track_cost`].)
    pub cost_limit: f64,
    /// Wall-clock budget in seconds. `0` = unlimited.
    pub wall_time_limit_secs: u32,
    /// Abort after this many consecutive format errors. `0` = unlimited.
    pub max_consecutive_format_errors: u32,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            step_limit: 0,
            cost_limit: 0.0,
            wall_time_limit_secs: 0,
            max_consecutive_format_errors: 3,
        }
    }
}

/// Top-level configuration for [`crate::MinsweHarness`].
#[derive(Debug, Clone)]
pub struct MinsweConfig {
    pub agent: AgentConfig,
    /// Per-command wall-clock timeout in seconds (default 30, matching
    /// `LocalEnvironmentConfig.timeout`).
    pub command_timeout_secs: u64,
    /// When true, attempt USD cost tracking. v1 reads token counts only and
    /// omits USD (no cost table) — the flag is reserved for a future table.
    pub track_cost: bool,
    /// Override the model id; otherwise taken from `RunRequest.model`.
    pub model: Option<String>,
}

impl Default for MinsweConfig {
    fn default() -> Self {
        Self {
            agent: AgentConfig::default(),
            command_timeout_secs: 30,
            track_cost: false,
            model: None,
        }
    }
}

impl MinsweConfig {
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_upstream() {
        let cfg = MinsweConfig::default();
        assert_eq!(cfg.agent.step_limit, 0);
        assert_eq!(cfg.agent.cost_limit, 0.0);
        assert_eq!(cfg.agent.wall_time_limit_secs, 0);
        assert_eq!(cfg.agent.max_consecutive_format_errors, 3);
        assert_eq!(cfg.command_timeout_secs, 30);
        assert!(!cfg.track_cost);
    }
}
