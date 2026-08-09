//! Generic Agent Client Protocol harness.
//!
//! `COMET_ACP_AGENT` accepts the command string or JSON configuration understood
//! by the official `agent-client-protocol` Rust SDK's [`AcpAgent`]. The adapter
//! normalizes ACP session updates into Comet events and keeps the ACP session
//! alive across turns.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, ClientSessionCapabilities, ContentBlock,
    Implementation, InitializeRequest, LoadSessionRequest, McpServer, McpServerHttp,
    NewSessionRequest, PermissionOption, PermissionOptionKind, Plan, PlanEntryStatus,
    PromptRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigOptionsCapabilities, SessionConfigSelectOptions, SessionId, SessionInfoUpdate,
    SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, StopReason, TextContent,
    ToolCall, ToolCallStatus, ToolKind, UsageUpdate,
};
use agent_client_protocol::schema::MaybeUndefined;
use agent_client_protocol::{
    AcpAgent, AcpAgentConfig, Agent, ConnectTo, ConnectionTo, LineDirection, Lines,
};
use async_trait::async_trait;
use base64::Engine;
use futures::stream::BoxStream;
use futures::{AsyncBufReadExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use comet_proto::{
    AgentEvent, DoneStatus, HarnessId, Model, PermissionMode, ReasoningLevel, RunRequest,
    SteeringMode, ToolCall as CometToolCall, UserInputQuestion,
};

use crate::{Harness, HarnessError, RunControls};

const ENV_AGENT: &str = "COMET_ACP_AGENT";
const CODE_CONTEXT_MCP_NAME: &str = "codebase-retrieval";
const REASONING_LEVELS: &[ReasoningLevel] = &[ReasoningLevel::Medium];

type InputRequester = dyn Fn(
        Vec<comet_proto::UserInputQuestion>,
    ) -> tokio::sync::oneshot::Receiver<Vec<comet_proto::UserInputAnswer>>
    + Send
    + Sync;

/// Per-agent configuration for the built-in ACP harness variants.
///
/// `claude()` / `codex()` are the same shared ACP harness pointed at the
/// org-maintained adapter binaries (`claude-agent-acp`, `codex-acp`). The spec
/// carries the executable name, an npx-package fallback, the harness identity
/// surfaced through the `Harness` trait, and a prompt transform (Claude's
/// Ultrathink is a prompt-prefix convention, not a config option).
#[derive(Clone, Copy)]
struct AcpSpec {
    id: HarnessId,
    display_name: &'static str,
    executable: &'static str,
    env_override: &'static str,
    /// `npx -y <package>` fallback when the binary isn't installed — pinned
    /// so a cold launch is reproducible (npx caches after the first run).
    npx_package: Option<&'static str>,
    install_hint: &'static str,
    reasoning_levels: &'static [ReasoningLevel],
    /// Transform applied to the initial prompt and every steer.
    prompt_transform: fn(Option<ReasoningLevel>, &str) -> String,
}

fn identity_transform(_reasoning: Option<ReasoningLevel>, text: &str) -> String {
    text.to_owned()
}

fn claude_spec() -> AcpSpec {
    AcpSpec {
        id: HarnessId::ClaudeCode,
        display_name: "Claude Code",
        executable: "claude-agent-acp",
        env_override: "CLAUDE_ACP_EXECUTABLE",
        npx_package: Some("@agentclientprotocol/claude-agent-acp@0.66.0"),
        install_hint: "claude-agent-acp (searched PATH, the login shell's PATH, npm \
             global bins, and fnm/nvm/volta/pnpm/bun install dirs; falls back to \
             `npx -y @agentclientprotocol/claude-agent-acp` when npx is available; \
             install with `npm install -g @agentclientprotocol/claude-agent-acp`; \
             set CLAUDE_ACP_EXECUTABLE to override)",
        reasoning_levels: &[
            ReasoningLevel::Low,
            ReasoningLevel::Medium,
            ReasoningLevel::High,
            ReasoningLevel::XHigh,
            ReasoningLevel::Max,
        ],
        prompt_transform: crate::claude::catalog::apply_ultrathink,
    }
}

fn codex_spec() -> AcpSpec {
    AcpSpec {
        id: HarnessId::Codex,
        display_name: "Codex",
        executable: "codex-acp",
        env_override: "CODEX_ACP_EXECUTABLE",
        npx_package: Some("@agentclientprotocol/codex-acp@1.1.14"),
        install_hint: "codex-acp (searched PATH, the login shell's PATH, npm global \
             bins, and fnm/nvm/volta/pnpm/bun install dirs; falls back to \
             `npx -y @agentclientprotocol/codex-acp` when npx is available; install \
             with `npm install -g @agentclientprotocol/codex-acp`; set \
             CODEX_ACP_EXECUTABLE to override)",
        reasoning_levels: crate::codex::catalog::REASONING_LEVELS,
        prompt_transform: identity_transform,
    }
}

/// PATH + login-shell + node-version-manager scan for a binary.
fn find_on_paths(exe: &str) -> Option<PathBuf> {
    // On Windows, npm global installs create `.cmd` shims (and an extensionless
    // bash script), not `.exe`. The extensionless file causes os error 193
    // ("%1 is not a valid Win32 application") if spawned directly, so we
    // generate the real executable extensions and filter to acceptable ones.
    #[cfg(windows)]
    const EXE_EXTS: &[&str] = &[".exe", ".cmd", ".bat"];
    #[cfg(not(windows))]
    const EXE_EXTS: &[&str] = &[""];

    let exe_names: Vec<String> = if cfg!(windows)
        && !EXE_EXTS.iter().any(|ext| exe.ends_with(ext))
    {
        EXE_EXTS.iter().map(|ext| format!("{exe}{ext}")).collect()
    } else {
        vec![exe.to_string()]
    };
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|d| !d.as_os_str().is_empty())
                .flat_map(|d| exe_names.iter().map(|n| d.join(n)).collect::<Vec<_>>())
                .collect()
        })
        .unwrap_or_default();
    if let Some(shell_path) = crate::shell_env::login_shell_path() {
        candidates.extend(
            std::env::split_paths(shell_path)
                .filter(|d| !d.as_os_str().is_empty())
                .flat_map(|d| exe_names.iter().map(|n| d.join(n)).collect::<Vec<_>>()),
        );
    }
    candidates.extend(crate::node_version_manager_bins().into_iter().flat_map(|d| {
        exe_names.iter().map(|n| d.join(n)).collect::<Vec<_>>()
    }));
    candidates.into_iter().find(|p| {
        if !p.exists() {
            return false;
        }
        // On Windows the extensionless npm/npx files are bash scripts that
        // cause os error 193 when spawned. Only accept real executables.
        if cfg!(windows) {
            p.extension()
                .is_some_and(|ext| matches!(ext.to_str(), Some("exe" | "cmd" | "bat")))
        } else {
            true
        }
    })
}

/// Resolve what to spawn for a built-in spec: the adapter binary itself, or
/// `npx -y <pinned>` when the binary isn't installed but npx is. Returns the
/// command string the SDK's `AcpAgent::from_str` accepts.
fn resolve_spec_command(spec: &AcpSpec) -> Result<String, HarnessError> {
    if let Some(p) = std::env::var_os(spec.env_override)
        && !p.is_empty()
    {
        return Ok(command_string_for_path(&PathBuf::from(p)));
    }
    if let Some(found) = find_on_paths(spec.executable) {
        return Ok(command_string_for_path(&found));
    }
    if let Some(pkg) = spec.npx_package
        && let Some(npx) = find_on_paths("npx")
    {
        return Ok(format!(
            "{} -y {}",
            npx.display(),
            pkg
        ));
    }
    Err(HarnessError::NotInstalled(spec.install_hint.into()))
}

