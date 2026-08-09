//! Draft configuration types: the accumulated picks the composer threads
//! into the Run command and `Mutate createChat`.

use comet_proto::{ChatConfig, HarnessId, PermissionMode, ReasoningLevel};

// ---------------------------------------------------------------------------
// Draft config (what the pickers accumulate)
// ---------------------------------------------------------------------------

/// Everything a new chat is configured with before the first send. The folder
/// and device come from the selected SPACE — the draft only carries the git
/// extras (ref + checkout kind) and the run config.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DraftConfig {
    pub harness: Option<HarnessId>,
    pub model: Option<String>,
    pub reasoning: Option<ReasoningLevel>,
    /// option id → choice id (only non-defaults are meaningful).
    pub model_options: serde_json::Map<String, serde_json::Value>,
    pub permission_mode: PermissionMode,
    /// When `harness == Some(Acp)`, identifies the picked ACP agent.
    pub acp_agent_id: Option<String>,
    /// The picked ref (base branch in NewWorktree mode; a worktree's branch
    /// when reusing one). `None` = the repo's current branch.
    pub branch: Option<String>,
    /// Where the new session runs (the t3code env-mode).
    pub checkout: CheckoutKind,
}

/// Where a new session runs (t3code's env-mode: `local | worktree`). "Current
/// worktree" is NOT a third mode — it's `Local` when the picked ref is already
/// materialized as a worktree (the session reuses that checkout's path).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CheckoutKind {
    /// The space's own folder — or the picked ref's existing worktree.
    #[default]
    Local,
    /// A fresh isolated worktree created off the picked base ref on send.
    NewWorktree,
}

/// The resolved on-send checkout action (composer consumes this — see
/// [`Pickers::checkout_plan`]).
#[derive(Debug, Clone, PartialEq)]
pub enum CheckoutPlan {
    /// Run in the space folder as-is. `branch` is the checkout's branch (the
    /// picked or current ref), carried onto `createChat` so the session names
    /// it from the first frame; `None` = refs never loaded.
    CurrentCheckout { branch: Option<String> },
    /// Reuse the picked ref's existing worktree (a cwd override; no git).
    ReuseWorktree { path: String, branch: String },
    /// `CreateWorktree` off `base` on send (comet mints a `comet/<name>`
    /// branch). `base: None` = refs never loaded — send falls back to the
    /// space folder rather than failing.
    NewWorktree { base: Option<String> },
}

/// The fully-resolved run configuration the composer sends: concrete harness,
/// model and reasoning (never a "default" passthrough once the catalog is
/// loaded), plus the explicit non-default option picks.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResolvedRunConfig {
    pub harness: Option<HarnessId>,
    pub model: Option<String>,
    pub reasoning: Option<ReasoningLevel>,
    pub model_options: serde_json::Map<String, serde_json::Value>,
    pub permission_mode: PermissionMode,
    /// When `harness == Some(Acp)`, identifies the picked ACP agent.
    pub acp_agent_id: Option<String>,
}

impl ResolvedRunConfig {
    /// The `ChatConfig` recorded on `Mutate createChat` (needs a known harness).
    pub fn chat_config(&self) -> Option<ChatConfig> {
        Some(ChatConfig {
            harness: self.harness?,
            model: self.model.clone(),
            reasoning: self.reasoning,
            model_options: self.model_options.clone(),
            sandbox: self.permission_mode.sandbox(),
            permission_mode: self.permission_mode,
            acp_agent_id: self.acp_agent_id.clone(),
        })
    }
}
