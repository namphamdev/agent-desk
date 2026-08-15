#![cfg(unix)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(unix)]
use comet_harness::acp::sample_process_tree_rss_bytes;
use comet_harness::{AcpHarness, CancellationToken, Harness, RunControls, SteerMessage};
use comet_proto::{
    AgentEvent, DoneStatus, HarnessId, ReasoningLevel, RunRequest, SandboxLevel, ToolCall,
    UserInputAnswer, UserInputQuestion,
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

fn exiting_fixture_command() -> String {
    serde_json::json!({
        "command": fixture_path(),
        "env": { "FAKE_ACP_EXIT_AFTER_SESSION_NEW": "1" },
    })
    .to_string()
}

fn mcp_rejecting_fixture_command() -> String {
    serde_json::json!({
        "command": fixture_path(),
        "env": { "FAKE_ACP_REJECT_MCP": "1" },
    })
    .to_string()
}

fn process_cpu_time() -> Duration {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
        0
    );
    let usage = unsafe { usage.assume_init() };
    let micros = |time: libc::timeval| {
        (time.tv_sec as u64)
            .saturating_mul(1_000_000)
            .saturating_add(time.tv_usec as u64)
    };
    Duration::from_micros(micros(usage.ru_utime) + micros(usage.ru_stime))
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
    let harness = AcpHarness::new().with_command(fixture_path().display().to_string());
    let models = harness.models(None).await.unwrap();

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
async fn caches_models_discovered_from_the_acp_agent() {
    let log = tempfile::NamedTempFile::new().unwrap();
    let harness = AcpHarness::new().with_command(
        serde_json::json!({
            "command": fixture_path(),
            "env": { "FAKE_ACP_DISCOVERY_LOG": log.path() },
        })
        .to_string(),
    );

    let first = harness.models(None).await.unwrap();
    let second = harness.models(None).await.unwrap();

    assert_eq!(first, second);
    assert_eq!(
        std::fs::read_to_string(log.path()).unwrap(),
        "session/new\n"
    );
}

/// Grok's `grok agent stdio` ACP server advertises auth methods on initialize
/// and rejects `session/new` until the client sends `authenticate`. The
/// harness must complete that handshake before model discovery, or the picker
/// only ever shows "Agent default".
#[tokio::test]
async fn authenticates_before_model_discovery_when_the_agent_requires_auth() {
    let auth_log = tempfile::NamedTempFile::new().unwrap();
    let command = serde_json::json!({
        "command": fixture_path(),
        "env": {
            "FAKE_ACP_REQUIRE_AUTH": "1",
            "FAKE_ACP_AUTH_LOG": auth_log.path(),
        },
    })
    .to_string();
    let harness = AcpHarness::new().with_command(command);
    let models = harness.models(None).await.unwrap();

    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["acp-fast", "acp-smart"]
    );

    // The harness picked the locally-authenticated method and passed
    // `headless: true`, mirroring the official Grok client flow.
    let recorded: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(auth_log.path()).expect("auth log should exist"),
    )
    .expect("auth log should be valid JSON");
    assert_eq!(recorded["methodId"], "cached_token");
    assert_eq!(recorded["_meta"]["headless"], true);
}

/// The same handshake must happen on the live-run path (`run`), not just
/// during discovery: a session that starts without `authenticate` is rejected
/// by Grok.
#[tokio::test]
async fn authenticates_before_running_a_session_when_the_agent_requires_auth() {
    let harness = AcpHarness::new().with_command(
        serde_json::json!({
            "command": fixture_path(),
            "env": { "FAKE_ACP_REQUIRE_AUTH": "1" },
        })
        .to_string(),
    );
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
        harness: None,
        acp_agent_id: None,
        custom_provider: None,
    };

    let stream = harness.run(request, controls).await.unwrap();
    drop(steer_tx);
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("ACP fixture should finish an authenticated session");

    assert!(events.contains(&AgentEvent::TextDelta {
        text: "Hello from ACP (medium)".into(),
    }));
}