/// Convert a resolved binary path into the command string `AcpAgent::from_str`
/// accepts. On Windows, `.cmd` and `.bat` files are batch scripts, not real
/// executables — spawning them directly fails with "program not found" or OS
/// error 193. Wrapping them in a JSON config makes the SDK spawn them through
/// `cmd.exe /C`, which handles batch scripts correctly. Real `.exe` files
/// (and all Unix paths) are passed through as bare strings.
#[cfg(windows)]
fn command_string_for_path(path: &Path) -> String {
    let is_batch = path
        .extension()
        .is_some_and(|ext| matches!(ext.to_str(), Some("cmd" | "bat")));
    if is_batch {
        serde_json::json!({ "command": path }).to_string()
    } else {
        path.display().to_string()
    }
}

#[cfg(not(windows))]
fn command_string_for_path(path: &Path) -> String {
    path.display().to_string()
}

/// Resolve a user-configured agent command string (from `acp-agents.json` or
/// `COMET_ACP_AGENT`) into a form `AcpAgent::from_str` can spawn reliably.
///
/// The command may be:
/// - JSON (`{"command":"...","args":[...]}`) — returned as-is (already
///   structured; the SDK spawns the named program directly).
/// - A bare executable name or path with optional args (`omp acp`,
///   `pi-acp.cmd`, `/usr/local/bin/agent --acp`).
///
/// On Windows, a bare `.cmd`/`.bat` token or a bare name that resolves to a
/// `.cmd`/`.bat` on PATH must be wrapped in JSON so the SDK spawns it through
/// `cmd.exe /C`. A bare name like `omp` that resolves to `omp.exe` on PATH is
/// expanded to the full path (so the SDK finds it even when the child's PATH
/// differs from the daemon's). On Unix the command is returned unchanged.
///
/// Returns `Err(NotInstalled)` when the program cannot be found on PATH, so
/// the caller can surface a clear error instead of letting the SDK fail at
/// spawn time with an opaque "program not found" I/O error.
fn resolve_agent_command_string(command: &str) -> Result<String, HarnessError> {
    let trimmed = command.trim();
    // JSON commands are already structured — leave them for the SDK.
    if trimmed.starts_with('{') {
        return Ok(command.to_string());
    }
    // Split into program + rest. The program is the first token.
    let mut parts = trimmed.split_whitespace();
    let Some(program) = parts.next() else {
        return Ok(command.to_string());
    };
    let args: Vec<&str> = parts.collect();

    // Compose a full PATH for the child: the resolved executable's directory
    // first, then our own PATH, then the login-shell PATH snapshot. npm-shim
    // CLIs are `#!/usr/bin/env node` scripts, and agents like OMP shell out to
    // runtimes (bun) that a daemon/service launch's PATH may lack.
    let composed_path = composed_child_path_string();

    #[cfg(not(windows))]
    {
        let _ = (args, composed_path);
        // On Unix the bare command works; the child inherits our env which
        // already has a complete PATH.
        Ok(command.to_string())
    }
    #[cfg(windows)]
    {
        // On Windows the program must be found so we can produce a JSON config
        // with its full path. If it's not on PATH, fail early with a clear
        // message rather than letting the SDK spawn a bare name that the OS
        // can't resolve.
        let resolved = find_on_paths(program).ok_or_else(|| {
            HarnessError::NotInstalled(format!(
                "ACP agent command program '{program}' was not found on PATH. \
                 Update the agent command in Settings > ACP agents to point to \
                 an installed executable."
            ))
        })?;

        // Always wrap in JSON on Windows so we can inject PATH into the
        // child environment. Without this, agents that shell out to bun,
        // node, or other runtimes fail ("'bun' is not recognized") because
        // the daemon's PATH may not include those install dirs.
        let cmd_path = resolved.display().to_string();
        let mut json = serde_json::json!({ "command": cmd_path, "env": { "PATH": composed_path } });
        if !args.is_empty() {
            json["args"] = serde_json::Value::Array(
                args.iter().map(|a| serde_json::Value::String((*a).to_string())).collect(),
            );
        }
        Ok(json.to_string())
    }
}

/// Build the PATH string a child process should receive: the resolved
/// executable's directory (if known), then our own PATH, then the login-shell
/// PATH snapshot — deduped.
fn composed_child_path_string() -> String {
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    // Our own PATH
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    // Login shell PATH (npm globals, fnm/nvm/volta, homebrew, etc.)
    if let Some(shell_path) = crate::shell_env::login_shell_path() {
        paths.extend(std::env::split_paths(shell_path));
    }
    // Node version manager bins
    paths.extend(crate::node_version_manager_bins());
    // Dedupe (keep first occurrence)
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| !p.as_os_str().is_empty() && seen.insert(p.clone()));
    std::env::join_paths(paths)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// An ACP-compatible CLI configured through `COMET_ACP_AGENT`, or one of the
/// built-in specs (`claude()`, `codex()`).
pub struct AcpHarness {
    spec: Option<AcpSpec>,
    command: Option<String>,
    config_file: Option<PathBuf>,
    mcp_server_url: Option<String>,
    discovered_models: tokio::sync::Mutex<HashMap<String, Vec<Model>>>,
}

