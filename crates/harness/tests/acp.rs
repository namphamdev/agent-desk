#![cfg(unix)]

use std::path::PathBuf;
use std::time::Duration;

#[cfg(unix)]
use comet_harness::acp::sample_process_tree_rss_bytes;
use comet_harness::{AcpHarness, CancellationToken, Harness, RunControls, SteerMessage};
use comet_proto::{
    AgentEvent, DoneStatus, HarnessId, ReasoningLevel, RunRequest, SandboxLevel, ToolCall,
    UserInputAnswer,
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

#[cfg(unix)]
#[tokio::test]
async fn samples_live_process_tree_memory() {
    assert!(
        sample_process_tree_rss_bytes(std::process::id())
            .await
            .is_some_and(|bytes| bytes > 0)
    );
}

#[tokio::test]
async fn lists_models_exposed_by_the_acp_agent() {
    let harness = AcpHarness::with_command(fixture_path().display().to_string());
    let models = harness.models().await.unwrap();

    assert_eq!(
        models
            .iter()
            .map(|model| (model.id.as_str(), model.label.as_str()))
            .collect::<Vec<_>>(),
        vec![("acp-fast", "ACP Fast"), ("acp-smart", "ACP Smart")]
    );
    assert_eq!(models[1].description.as_deref(), Some("Smart model"));
    assert_eq!(
        models[0].reasoning_levels,
        vec![
            ReasoningLevel::Low,
            ReasoningLevel::Medium,
            ReasoningLevel::High,
            ReasoningLevel::XHigh,
        ]
    );
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
        report_memory: Box::new(|_| {}),
    };
    let request = RunRequest {
        prompt: "Say hello".into(),
        model: Some("acp-smart".into()),
        reasoning: Some(ReasoningLevel::High),
        model_options: serde_json::Map::new(),
        cwd: "/tmp".into(),
        sandbox: SandboxLevel::WorkspaceWrite,
        auto_approve: true,
        resume: None,
        attachments: vec![],
        seed: None,
        seed_role: None,
        seed_purpose: None,
    };

    let stream = harness.run(request, controls).await.unwrap();
    drop(steer_tx);
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("ACP fixture should finish");

    assert!(
        events.iter().any(|event| matches!(
            event,
            AgentEvent::SessionStarted {
                harness: HarnessId::Acp,
                model,
                session_id,
                ..
            } if model == "acp-smart" && session_id == "acp-session-1"
        )),
        "events: {events:#?}"
    );
    assert!(events.contains(&AgentEvent::ReasoningDelta {
        text: "Thinking".into(),
    }));
    assert!(events.contains(&AgentEvent::TextDelta {
        text: "Hello from ACP (high)".into(),
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

#[tokio::test]
async fn emits_a_turn_boundary_for_a_steer_after_completion() {
    let harness = AcpHarness::with_command(fixture_path().display().to_string());
    let (steer_tx, steer_rx) = mpsc::channel(1);
    let controls = RunControls {
        request_input: Box::new(|_| {
            let (_tx, rx) = oneshot::channel();
            rx
        }),
        steering: steer_rx,
        interrupt: CancellationToken::new(),
        report_memory: Box::new(|_| {}),
    };
    let request = RunRequest {
        prompt: "Say hello".into(),
        model: None,
        reasoning: None,
        model_options: serde_json::Map::new(),
        cwd: "/tmp".into(),
        sandbox: SandboxLevel::WorkspaceWrite,
        auto_approve: true,
        resume: None,
        attachments: vec![],
        seed: None,
        seed_role: None,
        seed_purpose: None,
    };

    let mut stream = harness.run(request, controls).await.unwrap();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), stream.next())
            .await
            .expect("ACP fixture should complete the initial prompt")
            .expect("stream should remain open")
            .unwrap();
        if matches!(event, AgentEvent::Done { .. }) {
            break;
        }
    }

    steer_tx
        .send(SteerMessage {
            prompt: "Say hello again".into(),
            message_id: None,
        })
        .await
        .unwrap();
    drop(steer_tx);
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("ACP fixture should finish the steered prompt");

    let boundary = events
        .iter()
        .position(|event| matches!(event, AgentEvent::Steered { .. }))
        .expect("steer after completion should start a new assistant message");
    let reply = events
        .iter()
        .position(|event| matches!(event, AgentEvent::TextDelta { .. }))
        .expect("steered prompt should produce text");
    assert!(boundary < reply, "events: {events:#?}");
}
