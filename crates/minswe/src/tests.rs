//! Integration tests for the mini agent run loop (`agent::run_session`).
//!
//! Drives [`run_session`] with a [`MockModelClient`] and a real
//! [`LocalEnvironment`] pointed at a tempdir: a scripted 2-step trajectory
//! (`ls` → submit) produces the expected `AgentEvent` stream end-to-end,
//! plus a format-error-recovery case.

#![cfg(test)]

use std::sync::Arc;

use comet_harness::{Harness, RunControls, SteerMessage};
use comet_proto::{AgentEvent, DoneStatus, HarnessId, RunRequest, SandboxLevel, ToolCall};

use crate::config::{AgentConfig, MinsweConfig};
use crate::environment::LocalEnvironment;
use crate::model::{BashAction, MockModelClient, MockTurn, TokenUsage};

async fn collect_stream(
    stream: futures::stream::BoxStream<'static, Result<AgentEvent, comet_harness::HarnessError>>,
) -> Vec<AgentEvent> {
    use futures::StreamExt;
    stream
        .filter_map(|r| async move { r.ok() })
        .collect::<Vec<_>>()
        .await
}

/// Build a RunRequest rooted at a tempdir.
fn request(tempdir: &tempfile::TempDir, prompt: &str) -> RunRequest {
    RunRequest {
        prompt: prompt.into(),
        harness: Some(HarnessId::Minswe),
        model: Some("mock".into()),
        reasoning: None,
        model_options: serde_json::Map::new(),
        cwd: tempdir.path().to_string_lossy().into_owned(),
        sandbox: SandboxLevel::WorkspaceWrite,
        auto_approve: false,
        resume: None,
        seed: None,
        seed_purpose: None,
        seed_role: None,
        acp_agent_id: None,
        attachments: vec![],
        custom_provider: None,
    }
}

/// A no-op RunControls: no steering, an interrupt that never fires, and a
/// report_memory that records the final None call.
fn controls() -> (
    RunControls,
    tokio::sync::mpsc::Sender<SteerMessage>,
    comet_harness::CancellationToken,
) {
    let (steer_tx, steer_rx) = tokio::sync::mpsc::channel(8);
    let interrupt = comet_harness::CancellationToken::new();
    let controls = RunControls {
        request_input: Box::new(|_| {
            let (_tx, rx) = tokio::sync::oneshot::channel();
            rx
        }),
        steering: steer_rx,
        interrupt: interrupt.clone(),
        report_memory: Box::new(|_| {}),
    };
    (controls, steer_tx, interrupt)
}

