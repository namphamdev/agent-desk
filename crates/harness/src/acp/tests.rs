use super::*;
use agent_client_protocol::schema::v1::{
    ContentBlock, McpServer, NewSessionRequest, Plan, PlanEntryStatus, SessionInfoUpdate,
    SessionUpdate, TextContent, ToolCall, ToolCallLocation, ToolCallStatus, ToolCallUpdateFields,
    ToolKind, UsageUpdate,
};
use agent_client_protocol::{AcpAgent, AcpAgentConfig};
use comet_proto::ToolCall as CometToolCall;
use std::path::Path;

#[cfg(windows)]
use super::command::resolve_windows_executable;
use super::agent::instrument_agent_for_memory;
use super::agent::inject_grok_model_args;
use super::agent::is_turn_completion_line;
use super::command::{normalize_acp_command, resolve_agent_command_string};
use super::events::{normalize_tool_call, normalize_update};
use super::models::{grok_cached_models, grok_cli_models, parse_grok_models_output};
use super::session::mcp_servers;


    #[test]
    fn execute_tool_call_is_normalized() {
        let tool = ToolCall::new("call-1", "Run tests")
            .kind(ToolKind::Execute)
            .raw_input(serde_json::json!({"command": "cargo test"}));
        assert_eq!(
            normalize_tool_call(&tool),
            CometToolCall::Exec {
                command: "cargo test".into()
            }
        );
    }

    #[test]
    fn completed_tool_update_is_emitted_once() {
        let completed = Mutex::new(HashSet::new());
        let update =
            SessionUpdate::ToolCallUpdate(agent_client_protocol::schema::v1::ToolCallUpdate::new(
                "call-1",
                ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
            ));
        assert_eq!(normalize_update(update.clone(), &completed).len(), 1);
        assert!(normalize_update(update, &completed).is_empty());
    }

    #[test]
    fn read_tool_prefers_acp_location() {
        let tool = ToolCall::new("call-1", "Read")
            .kind(ToolKind::Read)
            .locations(vec![ToolCallLocation::new("/tmp/file.rs")]);
        assert_eq!(
            normalize_tool_call(&tool),
            CometToolCall::ReadFile {
                path: "/tmp/file.rs".into()
            }
        );
    }

    #[test]
    fn configured_active_agent_is_loaded_from_disk() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("acp-agents.json");
        std::fs::write(
            &config,
            r#"{
                "activeAgentId": "second",
                "agents": [
                    {"id": "first", "command": "{\"command\":\"first-agent\"}"},
                    {"id": "second", "command": "{\"command\":\"second-agent\",\"args\":[\"--acp\"]}"}
                ]
            }"#,
        )
        .unwrap();
        let harness = AcpHarness::new().with_config_file(config);
        let command = harness.command_for(None).unwrap();
        assert!(
            command.contains("second-agent"),
            "expected 'second-agent' in command, got: {command}"
        );
    }

    #[test]
    fn specific_agent_id_overrides_active() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("acp-agents.json");
        std::fs::write(
            &config,
            r#"{
                "activeAgentId": "second",
                "agents": [
                    {"id": "first", "command": "{\"command\":\"first-agent\"}"},
                    {"id": "second", "command": "{\"command\":\"second-agent\",\"args\":[\"--acp\"]}"}
                ]
            }"#,
        )
        .unwrap();
        let harness = AcpHarness::new().with_config_file(config);
        // Requesting "first" overrides the default "second".
        assert!(
            harness.command_for(Some("first")).unwrap().contains("first-agent"),
            "expected 'first-agent'"
        );
        // Requesting an unknown id falls back to the active agent.
        assert!(
            harness.command_for(Some("nonexistent")).unwrap().contains("second-agent"),
            "expected 'second-agent'"
        );
        // No override uses the active agent.
        assert!(
            harness.command_for(None).unwrap().contains("second-agent"),
            "expected 'second-agent'"
        );
    }

    #[test]
    fn managed_context_engine_is_added_as_http_mcp_server() {
        let servers = mcp_servers(Some("http://127.0.0.1:6699/mcp"));
        assert_eq!(servers.len(), 1);
        let McpServer::Http(server) = &servers[0] else {
            panic!("expected HTTP MCP server");
        };
        assert_eq!(server.name, CODE_CONTEXT_MCP_NAME);
        assert_eq!(server.url, "http://127.0.0.1:6699/mcp");
    }

    #[cfg(windows)]
    #[test]
    fn command_for_returns_error_when_program_not_found() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("acp-agents.json");
        std::fs::write(
            &config,
            r#"{
                "activeAgentId": "missing",
                "agents": [
                    {"id": "missing", "command": "this-program-does-not-exist-anywhere acp"}
                ]
            }"#,
        )
        .unwrap();
        let harness = AcpHarness::new().with_config_file(config);
        let error = harness.command_for(None).unwrap_err();
        assert!(
            matches!(error, HarnessError::NotInstalled(ref msg) if msg.contains("this-program-does-not-exist-anywhere")),
            "expected NotInstalled error mentioning the program name, got: {error:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolve_agent_command_string_returns_error_for_missing_program() {
        let result = resolve_agent_command_string("nonexistent-omp-binary acp");
        assert!(
            result.is_err(),
            "expected error for non-existent program"
        );
        let error = result.unwrap_err();
        assert!(
            matches!(error, HarnessError::NotInstalled(ref msg) if msg.contains("nonexistent-omp-binary")),
            "expected NotInstalled error mentioning the program name, got: {error:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolve_json_command_returns_error_for_missing_program() {
        // A JSON command with a bare program name that doesn't exist on PATH
        // must fail with NotInstalled, not pass through to the SDK where it
        // would produce a confusing os error 193.
        let json = r#"{"command":"nonexistent-grok-binary","args":["agent","stdio"]}"#;
        let result = resolve_agent_command_string(json);
        assert!(result.is_err(), "expected error for non-existent JSON program");
        let error = result.unwrap_err();
        assert!(
            matches!(error, HarnessError::NotInstalled(ref msg) if msg.contains("nonexistent-grok-binary")),
            "expected NotInstalled error mentioning the program name, got: {error:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolve_json_command_passes_through_existing_exe_extension() {
        // When the JSON command already has a .exe path, it should not fail
        // even if find_on_paths can't locate it (it's an absolute path).
        let json = r#"{"command":"C:\\Tools\\my-agent.exe","args":["--acp"]}"#;
        let result = resolve_agent_command_string(json);
        assert!(result.is_ok(), "expected ok for .exe command, got: {result:?}");
        let resolved = result.unwrap();
        assert!(
            resolved.contains("my-agent.exe"),
            "expected .exe path preserved, got: {resolved}"
        );
        // PATH should be injected into env.
        assert!(
            resolved.contains("\"PATH\""),
            "expected PATH injection in env, got: {resolved}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolve_json_command_resolves_cmd_shim_and_injects_path() {
        // Simulate a grok-style agent installed as a .cmd shim. We create a
        // fake .cmd file on PATH and verify the JSON command resolves to it
        // instead of the extensionless file that causes os error 193.
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        // Create BOTH an extensionless file (the problematic npm shim) and a
        // .cmd file (the real entry point).
        std::fs::write(dir.join("fake-grok"), "#!/bin/sh").unwrap();
        std::fs::write(dir.join("fake-grok.cmd"), "@echo off").unwrap();

        let old_path = std::env::var_os("PATH");
        // SAFETY: This test runs single-threaded.
        unsafe { std::env::set_var("PATH", dir) };

        let json = r#"{"command":"fake-grok","args":["agent","stdio"]}"#;
        let result = resolve_agent_command_string(json);

        // SAFETY: This test runs single-threaded.
        unsafe { std::env::set_var("PATH", old_path.unwrap_or_default()) };

        let resolved = result.expect("should resolve");
        assert!(
            resolved.contains("fake-grok.cmd"),
            "expected resolution to .cmd shim, got: {resolved}"
        );
        assert!(
            !resolved.contains("\"fake-grok\""),
            "should not contain the bare extensionless name"
        );
        assert!(
            resolved.contains("\"PATH\""),
            "expected PATH injection, got: {resolved}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolve_json_command_resolves_extensionless_abs_path_to_cmd_shim() {
        // Simulate the real-world Grok/Pi failure: the config has an absolute
        // path to the extensionless npm shim (e.g. C:\Program Files\nodejs\npx
        // or C:\Users\...\npm\pi-acp). The fix should find the .cmd sibling.
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        // Create both the extensionless shim and the .cmd sibling.
        let ext_less = dir.join("npx");
        std::fs::write(&ext_less, "#!/bin/sh").unwrap();
        std::fs::write(dir.join("npx.cmd"), "@echo off").unwrap();

        let abs_path = ext_less.display().to_string();
        let json = serde_json::json!({
            "command": abs_path,
            "args": ["-y", "@agentclientprotocol/grok-build-acp", "agent", "stdio"]
        })
        .to_string();
        let result = resolve_agent_command_string(&json).unwrap();
        let resolved: serde_json::Value = serde_json::from_str(&result).unwrap();
        let cmd = resolved["command"].as_str().unwrap();
        assert!(
            cmd.ends_with("npx.cmd"),
            "expected resolution to npx.cmd, got: {cmd}"
        );
        assert!(
            !cmd.ends_with("npx\""),
            "should not resolve to the extensionless shim"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn resolve_agent_command_string_passes_through_on_unix() {
        // On Unix the bare command is returned unchanged regardless of whether
        // the program exists (the child inherits a PATH that may resolve it).
        let result = resolve_agent_command_string("some-agent --acp").unwrap();
        assert_eq!(result, "some-agent --acp");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn samples_current_process_tree_memory() {
        let bytes = sample_process_tree_rss_bytes(std::process::id()).await;
        assert!(bytes.is_some_and(|bytes| bytes > 0));
    }

    #[cfg(unix)]
    #[test]
    fn memory_wrapper_preserves_agent_command_and_environment() {
        let agent = AcpAgent::new(
            AcpAgentConfig::new("/tmp/acp-agent")
                .arg("--stdio")
                .env("ACP_TEST", "yes"),
        );
        let (wrapped, pid_file) = instrument_agent_for_memory(agent);
        assert_eq!(wrapped.config().command(), Path::new("/bin/sh"));
        assert!(
            wrapped
                .config()
                .arguments()
                .iter()
                .any(|arg| arg == "/tmp/acp-agent")
        );
        assert_eq!(
            wrapped
                .config()
                .environment()
                .get("ACP_TEST")
                .map(String::as_str),
            Some("yes")
        );
        assert!(pid_file.is_some());
    }

    #[cfg(not(unix))]
    #[tokio::test]
    async fn samples_current_process_tree_memory() {
        // The Comet test process itself is always present, so its tree must
        // report a non-zero working set.
        let bytes = sample_process_tree_rss_bytes(std::process::id()).await;
        assert!(bytes.is_some_and(|bytes| bytes > 0));
    }

    #[cfg(not(unix))]
    #[test]
    fn memory_wrapper_preserves_agent_command_and_environment() {
        let agent = AcpAgent::new(
            AcpAgentConfig::new("C:\\acp-agent.exe")
                .arg("--stdio")
                .env("ACP_TEST", "yes"),
        );
        // On Windows the agent runs unwrapped (no shell shim); the spawned
        // child's PID is captured directly in TokioAcpAgent::connect_to.
        let (wrapped, pid_file) = instrument_agent_for_memory(agent);
        assert_eq!(wrapped.config().command(), Path::new("C:\\acp-agent.exe"));
        assert_eq!(
            wrapped.config().arguments(),
            &["--stdio".to_string()],
            "agent arguments are preserved unmodified"
        );
        assert_eq!(
            wrapped
                .config()
                .environment()
                .get("ACP_TEST")
                .map(String::as_str),
            Some("yes")
        );
        assert!(pid_file.is_some());
    }

    #[test]
    fn usage_update_maps_to_usage_event() {
        let completed = Mutex::new(HashSet::new());
        let update = SessionUpdate::UsageUpdate(UsageUpdate::new(53_000, 200_000));
        let events = normalize_update(update, &completed);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            AgentEvent::Usage {
                input_tokens: 53_000,
                output_tokens: 0,
            }
        );
    }

    #[test]
    fn session_info_title_emits_session_title_event() {
        let completed = Mutex::new(HashSet::new());
        let update = SessionUpdate::SessionInfoUpdate(
            SessionInfoUpdate::new().title("Fix Login Bug"),
        );
        let events = normalize_update(update, &completed);
        assert_eq!(
            events,
            vec![AgentEvent::SessionTitle {
                title: "Fix Login Bug".into()
            }]
        );
    }

    #[test]
    fn session_info_without_title_is_ignored() {
        let completed = Mutex::new(HashSet::new());
        let update = SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new());
        let events = normalize_update(update, &completed);
        assert!(events.is_empty());
    }

    #[test]
    fn plan_maps_to_todo_tool_call() {
        let completed = Mutex::new(HashSet::new());
        let plan = Plan::new(vec![
            agent_client_protocol::schema::v1::PlanEntry::new(
                "Write tests",
                agent_client_protocol::schema::v1::PlanEntryPriority::High,
                PlanEntryStatus::Completed,
            ),
            agent_client_protocol::schema::v1::PlanEntry::new(
                "Deploy",
                agent_client_protocol::schema::v1::PlanEntryPriority::Medium,
                PlanEntryStatus::Pending,
            ),
        ]);
        let events = normalize_update(SessionUpdate::Plan(plan), &completed);
        assert_eq!(events.len(), 1);
        match &events[0] {
            AgentEvent::ToolCall {
                call: CometToolCall::Todo { items },
                ..
            } => {
                assert_eq!(items.len(), 2);
                assert_eq!(items[0].text, "Write tests");
                assert!(items[0].done);
                assert_eq!(items[1].text, "Deploy");
                assert!(!items[1].done);
            }
            other => panic!("expected Todo tool call, got {other:?}"),
        }
    }

    #[test]
    fn empty_plan_is_ignored() {
        let completed = Mutex::new(HashSet::new());
        let update = SessionUpdate::Plan(Plan::new(vec![]));
        let events = normalize_update(update, &completed);
        assert!(events.is_empty());
    }

    #[test]
    fn user_message_chunk_is_ignored() {
        let completed = Mutex::new(HashSet::new());
        let update = SessionUpdate::UserMessageChunk(
            agent_client_protocol::schema::v1::ContentChunk::new(ContentBlock::Text(
                TextContent::new("echo"),
            )),
        );
        let events = normalize_update(update, &completed);
        assert!(events.is_empty());
    }

    #[test]
    fn normalize_strips_type_field_from_json_command() {
        let input = r#"{"type":"stdio","command":"/usr/local/bin/agent","args":["--acp"]}"#.to_string();
        let result = normalize_acp_command(input.clone());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(parsed.get("type").is_none());
        assert_eq!(parsed["command"], "/usr/local/bin/agent");

        // Non-JSON commands pass through unchanged.
        assert_eq!(
            normalize_acp_command("/usr/local/bin/agent --acp".to_string()),
            "/usr/local/bin/agent --acp"
        );

        // JSON without a `type` field is returned as-is.
        let clean = r#"{"command":"/usr/local/bin/agent"}"#;
        assert_eq!(
            normalize_acp_command(clean.to_string()),
            clean
        );
    }

    #[test]
    fn command_for_normalizes_mcp_style_json_config() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("acp-agents.json");
        std::fs::write(
            &config,
            r#"{
                "activeAgentId": "mcp-agent",
                "agents": [
                    {"id": "mcp-agent", "command": "{\"type\":\"stdio\",\"command\":\"/usr/local/bin/agent\"}"}
                ]
            }"#,
        )
        .unwrap();
        let harness = AcpHarness::new().with_config_file(config);
        let command = harness.command_for(None).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&command).unwrap();
        assert!(parsed.get("type").is_none());
        assert_eq!(parsed["command"], "/usr/local/bin/agent");
    }

    #[test]
    fn new_session_request_serializes_mcp_servers_array() {
        let request = NewSessionRequest::new("/tmp");
        let json = serde_json::to_value(&request).unwrap();
        // mcpServers must be present (even if empty) so strict agents like
        // pi-acp don't reject session/new with "expected array, received undefined".
        assert!(
            json.get("mcpServers").is_some(),
            "NewSessionRequest must include mcpServers in JSON output, got: {json}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolve_windows_executable_accepts_uppercase_extension() {
        // PATHEXT on Windows stores extensions in uppercase (`.EXE`, `.CMD`).
        // When find_executable discovers a binary via PATHEXT, the stored path
        // carries the uppercase extension. resolve_windows_executable must
        // treat `.EXE` identically to `.exe` — otherwise the agent fails with
        // a spurious "not found on PATH" error at run time.
        assert_eq!(
            resolve_windows_executable("C:\\Users\\test\\bin\\droid.EXE").unwrap(),
            "C:\\Users\\test\\bin\\droid.EXE"
        );
        assert_eq!(
            resolve_windows_executable("C:\\Users\\test\\bin\\droid.CMD").unwrap(),
            "C:\\Users\\test\\bin\\droid.CMD"
        );
    }

    #[test]
    fn parse_grok_models_accepts_dash_and_asterisk_bullets() {
        let output = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/grok_models_output.txt"
        ))
        .expect("test fixture grok_models_output.txt must exist");
        let models = parse_grok_models_output(&output, REASONING_LEVELS.to_vec());
        // The real `grok models` output has 196 entries: 195 `-` bullets
        // plus 1 `*` (default) bullet. The old parser only matched `* ` and
        // returned just 1 model.
        assert_eq!(
            models.len(),
            196,
            "expected all 196 models, got {}: {:?}",
            models.len(),
            models.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        // The `*` default entry must be sorted first.
        assert_eq!(models[0].id, "zai:glm-5.2");
        // Every model after the default comes from `-` bullets.
        assert!(models[1..].iter().all(|m| m.id != "zai:glm-5.2"));
    }

    #[test]
    fn parse_grok_models_uses_header_for_default_sort() {
        // When no entry has a `(default)` suffix, the "Default model:" header
        // line is the only source of the default id.
        let output = "\
Default model: xai:grok-4.5

Available models:
  - xai:grok-codex
  - xai:grok-4.5
";
        let models = parse_grok_models_output(output, REASONING_LEVELS.to_vec());
        assert_eq!(models[0].id, "xai:grok-4.5");
        assert_eq!(models[1].id, "xai:grok-codex");
    }

    #[test]
    fn parse_grok_models_empty_output() {
        let models = parse_grok_models_output("", REASONING_LEVELS.to_vec());
        assert!(models.is_empty());
    }

    #[test]
    fn grok_cached_models_reads_local_cache() {
        // This test reads the real ~/.grok/models_cache.json. It only works
        // if grok is installed and has cached models. Skip otherwise.
        match grok_cached_models() {
            Ok(models) => {
                eprintln!("grok_cached_models returned {} models", models.len());
                assert!(!models.is_empty(), "cache should have at least 1 model");
            }
            Err(e) => {
                eprintln!("grok_cached_models failed (skipping): {e}");
            }
        }
    }

    #[tokio::test]
    async fn grok_cli_models_returns_full_list() {
        // This test runs the real `grok models` CLI. It only works if grok is
        // installed and XAI_API_KEY is set. Skip otherwise.
        let command = "C:\\Users\\Admin\\.grok\\bin\\grok.exe agent stdio";
        let result = grok_cli_models(command).await;
        match result {
            Ok(models) => {
                eprintln!("grok_cli_models returned {} models", models.len());
                assert!(!models.is_empty(), "should return at least 1 model");
            }
            Err(e) => {
                eprintln!("grok_cli_models failed (skipping): {e}");
            }
        }
    }

    #[test]
    fn inject_grok_model_args_inserts_flag_before_stdio() {
        let agent = AcpAgent::new(
            AcpAgentConfig::new("grok").args(["agent".to_string(), "stdio".to_string()]),
        );
        let rebuilt = inject_grok_model_args(agent, Some("Deepseek:deepseek-v4-pro"));
        let args = rebuilt.into_config().arguments().to_vec();
        assert_eq!(
            args,
            vec!["agent", "-m", "Deepseek:deepseek-v4-pro", "stdio"]
        );
    }

    #[test]
    fn inject_grok_model_args_skips_default_and_none() {
        let make = || {
            AcpAgent::new(
                AcpAgentConfig::new("grok").args(["agent".to_string(), "stdio".to_string()]),
            )
        };
        // `None` → unchanged.
        let unchanged = inject_grok_model_args(make(), None);
        assert_eq!(
            unchanged.into_config().arguments().to_vec(),
            vec!["agent", "stdio"]
        );
        // `"default"` → unchanged.
        let unchanged = inject_grok_model_args(make(), Some("default"));
        assert_eq!(
            unchanged.into_config().arguments().to_vec(),
            vec!["agent", "stdio"]
        );
        // empty string → unchanged.
        let unchanged = inject_grok_model_args(make(), Some(""));
        assert_eq!(
            unchanged.into_config().arguments().to_vec(),
            vec!["agent", "stdio"]
        );
    }

    #[test]
    fn inject_grok_model_args_appends_when_no_stdio_token() {
        let agent = AcpAgent::new(AcpAgentConfig::new("grok").args(["agent".to_string()]));
        let rebuilt = inject_grok_model_args(agent, Some("zai:glm-5.2"));
        let args = rebuilt.into_config().arguments().to_vec();
        assert_eq!(args, vec!["agent", "-m", "zai:glm-5.2"]);
    }

    #[test]
    fn inject_grok_model_args_preserves_environment() {
        let mut env = std::collections::BTreeMap::new();
        env.insert("XAI_API_KEY".to_string(), "secret".to_string());
        let agent = AcpAgent::new(
            AcpAgentConfig::new("grok")
                .args(["agent".to_string(), "stdio".to_string()])
                .envs(env.clone()),
        );
        let rebuilt = inject_grok_model_args(agent, Some("Deepseek:deepseek-v4-pro"));
        let config = rebuilt.into_config();
        assert_eq!(
            config.environment().get("XAI_API_KEY"),
            Some(&"secret".to_string())
        );
        assert_eq!(
            config.arguments().to_vec(),
            vec!["agent", "-m", "Deepseek:deepseek-v4-pro", "stdio"]
        );
    }

    #[test]
    fn stderr_turn_completion_markers_are_detected() {
        // Terminal sse_chunk with finish_reason "stop" (codex-acp format).
        assert!(is_turn_completion_line(
            r#"INFO event="sse_chunk" backend="chat_completions" data={"id":"x","choices":[{"index":0,"finish_reason":"stop","delta":{"content":""}}]}"#
        ));
        // Spaced JSON variant.
        assert!(is_turn_completion_line(
            r#"INFO event="sse_chunk" data={"choices":[{"index":0,"finish_reason": "stop"}]}"#
        ));
        // Turn summary line.
        assert!(is_turn_completion_line(
            "2026-08-15T05:05:38.412722Z  INFO turn summary generated chars=66"
        ));
        // Non-terminal chunks and unrelated stderr lines are ignored.
        assert!(!is_turn_completion_line(
            r#"INFO event="sse_chunk" data={"choices":[{"index":0,"finish_reason":null,"delta":{"content":"hi"}}]}"#
        ));
        assert!(!is_turn_completion_line("INFO event=\"sse_chunk\" data={}"));
        assert!(!is_turn_completion_line("warning: unused variable"));
    }
