#![cfg(unix)]

use std::path::PathBuf;
use std::time::Duration;

use comet_harness::{AcpHarness, CancellationToken, Harness, RunControls};
use comet_proto::{
    AgentEvent, DoneStatus, HarnessId, RunRequest, SandboxLevel, ToolCall, UserInputAnswer,
};
use futures::StreamExt;
use tokio::sync::{mpsc, oneshot};

fn fixture_path() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("fake-acp.py");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[tokio::test]
async fn streams_and_normalizes_an_acp_session() {
    let harness = AcpHarness::with_command(fixture_path().display().to_string());
    let (steer_tx, steer_rx) = mpsc::channel(1);
    let controls = RunControls {
        request_input: Box::new(|questions| {
            let (tx, rx) = oneshot::channel();
            let _ = tx.send(
                questions
                    .into_iter()
                    .map(|question| UserInputAnswer {
                        question_id: question.id,
                        labels: vec![],
                    })
                    .collect(),
            );
            rx
        }),
        steering: steer_rx,
        interrupt: CancellationToken::new(),
    };
    let request = RunRequest {
        prompt: "Say hello".into(),
        model: Some("default".into()),
        reasoning: None,
        model_options: serde_json::Map::new(),
        cwd: "/tmp".into(),
        sandbox: SandboxLevel::WorkspaceWrite,
        auto_approve: true,
        resume: None,
        attachments: vec![],
    };

    let stream = harness.run(request, controls).await.unwrap();
    drop(steer_tx);
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("ACP fixture should finish");

    assert!(events.iter().any(|event| matches!(
        event,
        AgentEvent::SessionStarted {
            harness: HarnessId::Acp,
            session_id,
            ..
        } if session_id == "acp-session-1"
    )));
    assert!(events.contains(&AgentEvent::ReasoningDelta {
        text: "Thinking".into(),
    }));
    assert!(events.contains(&AgentEvent::TextDelta {
        text: "Hello from ACP".into(),
    }));
    assert!(events.contains(&AgentEvent::ToolCall {
        id: "tool-1".into(),
        call: ToolCall::Exec {
            command: "cargo test".into(),
        },
    }));
    assert!(events.contains(&AgentEvent::ToolResult {
        id: "tool-1".into(),
        is_error: false,
    }));
    assert!(events.contains(&AgentEvent::Done {
        status: DoneStatus::Completed,
        result: None,
        error: None,
        session_id: Some("acp-session-1".into()),
    }));
}