impl Default for AcpHarness {
    fn default() -> Self {
        Self {
            spec: None,
            command: None,
            config_file: None,
            mcp_server_url: None,
            discovered_models: tokio::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl AcpHarness {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claude Code over ACP — the org-maintained `claude-agent-acp` adapter
    /// on the Claude Agent SDK.
    pub fn claude() -> Self {
        Self {
            spec: Some(claude_spec()),
            ..Self::default()
        }
    }

    /// Codex over ACP — the org-maintained `codex-acp` adapter wrapping the
    /// codex app-server.
    pub fn codex() -> Self {
        Self {
            spec: Some(codex_spec()),
            ..Self::default()
        }
    }

    /// Test seam: the program `run` would spawn (the adapter binary, or npx
    /// for the pinned-package fallback).
    #[doc(hidden)]
    pub fn launch_program(&self) -> Result<PathBuf, HarnessError> {
        let spec = self.spec.ok_or_else(|| {
            HarnessError::Protocol("launch_program is only for spec-backed harnesses".into())
        })?;
        let command = resolve_spec_command(&spec)?;
        // The command is either a bare path or "npx -y <pkg>"; the program is
        // the first token.
        let program = command.split_whitespace().next().unwrap_or(&command);
        Ok(PathBuf::from(program))
    }

    /// Use a fixed SDK command/config instead of `COMET_ACP_AGENT`.
    pub fn with_command(mut self, command: impl Into<String>) -> Self {
        self.command = Some(command.into());
        self
    }

    /// Read the active agent command from Comet's device-local ACP settings.
    pub fn with_config_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.config_file = Some(path.into());
        self
    }

    /// Add Comet's managed code-context MCP server to each ACP session.
    pub fn with_mcp_server(mut self, url: impl Into<String>) -> Self {
        self.mcp_server_url = Some(url.into());
        self
    }

    /// Resolve the launch command for a specific ACP agent id. When `agent_id`
    /// is `None` (or not found among installed agents), falls back to the
    /// device's active agent. Spec-backed harnesses (`claude()`, `codex()`)
    /// resolve their adapter binary through this path instead.
    fn command_for(&self, agent_id: Option<&str>) -> Result<String, HarnessError> {
        if let Some(spec) = &self.spec {
            // An explicit command override (tests) wins over spec resolution.
            if let Some(cmd) = &self.command {
                return Ok(cmd.clone());
            }
            return resolve_spec_command(spec);
        }
        let result = self
            .command
            .clone()
            .or_else(|| std::env::var(ENV_AGENT).ok())
            .or_else(|| {
                let file = self.config_file.as_ref()?;
                let json = std::fs::read_to_string(file).ok()?;
                let config: AcpHarnessConfig = serde_json::from_str(&json).ok()?;
                // Prefer the explicitly requested agent id; fall back to active.
                let wanted = agent_id
                    .filter(|id| config.agents.iter().any(|a| &a.id == id))
                    .or(config.active_agent_id.as_deref());
                config
                    .agents
                    .into_iter()
                    .find(|agent| Some(agent.id.as_str()) == wanted)
                    .map(|agent| agent.command)
            });
        let command = result
            .map(normalize_acp_command)
            .filter(|command| !command.trim().is_empty())
            .ok_or_else(|| {
                HarnessError::NotInstalled(format!(
                    "ACP agent is not configured; add one in Settings > ACP agents or set \
                     {ENV_AGENT}"
                ))
            })?;
        resolve_agent_command_string(&command)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcpHarnessConfig {
    active_agent_id: Option<String>,
    #[serde(default)]
    agents: Vec<AcpHarnessAgent>,
}

#[derive(Deserialize)]
struct AcpHarnessAgent {
    id: String,
    command: String,
}

/// Normalize a resolved ACP agent command so the SDK's `AcpAgent::from_str`
/// accepts it. Users sometimes paste MCP-style JSON configs that include a
/// `"type"` field (e.g. `{"type":"stdio","command":"..."}`); the ACP SDK's
/// `AcpAgentConfig` uses `#[serde(deny_unknown_fields)]` and rejects anything
/// beyond `command`, `args`, `env`. Strip the offending field before the SDK
/// ever sees it.
fn normalize_acp_command(command: String) -> String {
    let trimmed = command.trim();
    if !trimmed.starts_with('{') {
        return command;
    }
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return command;
    };
    let Some(obj) = value.as_object_mut() else {
        return command;
    };
    if obj.remove("type").is_none() {
        return command;
    }
    serde_json::to_string(&value).unwrap_or(command)
}

#[async_trait]
impl Harness for AcpHarness {
    fn id(&self) -> HarnessId {
        self.spec.map(|s| s.id).unwrap_or(HarnessId::Acp)
    }

    fn display_name(&self) -> &str {
        self.spec.map(|s| s.display_name).unwrap_or("ACP Agent")
    }

    fn supports_steering(&self) -> bool {
        true
    }

    fn steering_mode(&self) -> SteeringMode {
        // ACP has multi-turn sessions but no mid-turn steering method.
        SteeringMode::TurnBoundary
    }

    fn reasoning_levels(&self) -> &[ReasoningLevel] {
        self.spec
            .map(|s| s.reasoning_levels)
            .unwrap_or(REASONING_LEVELS)
    }

    async fn models(&self, acp_agent_id: Option<&str>) -> Result<Vec<Model>, HarnessError> {
        let command = self.command_for(acp_agent_id)?;
        let mut cached_models = self.discovered_models.lock().await;
        if let Some(models) = cached_models.get(&command) {
            return Ok(models.clone());
        }

        let agent = AcpAgent::from_str(&command).map_err(|error| {
            HarnessError::Protocol(format!("invalid ACP agent config: {error}"))
        })?;
        let agent = TokioAcpAgent::new(agent);
        let discovered_models = Arc::new(Mutex::new(None));
        let discovery_result = agent_client_protocol::Client
            .builder()
            .connect_with(agent, {
                let discovered_models = discovered_models.clone();
                move |connection: ConnectionTo<Agent>| async move {
                    initialize(&connection).await?;
                    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
                    let response = connection
                        .send_request(NewSessionRequest::new(cwd))
                        .block_task()
                        .await?;
                    let models = models_from_config_options(response.config_options.as_deref());
                    *discovered_models
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(models.clone());
                    Ok(models)
                }
            })
            .await;

        let models = match discovery_result {
            Ok(models) => {
                eprintln!("[models] discovery Ok — {} models", models.len());
                models
            }
            Err(error) => {
                eprintln!("[models] discovery Err: {error}");
                if let Some(models) = discovered_models
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                {
                    tracing::debug!(
                        error = %error,
                        "ACP agent exited after model discovery; using discovered models"
                    );
                    models
                } else {
                    tracing::debug!(
                        error = %error,
                        "ACP model discovery failed; using default model"
                    );
                    vec![default_acp_model(REASONING_LEVELS.to_vec())]
                }
            }
        };
        cached_models.insert(command, models.clone());
        Ok(models)
    }

    async fn run(
        &self,
        request: RunRequest,
        controls: RunControls,
    ) -> Result<BoxStream<'static, Result<AgentEvent, HarnessError>>, HarnessError> {
        let command = self.command_for(request.acp_agent_id.as_deref())?;
        let agent = AcpAgent::from_str(&command).map_err(|error| {
            HarnessError::Protocol(format!("invalid ACP agent config: {error}"))
        })?;
        let (event_tx, event_rx) = mpsc::channel(256);
        let notification_tx = event_tx.clone();
        let completed_tools = Arc::new(Mutex::new(HashSet::new()));
        let notification_tools = completed_tools.clone();
        // Gate that suppresses `session/update` notifications until the live
        // turn has started. ACP agents (e.g. OMP, Pi) replay the entire prior
        // conversation as `session/update` notifications while servicing
        // `session/load` on a resumed session; forwarding those to the engine
        // would append the whole previous turn's history into the new assistant
        // entry. Flipped to `true` right after `SessionStarted` is emitted, so
        // only updates from the actual prompt flow reach the transcript.
        let live_updates = Arc::new(AtomicBool::new(false));
        let notification_live_updates = live_updates.clone();
        let RunControls {
            request_input,
            steering,
            interrupt,
            report_memory,
        } = controls;
        let request_input = Arc::new(request_input);
        let permission_input = request_input.clone();
        let permission_mode = request.effective_permission_mode();
        let mcp_server_url = self.mcp_server_url.clone();
        let prompt_transform = self
            .spec
            .map(|s| s.prompt_transform)
            .unwrap_or(identity_transform);
        let harness_id = self.id();

        // When the selected model belongs to a custom provider, build the
        // provider-specific env vars to inject into the codex-acp subprocess.
        let extra_env = if self.spec.is_some_and(|s| s.id == HarnessId::Codex) {
            request
                .custom_provider
                .as_ref()
                .map(|provider| codex_custom_provider_env(provider, request.model.as_deref()))
        } else {
            None
        };

        tokio::spawn(async move {
            let (agent, pid_file) = instrument_agent_for_memory(agent);
            let agent = TokioAcpAgent::new(agent)
                .with_pid_file(pid_file.clone())
                .with_extra_env(extra_env.unwrap_or_default());
            let memory_stop = crate::CancellationToken::new();
            let memory_reporter: Arc<dyn Fn(Option<u64>) + Send + Sync> = report_memory.into();
            let memory_task = pid_file.clone().map(|path| {
                let stop = memory_stop.clone();
                let report = memory_reporter.clone();
                tokio::spawn(async move {
                    poll_process_memory(path, stop, report).await;
                })
            });
            let connection_tx = event_tx.clone();
            let result = agent_client_protocol::Client
                .builder()
                .on_receive_notification(
                    async move |notification: SessionNotification, _cx| {
                        // Drop `session/update` notifications that arrive before
                        // the live turn starts (the load-time replay of a
                        // resumed session's history). Only updates from the
                        // actual prompt flow reach the transcript.
                        if !notification_live_updates.load(Ordering::Relaxed) {
                            return Ok(());
                        }
                        for event in normalize_update(notification.update, &notification_tools) {
                            if notification_tx.send(Ok(event)).await.is_err() {
                                break;
                            }
                        }
                        Ok(())
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .on_receive_request(
                    async move |permission: RequestPermissionRequest, responder, _cx| {
                        let outcome = permission_outcome(
                            &permission,
                            permission_mode,
                            permission_input.as_ref().as_ref(),
                        )
                        .await;
                        responder.respond(RequestPermissionResponse::new(outcome))
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
                    run_connection(
                        connection,
                        request,
                        steering,
                        interrupt,
                        connection_tx,
                        mcp_server_url,
                        prompt_transform,
                        harness_id,
                        live_updates.clone(),
                    )
                    .await
                })
                .await;

            memory_stop.cancel();
            if let Some(task) = memory_task {
                let _ = task.await;
            }
            memory_reporter(None);
            if let Some(path) = pid_file {
                let _ = tokio::fs::remove_file(path).await;
            }

            if let Err(error) = result {
                tracing::warn!(error = %error, "ACP session connection failed");
                let _ = event_tx
                    .send(Ok(AgentEvent::Done {
                        status: DoneStatus::Errored,
                        result: None,
                        error: Some(format!("ACP connection failed: {error}")),
                        session_id: None,
                    }))
                    .await;
            }
        });

        Ok(futures::stream::unfold(event_rx, |mut rx| async move {
            rx.recv().await.map(|event| (event, rx))
        })
        .boxed())
    }
}

type DebugCallback = Arc<dyn Fn(&str, LineDirection) + Send + Sync + 'static>;

/// Tokio-native replacement for the SDK's `AcpAgent` subprocess transport.
///
/// agent-client-protocol 2.0 uses async-process for child pipes. Its readers
/// busy-poll at idle on both macOS and Linux (upstream issue #254), consuming
/// most of a core per parked ACP session. Comet already runs a Tokio runtime,
/// so keep the SDK's protocol implementation and supply it Tokio child pipes.
struct TokioAcpAgent {
    config: AcpAgentConfig,
    debug: DebugCallback,
    /// Where to record the spawned agent's PID so the memory-poll task can find
    /// it. On Unix the `/bin/sh` shim writes its own (pre-`exec`) PID, so this
    /// stays `None`. On Windows there is no exec-replace shim: the child PID is
    /// captured at spawn and written here instead.
    pid_file: Option<PathBuf>,
}

impl TokioAcpAgent {
    fn new(agent: AcpAgent) -> Self {
        Self {
            config: agent.into_config(),
            debug: Arc::new(log_acp_line),
            pid_file: None,
        }
    }

    fn with_pid_file(mut self, pid_file: Option<PathBuf>) -> Self {
        self.pid_file = pid_file;
        self
    }

    /// Merge additional env vars into the subprocess environment. Later calls
    /// to the same key overwrite earlier ones; values from the original
    /// command config are preserved unless overridden.
    fn with_extra_env(mut self, extra: HashMap<String, String>) -> Self {
        let mut env = self.config.environment().clone();
        for (key, value) in extra {
            env.insert(key, value);
        }
        self.config = AcpAgentConfig::new(self.config.command())
            .args(self.config.arguments().to_vec())
            .envs(env);
        self
    }
}

impl ConnectTo<agent_client_protocol::Client> for TokioAcpAgent {
    async fn connect_to(self, client: impl ConnectTo<Agent>) -> agent_client_protocol::Result<()> {
        let mut command = tokio::process::Command::new(self.config.command());
        command
            .args(self.config.arguments())
            .envs(self.config.environment())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            command.process_group(0);
        }

        let mut child = command.spawn().map_err(acp_io_error)?;

        // Windows has no `/bin/sh` exec-replace shim, so capture the spawned
        // child's PID directly — it is the root of the agent's process tree.
        #[cfg(not(unix))]
        if let (Some(pid_file), Some(pid)) = (self.pid_file.as_ref(), child.id()) {
            let pid_file = pid_file.to_path_buf();
            // Best-effort: the poll task tolerates a missing/unreadable file.
            let _ = tokio::task::spawn_blocking(move || std::fs::write(&pid_file, pid.to_string()))
                .await;
        }

        let stdin = child.stdin.take().ok_or_else(|| {
            acp_internal_error("failed to open stdin for the ACP agent subprocess")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            acp_internal_error("failed to open stdout for the ACP agent subprocess")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            acp_internal_error("failed to open stderr for the ACP agent subprocess")
        })?;

        let stderr_debug = self.debug.clone();
        let stderr_task = tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt as _;

            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stderr_debug(&line, LineDirection::Stderr);
            }
        });

        let incoming_debug = self.debug.clone();
        let incoming = futures::io::BufReader::new(stdout.compat())
            .lines()
            .inspect(move |line| {
                if let Ok(line) = line {
                    incoming_debug(line, LineDirection::Stdout);
                }
            });
        let outgoing_debug = self.debug;
        let outgoing = futures::sink::unfold(
            (stdin.compat_write(), outgoing_debug),
            async move |(mut writer, debug), line: String| {
                use futures::AsyncWriteExt as _;
                debug(&line, LineDirection::Stdin);
                writer.write_all(line.as_bytes()).await?;
                writer.write_all(b"\n").await?;
                writer.flush().await?;
                Ok::<_, std::io::Error>((writer, debug))
            },
        );

        let protocol = ConnectTo::<agent_client_protocol::Client>::connect_to(
            Lines::new(outgoing, incoming),
            client,
        );
        tokio::pin!(protocol);
        let result = tokio::select! {
            result = &mut protocol => result,
            status = child.wait() => match status {
                Ok(status) if status.success() => Ok(()),
                Ok(status) => Err(acp_internal_error(format!(
                    "ACP agent exited unexpectedly ({status})"
                ))),
                Err(error) => Err(acp_io_error(error)),
            },
        };

        terminate_process_group(&mut child);
        stderr_task.abort();
        let _ = stderr_task.await;
        result
    }
}