/// When the agent's `authenticate` itself fails (e.g. no cached credentials),
/// discovery degrades to the single default model instead of surfacing a raw
/// protocol error — the picker still works, just without a model list.
#[tokio::test]
async fn falls_back_to_default_model_when_authentication_fails() {
    let harness = AcpHarness::new().with_command(
        serde_json::json!({
            "command": fixture_path(),
            "env": {
                "FAKE_ACP_REQUIRE_AUTH": "1",
                "FAKE_ACP_AUTH_FAIL": "1",
            },
        })
        .to_string(),
    );
    let models = harness.models(None).await.unwrap();

    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["default"]
    );
}

#[tokio::test]
async fn preserves_models_when_the_agent_exits_after_discovery() {
    let harness = AcpHarness::new().with_command(exiting_fixture_command());
    let models = harness.models(None).await.unwrap();

    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["acp-fast", "acp-smart"]
    );
}

#[tokio::test]
async fn does_not_attach_mcp_servers_during_model_discovery() {
    let harness = AcpHarness::new().with_command(mcp_rejecting_fixture_command())
        .with_mcp_server("http://127.0.0.1:6699/mcp");
    let models = harness.models(None).await.unwrap();

    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["acp-fast", "acp-smart"]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn parked_acp_session_does_not_busy_poll() {
    let harness = AcpHarness::new().with_command(fixture_path().display().to_string());
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
        harness: None,
        acp_agent_id: None,
        custom_provider: None,
    };

    let mut stream = harness.run(request, controls).await.unwrap();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), stream.next())
            .await
            .expect("ACP fixture should complete")
            .expect("parked ACP stream should remain open")
            .unwrap();
        if matches!(event, AgentEvent::Done { .. }) {
            break;
        }
    }

    let before = process_cpu_time();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let cpu = process_cpu_time().saturating_sub(before);
    assert!(
        cpu < Duration::from_millis(250),
        "idle ACP transport consumed {cpu:?} of CPU in 500ms"
    );

    drop(steer_tx);
}

#[tokio::test]
async fn streams_and_normalizes_an_acp_session() {
    let harness = AcpHarness::new().with_command(fixture_path().display().to_string());
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
        harness: None,
        acp_agent_id: None,
        custom_provider: None,
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

/// Grok Build sends its internal `ask_user_question` tool over a private ACP
/// extension method (`_x.ai/ask_user_question`) rather than the standard
/// `session/request_permission` or `elicitation/create` methods. The harness
/// must intercept that raw extension request, route it through the engine
/// input bridge, and answer with Grok's `accepted`/`cancelled` wire shape.
#[tokio::test]
async fn bridges_grok_ask_user_question_extension_method() {
    let response_log = tempfile::NamedTempFile::new().unwrap();
    let command = serde_json::json!({
        "command": fixture_path(),
        "env": {
            "FAKE_ACP_ASK_USER_QUESTION": "1",
            "FAKE_ACP_ASK_RESPONSE_LOG": response_log.path(),
        },
    })
    .to_string();
    let harness = AcpHarness::new().with_command(command);

    let seen = Arc::new(Mutex::new(Vec::<UserInputQuestion>::new()));
    let seen_input = seen.clone();
    let (steer_tx, steer_rx) = mpsc::channel(1);
    let controls = RunControls {
        request_input: Box::new(move |questions| {
            seen_input
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .extend(questions.iter().cloned());
            let (tx, rx) = oneshot::channel();
            let answers = questions
                .into_iter()
                .map(|question| UserInputAnswer {
                    question_id: question.id,
                    labels: if question.question == "Which database?" {
                        vec!["Redis".into()]
                    } else if question.question == "Which features?" {
                        vec!["Auth".into(), "Logging".into()]
                    } else {
                        vec![]
                    },
                })
                .collect();
            let _ = tx.send(answers);
            rx
        }),
        steering: steer_rx,
        interrupt: CancellationToken::new(),
        report_memory: Box::new(|_| {}),
    };
    let request = RunRequest {
        prompt: "Ask me something".into(),
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
        harness: None,
        acp_agent_id: None,
        custom_provider: None,
    };

    let stream = harness.run(request, controls).await.unwrap();
    drop(steer_tx);
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("ACP fixture should finish after the ask_user_question round-trip");

    let questions = seen
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_eq!(questions.len(), 2, "questions: {questions:#?}");
    assert_eq!(questions[0].question, "Which database?");
    assert_eq!(questions[0].options, vec!["Redis", "Postgres"]);
    assert!(!questions[0].multi_select);
    assert_eq!(questions[1].question, "Which features?");
    assert_eq!(questions[1].options, vec!["Auth", "Logging"]);
    assert!(questions[1].multi_select);

    let recorded: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(response_log.path()).expect("response log should exist"),
    )
    .expect("response log should be valid JSON");
    assert_eq!(recorded["result"]["outcome"], "accepted");
    assert_eq!(
        recorded["result"]["answers"]["Which database?"],
        serde_json::json!(["Redis"])
    );
    assert_eq!(
        recorded["result"]["answers"]["Which features?"],
        serde_json::json!(["Auth", "Logging"])
    );

    assert!(events.contains(&AgentEvent::Done {
        status: DoneStatus::Completed,
        result: None,
        error: None,
        session_id: Some("acp-session-1".into()),
    }));
}

