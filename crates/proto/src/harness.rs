use serde::{Deserialize, Serialize};

use crate::agent::HarnessId;

/// The health status of one harness's external binary (result of
/// `CheckHarnessHealth` RPC).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessHealth {
    /// The harness this health report is for.
    pub id: HarnessId,
    /// Human-readable harness name.
    pub name: String,
    /// Whether the binary is directly installed and resolvable.
    pub installed: bool,
    /// Whether an npx fallback is available (binary not installed but npx
    /// can download it on demand). Always `false` when `installed` is `true`.
    #[serde(default)]
    pub npx_fallback: bool,
    /// When `installed` or `npx_fallback`, the binary can be used; when both
    /// are `false`, the user must install it.
    pub available: bool,
    /// The npm package to install for this harness (for the Install button).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_package: Option<String>,
    /// A short user-facing message describing the current state.
    pub message: String,
}

/// The result of an install attempt (result of `InstallHarness` RPC).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessInstallResult {
    pub id: HarnessId,
    /// Whether the binary is now resolvable (installed successfully).
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The combined stdout+stderr from the install command, trimmed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessOptimization {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source_label: String,
    pub source_url: String,
    pub applied: bool,
    pub details: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHarness {
    pub project: String,
    pub cwd: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub has_claude_md: bool,
    pub has_agents_md: bool,
    pub optimizations: Vec<HarnessOptimization>,
    pub applied_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyHarnessResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<ProjectHarness>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub written: Option<Vec<String>>,
}

impl ApplyHarnessResult {
    pub fn success(harness: ProjectHarness, written: Vec<String>) -> Self {
        Self {
            ok: true,
            error: None,
            harness: Some(harness),
            written: Some(written),
        }
    }

    pub fn failure(error: String) -> Self {
        Self {
            ok: false,
            error: Some(error),
            harness: None,
            written: None,
        }
    }
}