fn acp_io_error(error: std::io::Error) -> agent_client_protocol::Error {
    acp_internal_error(format!("ACP subprocess I/O failed: {error}"))
}

fn acp_internal_error(message: impl Into<String>) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(message.into())
}

#[cfg(unix)]
fn terminate_process_group(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        // The child is its own process-group leader, so this also cleans up
        // package runners and any agent descendants.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
}

fn log_acp_line(line: &str, direction: LineDirection) {
    match direction {
        LineDirection::Stderr => tracing::warn!(stderr = %line, "ACP agent stderr"),
        LineDirection::Stdout => {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line)
                && let Some(error) = value.get("error")
            {
                tracing::warn!(error = %error, "ACP agent returned a protocol error");
            }
        }
        LineDirection::Stdin => {}
    }
}

#[cfg(unix)]
fn instrument_agent_for_memory(agent: AcpAgent) -> (AcpAgent, Option<PathBuf>) {
    let config = agent.into_config();
    let pid_file = std::env::temp_dir().join(format!("comet-acp-{}.pid", uuid::Uuid::new_v4()));
    let mut args = vec![
        "-c".to_string(),
        "printf '%s' \"$$\" > \"$1\"; shift; exec \"$@\"".to_string(),
        "comet-acp-memory".to_string(),
        pid_file.to_string_lossy().to_string(),
        config.command().to_string_lossy().to_string(),
    ];
    args.extend(config.arguments().iter().cloned());
    let wrapped = AcpAgent::new(
        AcpAgentConfig::new("/bin/sh")
            .args(args)
            .envs(config.environment().clone()),
    );
    (wrapped, Some(pid_file))
}

#[cfg(not(unix))]
fn instrument_agent_for_memory(agent: AcpAgent) -> (AcpAgent, Option<PathBuf>) {
    // No exec-replace shim on Windows: the spawned child's PID is captured in
    // `TokioAcpAgent::connect_to` (see `with_pid_file`). Return the agent
    // unwrapped alongside a fresh pid file so the poll task has somewhere to
    // read from.
    let pid_file = std::env::temp_dir().join(format!("comet-acp-{}.pid", uuid::Uuid::new_v4()));
    (agent, Some(pid_file))
}

fn mcp_servers(url: Option<&str>) -> Vec<McpServer> {
    url.filter(|url| !url.trim().is_empty())
        .map(|url| McpServer::Http(McpServerHttp::new(CODE_CONTEXT_MCP_NAME, url)))
        .into_iter()
        .collect()
}