/// Grok Build sends its internal `exit_plan_mode` tool over a private ACP
/// extension method (`_x.ai/exit_plan_mode`) rather than the standard
/// `session/request_permission` or `elicitation/create` methods. The harness
/// must intercept that raw extension request, surface the plan through the
/// engine input bridge as an approve/reject question, and answer with Grok's
/// `approved`/`rejected` wire shape.
#[tokio::test]
async fn bridges_grok_exit_plan_mode_extension_method() {
    let response_log = tempfile::NamedTempFile::new().unwrap();
    let command = serde_json::json!({
        "command": fixture_path(),
        "env": {
            "FAKE_ACP_EXIT_PLAN_MODE": "1",
            "FAKE_ACP_EXIT_PLAN_RESPONSE_LOG": response_log.path(),
        },
    })
    .to_string();
    let harness = AcpHarness::new().with_command(command);

    let seen = Arc::new(Mutex::new(Vec::<UserInputQuestion>::new()));
    let seen_input = seen.clone();
    let (steer_tx, steer_rx) = mpsc::channel(1);
    let controls = RunControls {
        request_input: Box::new(move |questions| {
            seen_input
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .extend(questions.iter().cloned());
            let (tx, rx) = oneshot::channel();
            // Approve the plan.
            let answers = questions
                .into_iter()
                .map(|question| UserInputAnswer {
                    question_id: question.id,
                    labels: vec!["Approve".into()],
                })
                .collect();
            let _ = tx.send(answers);
            rx
        }),
        steering: steer_rx,
        interrupt: CancellationToken::new(),
        report_memory: Box::new(|_| {}),
    };
    let request = RunRequest {
        prompt: "Plan something".into(),
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
        harness: None,
        acp_agent_id: None,
        custom_provider: None,
    };

    let stream = harness.run(request, controls).await.unwrap();
    drop(steer_tx);
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("ACP fixture should finish after the exit_plan_mode round-trip");

    let questions = seen
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_eq!(questions.len(), 1, "questions: {questions:#?}");
    assert_eq!(questions[0].question, "Approve this plan and start implementing?\n\n## Plan\n1. Refactor foo\n2. Add tests");
    assert_eq!(questions[0].options, vec!["Approve", "Reject"]);
    assert!(!questions[0].multi_select);
    drop(questions);

    let recorded: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(response_log.path()).expect("response log should exist"),
    )
    .expect("response log should be valid JSON");
    assert_eq!(recorded["result"]["outcome"], "approved");

    assert!(events.contains(&AgentEvent::Done {
        status: DoneStatus::Completed,
        result: None,
        error: None,
        session_id: Some("acp-session-1".into()),
    }));
}

