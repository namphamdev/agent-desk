use serde::{Deserialize, Serialize};

/// One agent published by the official ACP registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    /// Optional logo/icon URL (typically an SVG) published by the registry.
    #[serde(default)]
    pub icon: Option<String>,
    /// Whether this device has a usable distribution for the agent.
    pub supported: bool,
    /// `binary`, `npx`, or `uvx` when supported.
    #[serde(default)]
    pub distribution: Option<String>,
}

/// A registry agent configured on this device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAcpAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub command: String,
    pub distribution: String,
    /// Optional logo/icon URL (typically an SVG). Registry agents copy this
    /// from the catalog entry; custom agents carry a user-supplied URL.
    #[serde(default)]
    pub icon: Option<String>,
}

/// Device-local ACP settings and the current registry catalog.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentsSnapshot {
    #[serde(default)]
    pub active_agent_id: Option<String>,
    #[serde(default)]
    pub installed: Vec<InstalledAcpAgent>,
    #[serde(default)]
    pub registry: Vec<AcpRegistryAgent>,
    #[serde(default)]
    pub registry_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_round_trips_over_rpc_json() {
        let snapshot = AcpAgentsSnapshot {
            active_agent_id: Some("agent".into()),
            installed: vec![InstalledAcpAgent {
                id: "agent".into(),
                name: "Agent".into(),
                version: "1.0.0".into(),
                command: r#"{"command":"agent"}"#.into(),
                distribution: "binary".into(),
                icon: Some("https://example.com/icon.svg".into()),
            }],
            registry: vec![AcpRegistryAgent {
                id: "agent".into(),
                name: "Agent".into(),
                version: "1.0.0".into(),
                description: "Test.".into(),
                repository: None,
                website: None,
                icon: None,
                supported: true,
                distribution: Some("binary".into()),
            }],
            registry_error: None,
        };
        let decoded: AcpAgentsSnapshot =
            serde_json::from_value(serde_json::to_value(&snapshot).unwrap()).unwrap();
        assert_eq!(decoded, snapshot);
    }
}