/// Build the codex-acp env vars that configure a custom provider inline,
/// mirroring the old native harness's `-c model_provider="custom" ...` flags.
/// codex-acp reads `MODEL_PROVIDER`, `CODEX_CONFIG` (merged into the session
/// config), and `CODEX_API_KEY`. The selected model id is included so codex-acp
/// uses it directly without needing a `session/setConfigOption` round-trip
/// that the adapter would reject for an unknown model.
fn codex_custom_provider_env(
    provider: &comet_proto::CustomProviderEnv,
    model: Option<&str>,
) -> HashMap<String, String> {
    // Prefer Responses (codex native), fall back to chat_completions.
    let wire_api = if provider
        .formats
        .contains(&comet_proto::CustomProviderFormat::Responses)
    {
        "responses"
    } else if provider
        .formats
        .contains(&comet_proto::CustomProviderFormat::ChatCompletions)
    {
        "chat_completions"
    } else {
        "responses"
    };

    // codex appends "/responses" or "/chat/completions" directly to base_url,
    // so ensure it ends with "/v1" (matching the OpenAI convention). Users
    // typically enter "https://api.example.com" without the version segment.
    let base_url = {
        let trimmed = provider.base_url.trim_end_matches('/');
        if trimmed.ends_with("/v1") {
            trimmed.to_string()
        } else {
            format!("{trimmed}/v1")
        }
    };

    let mut config = serde_json::json!({
        "model_provider": "custom",
        "model_providers": {
            "custom": {
                "name": provider.name,
                "base_url": base_url,
                "wire_api": wire_api,
            }
        }
    });
    if let Some(model) = model.filter(|model| !model.is_empty()) {
        config["model"] = serde_json::json!(model);
    }
    if let Some(subagent) = &provider.codex_subagent_model {
        config["agents"] = serde_json::json!({
            "default_subagent_model": subagent
        });
    }

    let mut env = HashMap::new();
    env.insert("MODEL_PROVIDER".into(), "custom".into());
    env.insert("CODEX_CONFIG".into(), config.to_string());
    env.insert("CODEX_API_KEY".into(), provider.api_key.clone());
    env
}

async fn poll_process_memory(
    pid_file: PathBuf,
    stop: crate::CancellationToken,
    report: Arc<dyn Fn(Option<u64>) + Send + Sync>,
) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = interval.tick() => {
                let Ok(pid) = tokio::fs::read_to_string(&pid_file).await else {
                    continue;
                };
                let Ok(pid) = pid.trim().parse::<u32>() else {
                    continue;
                };
                if let Some(bytes) = sample_process_tree_rss_bytes(pid).await {
                    report(Some(bytes));
                }
            }
        }
    }
}

#[cfg(unix)]
pub async fn sample_process_tree_rss_bytes(root_pid: u32) -> Option<u64> {
    let output = tokio::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss="])
        .output()
        .await
        .ok()?;
    let rows = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((
                fields.next()?.parse::<u32>().ok()?,
                fields.next()?.parse::<u32>().ok()?,
                fields.next()?.parse::<u64>().ok()?,
            ))
        })
        .collect::<Vec<_>>();
    let mut queue = VecDeque::from([root_pid]);
    let mut seen = HashSet::from([root_pid]);
    let mut total_kib = 0_u64;
    while let Some(parent) = queue.pop_front() {
        for &(pid, ppid, rss_kib) in &rows {
            if pid == parent {
                total_kib = total_kib.saturating_add(rss_kib);
            }
            if ppid == parent && seen.len() < 64 && seen.insert(pid) {
                queue.push_back(pid);
            }
        }
    }
    (total_kib > 0).then_some(total_kib.saturating_mul(1024))
}

#[cfg(not(unix))]
pub async fn sample_process_tree_rss_bytes(root_pid: u32) -> Option<u64> {
    // ToolHelp32 + GetProcessMemoryInfo are blocking Win32 calls; run them off
    // the async runtime. Mirrors the Unix variant's contract: returns the
    // resident memory (working set, in bytes) of the agent's process tree.
    tokio::task::spawn_blocking(move || sample_process_tree_rss_blocking(root_pid))
        .await
        .ok()
        .flatten()
}

#[cfg(not(unix))]
fn sample_process_tree_rss_blocking(root_pid: u32) -> Option<u64> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    // SAFETY: snapshot the process list. The returned handle is closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    // Scope the handle so CloseHandle always runs.
    let rows = (|| {
        // SAFETY: PROCESSENTRY32W is a plain POD struct; zeroed memory is a
        // valid initial state (dwSize is set immediately after).
        let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut rows: Vec<(u32, u32)> = Vec::new();
        // SAFETY: snapshot is a valid handle; entry is initialized with the
        // correct dwSize per the API contract.
        if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
            loop {
                rows.push((entry.th32ProcessID, entry.th32ParentProcessID));
                // SAFETY: same preconditions as Process32FirstW; entry retains a
                // valid dwSize.
                if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                    break;
                }
            }
        }
        rows
    })();
    // SAFETY: snapshot is a snapshot handle from CreateToolhelp32Snapshot.
    unsafe { CloseHandle(snapshot) };

    // BFS the process tree exactly like the Unix variant, summing RSS.
    let mut queue = VecDeque::from([root_pid]);
    let mut seen = HashSet::from([root_pid]);
    let mut total_bytes = 0_u64;
    while let Some(parent) = queue.pop_front() {
        for &(pid, ppid) in &rows {
            if pid == parent {
                if let Some(bytes) = working_set_bytes(pid) {
                    total_bytes = total_bytes.saturating_add(bytes);
                }
            }
            if ppid == parent && seen.len() < 64 && seen.insert(pid) {
                queue.push_back(pid);
            }
        }
    }
    (total_bytes > 0).then_some(total_bytes)
}

#[cfg(not(unix))]
fn working_set_bytes(pid: u32) -> Option<u64> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    // SAFETY: query-only access right; no handle is inherited. The handle is
    // closed before returning.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let result = (|| {
        // SAFETY: PROCESS_MEMORY_COUNTERS is a POD; zeroed is a valid init and
        // cb is set before the call as the API requires.
        let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { zeroed() };
        counters.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        // SAFETY: handle comes from OpenProcess above; counters has the right cb.
        if unsafe {
            GetProcessMemoryInfo(
                handle,
                &mut counters,
                size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            )
        } != 0
        {
            Some(counters.WorkingSetSize as u64)
        } else {
            None
        }
    })();
    // SAFETY: handle is from OpenProcess above.
    unsafe { CloseHandle(handle) };
    result
}