/// When the user rejects the plan (or dismisses the prompt), the harness must
/// answer `{"outcome":"rejected"}` so the agent stays in plan mode instead of
/// silently proceeding to implement.
#[tokio::test]
async fn exit_plan_mode_rejection_replies_rejected_outcome() {
    let response_log = tempfile::NamedTempFile::new().unwrap();
    let command = serde_json::json!({
        "command": fixture_path(),
        "env": {
            "FAKE_ACP_EXIT_PLAN_MODE": "1",
            "FAKE_ACP_EXIT_PLAN_RESPONSE_LOG": response_log.path(),
        },
    })
    .to_string();
    let harness = AcpHarness::new().with_command(command);

    let (steer_tx, steer_rx) = mpsc::channel(1);
    let controls = RunControls {
        request_input: Box::new(move |questions| {
            let (tx, rx) = oneshot::channel();
            // Reject the plan (or, equivalently, return no labels).
            let answers = questions
                .into_iter()
                .map(|question| UserInputAnswer {
                    question_id: question.id,
                    labels: vec!["Reject".into()],
                })
                .collect();
            let _ = tx.send(answers);
            rx
        }),
        steering: steer_rx,
        interrupt: CancellationToken::new(),
        report_memory: Box::new(|_| {}),
    };
    let request = RunRequest {
        prompt: "Plan something".into(),
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
        harness: None,
        acp_agent_id: None,
        custom_provider: None,
    };

    let stream = harness.run(request, controls).await.unwrap();
    drop(steer_tx);
    let _ = tokio::time::timeout(
        Duration::from_secs(10),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("ACP fixture should finish after the exit_plan_mode round-trip");

    let recorded: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(response_log.path()).expect("response log should exist"),
    )
    .expect("response log should be valid JSON");
    assert_eq!(recorded["result"]["outcome"], "rejected");
}