#[tokio::test]
async fn two_step_trajectory_submits() {
    let tempdir = tempfile::tempdir().unwrap();
    // Step 1: ls the dir. Step 2: emit the sentinel → Completed with the
    // submission payload.
    let mock = Arc::new(MockModelClient::new(vec![
        MockTurn::turn(
            Some("listing files".into()),
            vec![BashAction {
                tool_call_id: "c1".into(),
                command: "ls".into(),
            }],
        ),
        MockTurn::turn(
            Some("done".into()),
            vec![BashAction {
                tool_call_id: "c2".into(),
                command: "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT".into(),
            }],
        ),
    ]));
    let harness = crate::MinsweHarness::with_mock_model(
        MinsweConfig {
            agent: AgentConfig::default(),
            command_timeout_secs: 10,
            track_cost: false,
            model: None,
        },
        mock.clone(),
    );
    let (controls, _steer, _interrupt) = controls();
    let stream = Harness::run(&harness, request(&tempdir, "do the task"), controls)
        .await
        .unwrap();
    let events = collect_stream(stream).await;

    // SessionStarted, TextDelta(listing files), Usage, ToolCall(Exec ls),
    // ToolResult, TextDelta(done), [Usage], ToolCall(Exec echo SENTINEL),
    // ToolResult, Done(Completed).
    assert!(
        events.iter().any(|e| matches!(
            e,
            AgentEvent::SessionStarted {
                harness: HarnessId::Minswe,
                ..
            }
        )),
        "expected SessionStarted: {events:?}"
    );
    let tool_calls: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCall {
                call: ToolCall::Exec { command },
                ..
            } => Some(command.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(tool_calls, vec!["ls", "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"]);

    let done = events.iter().find_map(|e| match e {
        AgentEvent::Done {
            status,
            result,
            ..
        } => Some((*status, result.clone())),
        _ => None,
    });
    let (status, result) = done.expect("a Done event");
    assert_eq!(status, DoneStatus::Completed);
    assert!(result.unwrap_or_default().is_empty(), "submission body");

    // The mock was queried exactly twice.
    assert_eq!(
        mock.call_index
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
}

#[tokio::test]
async fn format_error_then_valid_action_recovers() {
    let tempdir = tempfile::tempdir().unwrap();
    // Turn 1: no actions (format error). Turn 2: a valid submit.
    let mock = Arc::new(MockModelClient::new(vec![
        MockTurn::format_error("No tool calls found in the response."),
        MockTurn::turn(
            None,
            vec![BashAction {
                tool_call_id: "c1".into(),
                command: "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT".into(),
            }],
        ),
    ]));
    let harness = crate::MinsweHarness::with_mock_model(
        MinsweConfig {
            agent: AgentConfig::default(),
            command_timeout_secs: 10,
            track_cost: false,
            model: None,
        },
        mock,
    );
    let (controls, _steer, _interrupt) = controls();
    let stream = Harness::run(&harness, request(&tempdir, "task"), controls)
        .await
        .unwrap();
    let events = collect_stream(stream).await;

    // A format-error event was emitted, then recovery → Completed.
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::Error { .. })),
        "expected an Error event from the format error: {events:?}"
    );
    let done = events.iter().find_map(|e| match e {
        AgentEvent::Done { status, .. } => Some(*status),
        _ => None,
    });
    assert_eq!(done, Some(DoneStatus::Completed));
}

#[tokio::test]
async fn repeated_format_errors_errored() {
    let tempdir = tempfile::tempdir().unwrap();
    // Every turn is a format error; the default ceiling is 3 → Errored.
    let mock = Arc::new(MockModelClient::new(vec![MockTurn::format_error(
        "No tool calls found in the response.",
    )]));
    let harness = crate::MinsweHarness::with_mock_model(
        MinsweConfig {
            agent: AgentConfig {
                max_consecutive_format_errors: 3,
                ..AgentConfig::default()
            },
            command_timeout_secs: 10,
            track_cost: false,
            model: None,
        },
        mock,
    );
    let (controls, _steer, _interrupt) = controls();
    let stream = Harness::run(&harness, request(&tempdir, "task"), controls)
        .await
        .unwrap();
    let events = collect_stream(stream).await;
    let done = events.iter().find_map(|e| match e {
        AgentEvent::Done { status, error, .. } => Some((*status, error.clone())),
        _ => None,
    });
    let (status, error) = done.expect("a Done event");
    assert_eq!(status, DoneStatus::Errored);
    assert_eq!(error.as_deref(), Some("RepeatedFormatError"));
}

#[tokio::test]
async fn step_limit_ends_run() {
    let tempdir = tempfile::tempdir().unwrap();
    let mock = Arc::new(MockModelClient::new(vec![MockTurn::turn(
        Some("loop".into()),
        vec![BashAction {
            tool_call_id: "c1".into(),
            command: "true".into(),
        }],
    )]));
    let harness = crate::MinsweHarness::with_mock_model(
        MinsweConfig {
            agent: AgentConfig {
                step_limit: 2,
                ..AgentConfig::default()
            },
            command_timeout_secs: 5,
            track_cost: false,
            model: None,
        },
        mock,
    );
    let (controls, _steer, _interrupt) = controls();
    let stream = Harness::run(&harness, request(&tempdir, "task"), controls)
        .await
        .unwrap();
    let events = collect_stream(stream).await;
    let done = events.iter().find_map(|e| match e {
        AgentEvent::Done { status, .. } => Some(*status),
        _ => None,
    });
    // Step limit is not a failure: the run ends Completed (no submission).
    assert_eq!(done, Some(DoneStatus::Completed));
}