async fn run_connection(
    connection: ConnectionTo<Agent>,
    request: RunRequest,
    mut steering: mpsc::Receiver<crate::SteerMessage>,
    interrupt: crate::CancellationToken,
    event_tx: mpsc::Sender<Result<AgentEvent, HarnessError>>,
    mcp_server_url: Option<String>,
    prompt_transform: fn(Option<ReasoningLevel>, &str) -> String,
    harness_id: HarnessId,
    live_updates: Arc<AtomicBool>,
) -> agent_client_protocol::Result<()> {
    initialize(&connection).await?;

    let cwd = absolute_cwd(&request.cwd);
    let mcp_servers = mcp_servers(mcp_server_url.as_deref());
    let with_mcp = |request: NewSessionRequest| {
        if mcp_servers.is_empty() {
            request
        } else {
            request.mcp_servers(mcp_servers.clone())
        }
    };
    let with_mcp_load = |request: LoadSessionRequest| {
        if mcp_servers.is_empty() {
            request
        } else {
            request.mcp_servers(mcp_servers.clone())
        }
    };
    let (session_id, config_options) = if let Some(resume) = &request.resume {
        match connection
            .send_request(with_mcp_load(LoadSessionRequest::new(resume.clone(), cwd.clone())))
            .block_task()
            .await
        {
            Ok(response) => (resume.clone().into(), response.config_options),
            Err(error) => {
                tracing::debug!(target: "comet_harness::acp", %error, "session/load failed; starting a new ACP session");
                let response = connection
                    .send_request(with_mcp(NewSessionRequest::new(cwd.clone())))
                    .block_task()
                    .await?;
                (response.session_id, response.config_options)
            }
        }
    } else {
        let response = connection
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?;
        (response.session_id, response.config_options)
    };
    let updated_config_options = set_session_model(
        &connection,
        &session_id,
        request.model.as_deref(),
        config_options.as_deref(),
    )
    .await?;
    let effective_config_options = updated_config_options
        .as_deref()
        .filter(|options| !options.is_empty())
        .or(config_options.as_deref());
    let mode_config_options = set_session_permission_mode(
        &connection,
        &session_id,
        request.effective_permission_mode(),
        effective_config_options,
    )
    .await?;
    let effective_config_options = mode_config_options
        .as_deref()
        .filter(|options| !options.is_empty())
        .or(effective_config_options);
    set_session_reasoning(
        &connection,
        &session_id,
        request.reasoning,
        effective_config_options,
    )
    .await?;

    let session_id_string = session_id.to_string();
    let mut assistant_message_id = uuid::Uuid::new_v4().to_string();
    if event_tx
        .send(Ok(AgentEvent::SessionStarted {
            harness: harness_id,
            model: request.model.clone().unwrap_or_else(|| "default".into()),
            tools: vec![],
            cwd: cwd.display().to_string(),
            session_id: session_id_string.clone(),
            assistant_message_id: assistant_message_id.clone(),
        }))
        .await
        .is_err()
    {
        return Ok(());
    }
    // Session setup (including any session/load replay) is complete. Open the
    // gate so only prompt-flow updates reach the transcript from here on.
    live_updates.store(true, Ordering::Relaxed);
    let mut prompts = VecDeque::from([prompt_content(&request, prompt_transform)]);

    loop {
        let Some(content) = prompts.pop_front() else {
            tokio::select! {
                steer = steering.recv() => match steer {
                    Some(steer) => {
                        let previous = std::mem::replace(
                            &mut assistant_message_id,
                            uuid::Uuid::new_v4().to_string(),
                        );
                        if event_tx
                            .send(Ok(AgentEvent::Steered {
                                assistant_message_id: Some(previous),
                                next_assistant_message_id: Some(assistant_message_id.clone()),
                            }))
                            .await
                            .is_err()
                        {
                            return Ok(());
                        }
                        prompts.push_back(vec![ContentBlock::Text(TextContent::new(
                            prompt_transform(request.reasoning, &steer.prompt),
                        ))]);
                    }
                    None => return Ok(()),
                },
                _ = interrupt.cancelled() => return Ok(()),
            }
            continue;
        };

        let prompt = connection
            .send_request(PromptRequest::new(session_id.clone(), content))
            .block_task();
        tokio::pin!(prompt);
        let response = loop {
            tokio::select! {
                response = &mut prompt => break response,
                steer = steering.recv() => {
                    if let Some(steer) = steer {
                        prompts.push_back(vec![ContentBlock::Text(TextContent::new(
                            prompt_transform(request.reasoning, &steer.prompt),
                        ))]);
                    }
                }
                _ = interrupt.cancelled() => {
                    connection.send_notification(CancelNotification::new(session_id.clone()))?;
                    break prompt.await;
                }
            }
        }?;

        let (status, error) = done_from_stop_reason(response.stop_reason);
        if event_tx
            .send(Ok(AgentEvent::Done {
                status,
                result: None,
                error,
                session_id: Some(session_id_string.clone()),
            }))
            .await
            .is_err()
        {
            return Ok(());
        }
        if status == DoneStatus::Interrupted {
            return Ok(());
        }
        if !prompts.is_empty() {
            let previous =
                std::mem::replace(&mut assistant_message_id, uuid::Uuid::new_v4().to_string());
            if event_tx
                .send(Ok(AgentEvent::Steered {
                    assistant_message_id: Some(previous),
                    next_assistant_message_id: Some(assistant_message_id.clone()),
                }))
                .await
                .is_err()
            {
                return Ok(());
            }
        }
    }
}

async fn initialize(connection: &ConnectionTo<Agent>) -> agent_client_protocol::Result<()> {
    let capabilities = ClientCapabilities::new().session(
        ClientSessionCapabilities::new().config_options(SessionConfigOptionsCapabilities::new()),
    );
    connection
        .send_request(
            InitializeRequest::new(ProtocolVersion::V1)
                .client_capabilities(capabilities)
                .client_info(
                    Implementation::new("comet-native", env!("CARGO_PKG_VERSION")).title("Comet"),
                ),
        )
        .block_task()
        .await?;
    Ok(())
}

fn model_config_option(options: &[SessionConfigOption]) -> Option<&SessionConfigOption> {
    options.iter().find(|option| {
        matches!(option.category, Some(SessionConfigOptionCategory::Model))
            || option.id.to_string().eq_ignore_ascii_case("model")
            || option.name.eq_ignore_ascii_case("model")
    })
}

fn thought_level_config_option(options: &[SessionConfigOption]) -> Option<&SessionConfigOption> {
    options.iter().find(|option| {
        matches!(
            option.category,
            Some(SessionConfigOptionCategory::ThoughtLevel)
        ) || matches!(
            normalize_config_name(&option.id.to_string()).as_str(),
            "thoughtlevel"
                | "reasoning"
                | "reasoninglevel"
                | "thinking"
                | "thinkinglevel"
        ) || matches!(
            normalize_config_name(&option.name).as_str(),
            "thoughtlevel"
                | "reasoning"
                | "reasoninglevel"
                | "thinking"
                | "thinkinglevel"
        )
    })
}

fn mode_config_option(options: &[SessionConfigOption]) -> Option<&SessionConfigOption> {
    options.iter().find(|option| {
        matches!(option.category, Some(SessionConfigOptionCategory::Mode))
            || matches!(
                normalize_config_name(&option.id.to_string()).as_str(),
                "mode" | "permissionmode"
            )
            || matches!(
                normalize_config_name(&option.name).as_str(),
                "mode" | "permissionmode"
            )
    })
}

fn select_choices(
    option: &SessionConfigOption,
) -> Vec<&agent_client_protocol::schema::v1::SessionConfigSelectOption> {
    let SessionConfigKind::Select(select) = &option.kind else {
        return vec![];
    };
    match &select.options {
        SessionConfigSelectOptions::Ungrouped(options) => options.iter().collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter())
            .collect(),
        _ => vec![],
    }
}

fn models_from_config_options(options: Option<&[SessionConfigOption]>) -> Vec<Model> {
    let reasoning_levels = reasoning_levels_from_config_options(options);
    let Some(option) = options.and_then(model_config_option) else {
        return vec![default_acp_model(reasoning_levels)];
    };
    let SessionConfigKind::Select(select) = &option.kind else {
        return vec![default_acp_model(reasoning_levels)];
    };
    let mut choices = select_choices(option);
    let current = select.current_value.to_string();
    choices.sort_by_key(|choice| choice.value.to_string() != current);
    let models = choices
        .into_iter()
        .map(|choice| Model {
            id: choice.value.to_string(),
            label: choice.name.clone(),
            description: choice.description.clone(),
            reasoning_levels: reasoning_levels.clone(),
            options: vec![],
        })
        .collect::<Vec<_>>();
    if models.is_empty() {
        vec![default_acp_model(reasoning_levels)]
    } else {
        models
    }
}