#[tokio::test]
async fn emits_a_turn_boundary_for_a_steer_after_completion() {
    let harness = AcpHarness::new().with_command(fixture_path().display().to_string());
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
        harness: None,
        acp_agent_id: None,
        custom_provider: None,
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

/// A run with `resume: Some(id)` sends `session/load` first; the fixture
/// recognizes the id from its own prior `session/new` and returns the same
/// config options — proving the resume path uses the stored session id.
#[tokio::test]
async fn resumes_an_acp_session_via_session_load() {
    let harness = AcpHarness::new().with_command(fixture_path().display().to_string());
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
        resume: Some("acp-session-1".into()),
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
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("ACP fixture should finish resumed session");

    // The fixture returned the SAME session id from the load path — the
    // harness must emit it in SessionStarted and Done unchanged.
    assert!(
        events.iter().any(|event| matches!(
            event,
            AgentEvent::SessionStarted { session_id, .. } if session_id == "acp-session-1"
        )),
        "resumed session should preserve the loaded session id: {events:#?}"
    );
    assert!(events.contains(&AgentEvent::Done {
        status: DoneStatus::Completed,
        result: None,
        error: None,
        session_id: Some("acp-session-1".into()),
    }));
}

/// When `session/load` fails (unknown id), the harness falls back to
/// `session/new` — the user gets a fresh session with a new id.
#[tokio::test]
async fn falls_back_to_new_session_when_load_fails() {
    let command = serde_json::json!({
        "command": fixture_path(),
        "env": { "FAKE_ACP_LOAD_FAIL": "1" },
    })
    .to_string();
    let harness = AcpHarness::new().with_command(command);
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
        resume: Some("nonexistent-session".into()),
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
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("ACP fixture should finish fallback session");

    // The load failed, so the harness created a NEW session — the fixture
    // always mints "acp-session-1" for new sessions.
    assert!(
        events.iter().any(|event| matches!(
            event,
            AgentEvent::SessionStarted { session_id, .. } if session_id == "acp-session-1"
        )),
        "fallback should start a fresh session: {events:#?}"
    );
}

/// Verifies that custom-provider env vars (`MODEL_PROVIDER`, `CODEX_CONFIG`,
/// `CODEX_API_KEY`) passed through the ACP command JSON's `"env"` field reach
/// the spawned agent subprocess. This mirrors how agent-desk would inject a
/// custom provider at chat-send time: the env is built from the selected
/// provider's config and merged into the codex-acp launch environment.
#[tokio::test]
async fn passes_custom_provider_env_to_acp_agent() {
    let env_log = tempfile::NamedTempFile::new().unwrap();

    // Simulate the env that would be built when a user selects a custom
    // provider for Codex — these are the vars codex-acp reads.
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

    let command = serde_json::json!({
        "command": fixture_path(),
        "env": {
            "FAKE_ACP_ENV_LOG": env_log.path(),
            "MODEL_PROVIDER": "custom",
            "CODEX_CONFIG": codex_config,
            "CODEX_API_KEY": "test-secret-key",
        }
    })
    .to_string();

    let harness = AcpHarness::new().with_command(command);
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
        harness: None,
        acp_agent_id: None,
        custom_provider: None,
    };

    let stream = harness.run(request, controls).await.unwrap();
    drop(steer_tx);
    let _events = tokio::time::timeout(
        Duration::from_secs(10),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("ACP fixture should finish");

    // The fixture recorded the env vars it received. Verify the custom
    // provider env was delivered to the subprocess.
    let log_contents = std::fs::read_to_string(env_log.path())
        .expect("env log file should exist after the session started");
    let recorded: serde_json::Value =
        serde_json::from_str(&log_contents).expect("env log should be valid JSON");

    assert_eq!(recorded["MODEL_PROVIDER"], "custom");
    assert_eq!(recorded["CODEX_API_KEY"], "test-secret-key");

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
}

/// When an ACP agent streams text via `session/update` notifications but
/// never sends the `session/prompt` response (the grok-build-acp bug), the
/// idle watchdog must synthesize `Done(Completed)` instead of hanging forever.
#[tokio::test]
async fn completes_when_agent_goes_silent_without_prompt_response() {
    // SAFETY: `COMET_ACP_IDLE_TIMEOUT_SECS` is only read by the harness's
    // prompt-wait loop. Other tests' fixtures always send the prompt
    // response, so a shorter timeout doesn't affect them (the watchdog
    // never fires when the response arrives promptly).
    unsafe {
        std::env::set_var("COMET_ACP_IDLE_TIMEOUT_SECS", "2");
    }

    let command = serde_json::json!({
        "command": fixture_path(),
        "env": { "FAKE_ACP_NO_PROMPT_RESPONSE": "1" },
    })
    .to_string();
    let harness = AcpHarness::new().with_command(command);
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
        harness: None,
        acp_agent_id: None,
        custom_provider: None,
    };

    let stream = harness.run(request, controls).await.unwrap();
    drop(steer_tx);

    // With a 2-second idle timeout, the harness should synthesize Done
    // within a few seconds — not hang forever.
    let events = tokio::time::timeout(
        Duration::from_secs(15),
        stream.map(Result::unwrap).collect::<Vec<_>>(),
    )
    .await
    .expect("harness should synthesize completion after idle timeout, not hang");

    // Text was streamed before the agent went silent.
    assert!(events.contains(&AgentEvent::TextDelta {
        text: "Hello from ACP (medium)".into(),
    }));
    // Done(Completed) was synthesized by the watchdog.
    assert!(events.contains(&AgentEvent::Done {
        status: DoneStatus::Completed,
        result: None,
        error: None,
        session_id: Some("acp-session-1".into()),
    }));

    // Restore the default idle timeout for subsequent tests.
    // SAFETY: same justification as the set_var above.
    unsafe {
        std::env::remove_var("COMET_ACP_IDLE_TIMEOUT_SECS");
    }
}
