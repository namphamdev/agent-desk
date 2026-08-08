//! Cross-platform test: custom-provider env vars injected at session start
//! reach the spawned ACP agent subprocess.
//!
//! The existing `acp.rs` integration suite is unix-only (fixture exec + libc).
//! This file mirrors the minimal harness–run–assert cycle on Windows by
//! launching the Python fixture through `python` instead of executing it
//! directly.

use std::path::PathBuf;
use std::time::Duration;

use comet_harness::{AcpHarness, Harness, RunControls};
use comet_proto::{RunRequest, SandboxLevel};
use futures::StreamExt;
use tokio::sync::{mpsc, oneshot};

/// Custom-provider env vars (`MODEL_PROVIDER`, `CODEX_CONFIG`, `CODEX_API_KEY`)
/// passed through the ACP command JSON's `"env"` field must reach the spawned
/// agent subprocess. This mirrors how agent-desk would inject a custom provider
/// at chat-send time: the env is built from the selected provider's config and
/// merged into the codex-acp launch environment.
#[tokio::test]
async fn passes_custom_provider_env_to_acp_agent() {
    let env_log = tempfile::NamedTempFile::new().unwrap();

    // Simulate the env codex-acp reads when a custom provider is selected.
    let codex_config = serde_json::json!({
        "model_provider": "custom",
        "model_providers": {
            "custom": {
                "name": "NP",
                "base_url": "https://api.np.example",
                "wire_api": "responses"
            }
        }
    })
    .to_string();

    #[cfg(not(unix))]
    let command = {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("fake-acp.py");
        serde_json::json!({
            "command": "python",
            "args": [script.to_string_lossy()],
            "env": {
                "FAKE_ACP_ENV_LOG": env_log.path().to_string_lossy(),
                "MODEL_PROVIDER": "custom",
                "CODEX_CONFIG": codex_config,
                "CODEX_API_KEY": "test-secret-key",
            }
        })
        .to_string()
    };

    #[cfg(unix)]
    let command = {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("fake-acp.py");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        serde_json::json!({
            "command": script,
            "env": {
                "FAKE_ACP_ENV_LOG": env_log.path().to_string_lossy(),
                "MODEL_PROVIDER": "custom",
                "CODEX_CONFIG": codex_config,
                "CODEX_API_KEY": "test-secret-key",
            }
        })
        .to_string()
    };

    let harness = AcpHarness::default().with_command(command);
    let (steer_tx, steer_rx) = mpsc::channel(1);
    let controls = RunControls {
        request_input: Box::new(|_| {
            let (_tx, rx) = oneshot::channel();
            rx
        }),
        steering: steer_rx,
        interrupt: comet_harness::CancellationToken::new(),
        report_memory: Box::new(|_| {}),
    };
    let request = RunRequest {
        prompt: "Say hello".into(),
        model: None,
        reasoning: None,
        model_options: serde_json::Map::new(),
        cwd: std::env::temp_dir().to_string_lossy().to_string(),
        sandbox: SandboxLevel::WorkspaceWrite,
        auto_approve: true,
        resume: None,
        attachments: vec![],
        seed: None,
        seed_role: None,
        seed_purpose: None,
        harness: None,
        acp_agent_id: None,
        custom_provider: None,
    };

    let stream = harness.run(request, controls).await.unwrap();
    drop(steer_tx);
    let _events = tokio::time::timeout(
        Duration::from_secs(15),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("ACP fixture should finish");

    // The fixture recorded the provider-related env vars it received.
    let log_contents = std::fs::read_to_string(env_log.path())
        .expect("env log file should exist after the session started");
    let recorded: serde_json::Value =
        serde_json::from_str(&log_contents).expect("env log should be valid JSON");

    assert_eq!(
        recorded["MODEL_PROVIDER"].as_str().unwrap(),
        "custom",
        "MODEL_PROVIDER env should reach the subprocess"
    );
    assert_eq!(
        recorded["CODEX_API_KEY"].as_str().unwrap(),
        "test-secret-key",
        "CODEX_API_KEY env should reach the subprocess"
    );

    // The CODEX_CONFIG JSON should contain the inline provider definition.
    let config_str = recorded["CODEX_CONFIG"]
        .as_str()
        .expect("CODEX_CONFIG should be a string");
    let config_json: serde_json::Value =
        serde_json::from_str(config_str).expect("CODEX_CONFIG should be valid JSON");
    assert_eq!(config_json["model_provider"], "custom");
    assert_eq!(config_json["model_providers"]["custom"]["name"], "NP");
    assert_eq!(
        config_json["model_providers"]["custom"]["base_url"],
        "https://api.np.example"
    );
    assert_eq!(
        config_json["model_providers"]["custom"]["wire_api"],
        "responses"
    );

    // Sanity: the harness completed without error.
    let _ = harness.models(None).await;
}
