use serde::{Deserialize, Serialize};

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