fn reasoning_levels_from_config_options(
    options: Option<&[SessionConfigOption]>,
) -> Vec<ReasoningLevel> {
    let Some(option) = options.and_then(thought_level_config_option) else {
        return REASONING_LEVELS.to_vec();
    };
    let mut levels = select_choices(option)
        .into_iter()
        .filter_map(|choice| {
            reasoning_level_from_acp(&choice.value.to_string())
                .or_else(|| reasoning_level_from_acp(&choice.name))
        })
        .collect::<Vec<_>>();
    levels.dedup();
    if levels.is_empty() {
        REASONING_LEVELS.to_vec()
    } else {
        levels
    }
}

fn normalize_config_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn reasoning_level_from_acp(value: &str) -> Option<ReasoningLevel> {
    match normalize_config_name(value).as_str() {
        "minimal" | "none" | "off" => Some(ReasoningLevel::Minimal),
        "low" => Some(ReasoningLevel::Low),
        "medium" | "med" | "auto" => Some(ReasoningLevel::Medium),
        "high" => Some(ReasoningLevel::High),
        "xhigh" | "extrahigh" => Some(ReasoningLevel::XHigh),
        "max" | "maximum" => Some(ReasoningLevel::Max),
        "ultra" => Some(ReasoningLevel::Ultra),
        "ultracode" => Some(ReasoningLevel::Ultracode),
        "ultrathink" => Some(ReasoningLevel::Ultrathink),
        _ => None,
    }
}

fn reasoning_level_acp_value(
    reasoning: ReasoningLevel,
    option: Option<&SessionConfigOption>,
) -> String {
    option
        .into_iter()
        .flat_map(select_choices)
        .find(|choice| {
            reasoning_level_from_acp(&choice.value.to_string())
                .or_else(|| reasoning_level_from_acp(&choice.name))
                == Some(reasoning)
        })
        .map(|choice| choice.value.to_string())
        .unwrap_or_else(|| {
            match reasoning {
                ReasoningLevel::Minimal => "minimal",
                ReasoningLevel::Low => "low",
                ReasoningLevel::Medium => "medium",
                ReasoningLevel::High => "high",
                ReasoningLevel::XHigh => "xhigh",
                ReasoningLevel::Max => "max",
                ReasoningLevel::Ultra => "ultra",
                ReasoningLevel::Ultracode => "ultracode",
                ReasoningLevel::Ultrathink => "ultrathink",
            }
            .into()
        })
}

fn default_acp_model(reasoning_levels: Vec<ReasoningLevel>) -> Model {
    Model {
        id: "default".into(),
        label: "Agent default".into(),
        description: Some("Model selected by the ACP agent".into()),
        reasoning_levels,
        options: vec![],
    }
}

async fn set_session_model(
    connection: &ConnectionTo<Agent>,
    session_id: &SessionId,
    model: Option<&str>,
    config_options: Option<&[SessionConfigOption]>,
) -> agent_client_protocol::Result<Option<Vec<SessionConfigOption>>> {
    let Some(model) = model.filter(|model| *model != "default") else {
        return Ok(None);
    };
    let config_id = config_options
        .and_then(model_config_option)
        .map(|option| option.id.clone())
        .unwrap_or_else(|| "model".into());
    let response = connection
        .send_request(SetSessionConfigOptionRequest::new(
            session_id.clone(),
            config_id,
            model,
        ))
        .block_task()
        .await;
    match response {
        Ok(response) => Ok(Some(response.config_options)),
        Err(error) if is_legacy_config_option_response(&error) => {
            tracing::debug!(
                target: "comet_harness::acp",
                %error,
                "ACP agent omitted configOptions after setting the model"
            );
            Ok(None)
        }
        // codex-acp rejects unknown model ids (custom-provider models not in
        // its own catalog) with "Invalid params". The model is already
        // configured via CODEX_CONFIG env, so this is non-fatal.
        Err(error) if is_invalid_params_response(&error) => {
            tracing::debug!(
                target: "comet_harness::acp",
                %error,
                model,
                "ACP agent rejected model config option; relying on env-configured model"
            );
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

async fn set_session_reasoning(
    connection: &ConnectionTo<Agent>,
    session_id: &SessionId,
    reasoning: Option<ReasoningLevel>,
    config_options: Option<&[SessionConfigOption]>,
) -> agent_client_protocol::Result<()> {
    let Some(reasoning) = reasoning else {
        return Ok(());
    };
    let Some(option) = config_options.and_then(thought_level_config_option) else {
        return Ok(());
    };
    let value = reasoning_level_acp_value(reasoning, Some(option));
    let response = connection
        .send_request(SetSessionConfigOptionRequest::new(
            session_id.clone(),
            option.id.clone(),
            value.as_str(),
        ))
        .block_task()
        .await;
    match response {
        Ok(_) => Ok(()),
        Err(error) if is_legacy_config_option_response(&error) => {
            tracing::debug!(
                target: "comet_harness::acp",
                %error,
                "ACP agent omitted configOptions after setting reasoning"
            );
            Ok(())
        }
        Err(error) => Err(error),
    }
}

async fn set_session_permission_mode(
    connection: &ConnectionTo<Agent>,
    session_id: &SessionId,
    mode: PermissionMode,
    config_options: Option<&[SessionConfigOption]>,
) -> agent_client_protocol::Result<Option<Vec<SessionConfigOption>>> {
    let Some(option) = config_options.and_then(mode_config_option) else {
        return Ok(None);
    };
    let aliases: &[&str] = match mode {
        PermissionMode::Default => &["default", "ask", "askbeforeedits"],
        PermissionMode::Plan => &["plan", "planning", "readonly"],
        PermissionMode::AcceptEdits => &["acceptedits", "autoedit", "edit"],
        PermissionMode::FullAccess => &["fullaccess", "bypasspermissions", "yolo"],
    };
    let Some(value) = select_choices(option).into_iter().find_map(|choice| {
        let value = normalize_config_name(&choice.value.to_string());
        let name = normalize_config_name(&choice.name);
        aliases
            .iter()
            .any(|alias| value == *alias || name == *alias)
            .then(|| choice.value.to_string())
    }) else {
        return Ok(None);
    };
    let response = connection
        .send_request(SetSessionConfigOptionRequest::new(
            session_id.clone(),
            option.id.clone(),
            value.as_str(),
        ))
        .block_task()
        .await?;
    Ok(Some(response.config_options))
}

fn is_legacy_config_option_response(error: &agent_client_protocol::Error) -> bool {
    let error = error.to_string();
    error.contains("missing field 'configOptions'")
        || error.contains("missing field `configOptions`")
}

/// JSON-RPC -32602 "Invalid params": codex-acp rejects `setConfigOption` calls
/// for model ids it doesn't know about (custom-provider models).
fn is_invalid_params_response(error: &agent_client_protocol::Error) -> bool {
    use agent_client_protocol::schema::v1::ErrorCode;
    error.code == ErrorCode::InvalidParams
}

fn absolute_cwd(cwd: &str) -> PathBuf {
    let path = PathBuf::from(cwd);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    }
}

fn prompt_content(
    request: &RunRequest,
    prompt_transform: fn(Option<ReasoningLevel>, &str) -> String,
) -> Vec<ContentBlock> {
    let transformed = prompt_transform(request.reasoning, &request.prompt);
    let mut content = vec![ContentBlock::Text(TextContent::new(transformed))];
    for attachment in &request.attachments {
        if let Some(image) = image_content(Path::new(attachment)) {
            content.push(image);
        }
    }
    content
}

fn image_content(path: &Path) -> Option<ContentBlock> {
    let mime_type = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    };
    let data = std::fs::read(path).ok()?;
    Some(ContentBlock::Image(
        agent_client_protocol::schema::v1::ImageContent::new(
            base64::engine::general_purpose::STANDARD.encode(data),
            mime_type,
        )
        .uri(format!("file://{}", path.display())),
    ))
}

fn normalize_update(
    update: SessionUpdate,
    completed_tools: &Mutex<HashSet<String>>,
) -> Vec<AgentEvent> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => match chunk.content {
            ContentBlock::Text(text) => vec![AgentEvent::TextDelta { text: text.text }],
            _ => vec![],
        },
        SessionUpdate::AgentThoughtChunk(chunk) => match chunk.content {
            ContentBlock::Text(text) => vec![AgentEvent::ReasoningDelta { text: text.text }],
            _ => vec![],
        },
        SessionUpdate::ToolCall(tool) => {
            let id = tool.tool_call_id.to_string();
            let mut events = vec![AgentEvent::ToolCall {
                id: id.clone(),
                call: normalize_tool_call(&tool),
            }];
            if matches!(
                tool.status,
                ToolCallStatus::Completed | ToolCallStatus::Failed
            ) {
                completed_tools.lock().unwrap().insert(id.clone());
                events.push(AgentEvent::ToolResult {
                    id,
                    is_error: tool.status == ToolCallStatus::Failed,
                });
            }
            events
        }
        SessionUpdate::ToolCallUpdate(update) => {
            let id = update.tool_call_id.to_string();
            let Some(status) = update.fields.status else {
                return vec![];
            };
            if !matches!(status, ToolCallStatus::Completed | ToolCallStatus::Failed)
                || !completed_tools.lock().unwrap().insert(id.clone())
            {
                return vec![];
            }
            vec![AgentEvent::ToolResult {
                id,
                is_error: status == ToolCallStatus::Failed,
            }]
        }
        SessionUpdate::UsageUpdate(usage) => vec![normalize_usage(&usage)],
        SessionUpdate::SessionInfoUpdate(info) => normalize_session_info(&info),
        SessionUpdate::Plan(plan) => normalize_plan(&plan),
        // Echo of the user's own message — the engine already persists the
        // prompt; re-streaming it would duplicate the user turn.
        SessionUpdate::UserMessageChunk(_) => vec![],
        // Config/mode/command updates are session-internal metadata with no
        // corresponding transcript rendering.
        SessionUpdate::ConfigOptionUpdate(_)
        | SessionUpdate::CurrentModeUpdate(_)
        | SessionUpdate::AvailableCommandsUpdate(_) => vec![],
        _ => vec![],
    }
}

fn normalize_usage(usage: &UsageUpdate) -> AgentEvent {
    // ACP reports cumulative context tokens (`used`) and the total window
    // size (`size`), not an input/output split. Map `used` to input_tokens
    // (the dominant component) and leave output_tokens at zero since the
    // protocol does not break it out.
    AgentEvent::Usage {
        input_tokens: usage.used,
        output_tokens: 0,
    }
}

fn normalize_session_info(info: &SessionInfoUpdate) -> Vec<AgentEvent> {
    match &info.title {
        MaybeUndefined::Value(title) if !title.trim().is_empty() => {
            vec![AgentEvent::SessionTitle {
                title: title.clone(),
            }]
        }
        _ => vec![],
    }
}

fn normalize_plan(plan: &Plan) -> Vec<AgentEvent> {
    let items: Vec<comet_proto::TodoItem> = plan
        .entries
        .iter()
        .map(|entry| comet_proto::TodoItem {
            text: entry.content.clone(),
            done: entry.status == PlanEntryStatus::Completed,
        })
        .collect();
    if items.is_empty() {
        return vec![];
    }
    vec![AgentEvent::ToolCall {
        id: "acp-plan".to_string(),
        call: CometToolCall::Todo { items },
    }]
}

fn normalize_tool_call(tool: &ToolCall) -> CometToolCall {
    let input = tool.raw_input.clone();
    let field = |name: &str| {
        input
            .as_ref()
            .and_then(|value| value.get(name))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let path = tool
        .locations
        .first()
        .map(|location| location.path.display().to_string())
        .or_else(|| field("path"))
        .unwrap_or_default();
    match tool.kind {
        ToolKind::Execute => CometToolCall::Exec {
            command: field("command").unwrap_or_else(|| tool.title.clone()),
        },
        ToolKind::Read => CometToolCall::ReadFile { path },
        ToolKind::Edit | ToolKind::Delete | ToolKind::Move => CometToolCall::EditFile {
            path,
            old_string: None,
            new_string: None,
        },
        ToolKind::Search => CometToolCall::Search {
            pattern: field("query")
                .or_else(|| field("pattern"))
                .unwrap_or_else(|| tool.title.clone()),
            path: (!path.is_empty()).then_some(path),
        },
        ToolKind::Fetch => field("url").map_or_else(
            || CometToolCall::Unknown {
                name: tool.title.clone(),
                input,
            },
            |url| CometToolCall::WebFetch { url, prompt: None },
        ),
        _ => CometToolCall::Unknown {
            name: tool.title.clone(),
            input,
        },
    }
}

async fn permission_outcome(
    request: &RequestPermissionRequest,
    permission_mode: PermissionMode,
    request_input: &InputRequester,
) -> RequestPermissionOutcome {
    let edit = matches!(
        request.tool_call.fields.kind,
        Some(ToolKind::Edit | ToolKind::Delete | ToolKind::Move)
    );
    if permission_mode == PermissionMode::Plan
        && edit
        && let Some(option) = preferred_reject_option(&request.options)
    {
        return RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            option.option_id.clone(),
        ));
    }
    if (permission_mode == PermissionMode::FullAccess
        || (permission_mode == PermissionMode::AcceptEdits && edit))
        && let Some(option) = preferred_allow_option(&request.options)
    {
        return RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            option.option_id.clone(),
        ));
    }
    let labels: Vec<String> = request
        .options
        .iter()
        .map(|option| option.name.clone())
        .collect();
    let question_id = request.tool_call.tool_call_id.to_string();
    let answers = request_input(vec![UserInputQuestion {
        id: question_id.clone(),
        header: "Permission".into(),
        question: request
            .tool_call
            .fields
            .title
            .clone()
            .unwrap_or_else(|| "Allow this ACP tool call?".into()),
        options: labels,
        multi_select: false,
    }])
    .await
    .unwrap_or_default();
    let selected = answers
        .iter()
        .find(|answer| answer.question_id == question_id)
        .and_then(|answer| answer.labels.first());
    request
        .options
        .iter()
        .find(|option| selected == Some(&option.name))
        .map(|option| {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                option.option_id.clone(),
            ))
        })
        .unwrap_or(RequestPermissionOutcome::Cancelled)
}

fn preferred_allow_option(options: &[PermissionOption]) -> Option<&PermissionOption> {
    options
        .iter()
        .find(|option| option.kind == PermissionOptionKind::AllowAlways)
        .or_else(|| {
            options
                .iter()
                .find(|option| option.kind == PermissionOptionKind::AllowOnce)
        })
}

fn preferred_reject_option(options: &[PermissionOption]) -> Option<&PermissionOption> {
    options
        .iter()
        .find(|option| option.kind == PermissionOptionKind::RejectAlways)
        .or_else(|| {
            options
                .iter()
                .find(|option| option.kind == PermissionOptionKind::RejectOnce)
        })
}

fn done_from_stop_reason(reason: StopReason) -> (DoneStatus, Option<String>) {
    match reason {
        StopReason::EndTurn => (DoneStatus::Completed, None),
        StopReason::Cancelled => (DoneStatus::Interrupted, None),
        StopReason::MaxTokens => (
            DoneStatus::Errored,
            Some("ACP agent reached its maximum token limit".into()),
        ),
        StopReason::MaxTurnRequests => (
            DoneStatus::Errored,
            Some("ACP agent reached its maximum turn-request limit".into()),
        ),
        StopReason::Refusal => (
            DoneStatus::Errored,
            Some("ACP agent refused the request".into()),
        ),
        _ => (
            DoneStatus::Errored,
            Some("ACP agent stopped unexpectedly".into()),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{ToolCallLocation, ToolCallUpdateFields};

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
}
