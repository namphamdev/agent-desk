//! Generic Agent Client Protocol harness.
//!
//! `COMET_ACP_AGENT` accepts the command string or JSON configuration understood
//! by the official `agent-client-protocol` Rust SDK's [`AcpAgent`]. The adapter
//! normalizes ACP session updates into Comet events and keeps the ACP session
//! alive across turns.
//!
//! The implementation is split into focused submodules:
//! - [`command`]: resolving the agent launch command (built-in specs,
//!   `acp-agents.json`, `COMET_ACP_AGENT`, Windows shim handling)
//! - [`agent`]: the Tokio subprocess transport and process-tree memory
//!   accounting
//! - [`session`]: the live session loop (handshake, config, prompt/steer)
//! - [`models`]: model discovery (config options, Grok fast paths)
//! - [`events`]: ACP update normalization and permission handling

mod agent;
mod ask_user_question;
mod command;
mod events;
mod exit_plan_mode;
mod models;
mod session;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    CreateElicitationRequest, NewSessionRequest, RequestPermissionRequest,
    RequestPermissionResponse, SessionConfigOption, SessionNotification,
};
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};
use async_trait::async_trait;
use futures::stream::BoxStream;
use futures::StreamExt;
use tokio::sync::mpsc;

use comet_proto::{AgentEvent, DoneStatus, HarnessId, Model, ReasoningLevel, RunRequest, SteeringMode};

use crate::{Harness, HarnessError, RunControls};

use agent::{
    codex_custom_provider_env, inject_grok_model_args, instrument_agent_for_memory,
    poll_process_memory, TokioAcpAgent,
};
use ask_user_question::AskUserQuestionHandler;
use exit_plan_mode::ExitPlanModeHandler;
use command::{
    normalize_acp_command, resolve_agent_command_string, resolve_spec_command, AcpHarnessConfig,
};
use events::{elicitation_response, normalize_update, permission_outcome};
use models::{
    default_acp_model, grok_cached_models, grok_cli_models, is_codex_command_for, is_grok_command,
    models_from_config_options,
};
use session::{authenticate_if_needed, initialize, run_connection};

pub use agent::sample_process_tree_rss_bytes;

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
    /// `npx -y <package>` fallback when the binary isn't installed â€” pinned
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

/// Resolve environment variables the agent subprocess needs but may not
/// inherit when Comet runs as a GUI app or daemon.
///
/// On macOS, GUI/service launches skip the user's shell init, so variables
/// exported in `~/.zshrc` (e.g. `XAI_API_KEY`) are missing from the process
/// environment. The Grok ACP agent reads `XAI_API_KEY` from its own env for
/// inference requests; without it, the agent falls back to a cached OAuth
/// token that may be expired, causing every inference call to fail with
/// HTTP 401 even though the ACP `authenticate` handshake reported success.
///
/// This function bridges the gap: when `XAI_API_KEY` is not already in the
/// process env, it is resolved from the login-shell snapshot and injected
/// into the child's env. The snapshot is captured once (cached) and shared
/// across all agent spawns.
fn agent_resolved_env(command: &str) -> Option<HashMap<String, String>> {
    // Only inject for Grok agents — other agents don't read XAI_API_KEY.
    if !is_grok_command(command) {
        return None;
    }
    // If XAI_API_KEY is already in the process env, the subprocess inherits
    // it automatically; no injection needed.
    if std::env::var_os("XAI_API_KEY").is_some() {
        return None;
    }
    let key = crate::shell_env::login_shell_env_var("XAI_API_KEY")?;
    let mut env = HashMap::new();
    env.insert(
        "XAI_API_KEY".into(),
        key.to_string_lossy().into_owned(),
    );
    Some(env)
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

    /// Claude Code over ACP â€” the org-maintained `claude-agent-acp` adapter
    /// on the Claude Agent SDK.
    pub fn claude() -> Self {
        Self {
            spec: Some(claude_spec()),
            ..Self::default()
        }
    }

    /// Codex over ACP â€” the org-maintained `codex-acp` adapter wrapping the
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
        eprintln!("[TRACE:command_for] agent_id={:?}", agent_id);
        if let Some(spec) = &self.spec {
            // An explicit command override (tests) wins over spec resolution.
            if let Some(cmd) = &self.command {
                eprintln!("[TRACE:command_for] spec with explicit command override");
                return Ok(cmd.clone());
            }
            eprintln!("[TRACE:command_for] spec-backed, resolving spec command");
            return resolve_spec_command(spec);
        }
        eprintln!("[TRACE:command_for] config_file={:?}, command={:?}", self.config_file, self.command);
        let result = self
            .command
            .clone()
            .or_else(|| std::env::var(ENV_AGENT).ok())
            .or_else(|| {
                let file = self.config_file.as_ref()?;
                eprintln!("[TRACE:command_for] reading config file: {:?}", file);
                let json = std::fs::read_to_string(file).ok()?;
                eprintln!("[TRACE:command_for] config file read OK, {} bytes", json.len());
                let config: AcpHarnessConfig = serde_json::from_str(&json).ok()?;
                eprintln!("[TRACE:command_for] parsed config: {} agents, active={:?}", config.agents.len(), config.active_agent_id);
                // Prefer the explicitly requested agent id; fall back to active.
                let wanted = agent_id
                    .filter(|id| config.agents.iter().any(|a| &a.id == id))
                    .or(config.active_agent_id.as_deref());
                eprintln!("[TRACE:command_for] wanted agent id = {:?}", wanted);
                config
                    .agents
                    .into_iter()
                    .find(|agent| Some(agent.id.as_str()) == wanted)
                    .map(|agent| {
                        eprintln!("[TRACE:command_for] found agent: id={} command={}", agent.id, &agent.command[..agent.command.len().min(200)]);
                        agent.command
                    })
            });
        let command = result
            .map(normalize_acp_command)
            .filter(|command| !command.trim().is_empty())
            .ok_or_else(|| {
                eprintln!("[TRACE:command_for] ERROR: no command resolved");
                HarnessError::NotInstalled(format!(
                    "ACP agent is not configured; add one in Settings > ACP agents or set \
                     {ENV_AGENT}"
                ))
            })?;
        eprintln!("[TRACE:command_for] resolving agent command string...");
        let resolved = resolve_agent_command_string(&command);
        match &resolved {
            Ok(cmd) => eprintln!("[TRACE:command_for] resolved OK"),
            Err(e) => eprintln!("[TRACE:command_for] resolve ERROR: {e}"),
        }
        resolved
    }
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
        eprintln!("[TRACE:models] called acp_agent_id={:?}", acp_agent_id);
        let command = self.command_for(acp_agent_id)?;
        eprintln!("[TRACE:models] resolved command: {}", &command[..command.len().min(200)]);
        let mut cached_models = self.discovered_models.lock().await;
        if let Some(models) = cached_models.get(&command) {
            eprintln!("[TRACE:models] cache hit: {} models", models.len());
            return Ok(models.clone());
        }
        drop(cached_models);

        // Grok-specific fast path: read the models cache file or run
        // `grok models` instead of the ACP session/new handshake. Grok does
        // not populate the standard configOptions field; its model list is
        // only available via the CLI subcommand or the local cache file.
        if is_grok_command(&command) {
            // Try the cache file first — it doesn't require network access
            // or XAI_API_KEY, which the daemon process may not have.
            match grok_cached_models() {
                Ok(models) if !models.is_empty() => {
                    eprintln!("[TRACE:models] grok cache file returned {} models", models.len());
                    let mut cached_models = self.discovered_models.lock().await;
                    cached_models.insert(command, models.clone());
                    return Ok(models);
                }
                Ok(_) => {
                    eprintln!("[TRACE:models] grok cache file returned 0 models; trying CLI");
                }
                Err(error) => {
                    eprintln!("[TRACE:models] grok cache file failed: {error}; trying CLI");
                }
            }
            match grok_cli_models(&command).await {
                Ok(models) if !models.is_empty() => {
                    eprintln!("[TRACE:models] grok CLI returned {} models", models.len());
                    let mut cached_models = self.discovered_models.lock().await;
                    cached_models.insert(command, models.clone());
                    return Ok(models);
                }
                Ok(_) => {
                    eprintln!("[TRACE:models] grok CLI returned 0 models; falling back to ACP discovery");
                }
                Err(error) => {
                    eprintln!("[TRACE:models] grok CLI failed: {error}; falling back to ACP discovery");
                }
            }
        }

        let agent = AcpAgent::from_str(&command).map_err(|error| {
            HarnessError::Protocol(format!("invalid ACP agent config: {error}"))
        })?;
        let agent = TokioAcpAgent::new(agent)
            .with_extra_env(agent_resolved_env(&command).unwrap_or_default());
        let discovered_models = Arc::new(Mutex::new(None));
        let notification_config_options: Arc<Mutex<Vec<SessionConfigOption>>> =
            Arc::new(Mutex::new(Vec::new()));
        let probe_config_options = notification_config_options.clone();
        let discovery_result = agent_client_protocol::Client
            .builder()
            .on_receive_notification(
                {
                    let probe_config_options = probe_config_options.clone();
                    async move |notification: SessionNotification, _cx| {
                        eprintln!(
                            "[TRACE:models] notification: update_type={:?}",
                            notification.update
                        );
                        if let agent_client_protocol::schema::v1::SessionUpdate::ConfigOptionUpdate(update) =
                            &notification.update
                        {
                            eprintln!(
                                "[TRACE:models] ConfigOptionUpdate notification: {} options",
                                update.config_options.len()
                            );
                            probe_config_options
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .extend(update.config_options.iter().cloned());
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .connect_with(agent, {
                let discovered_models = discovered_models.clone();
                move |connection: ConnectionTo<Agent>| async move {
                    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
                    // Initialize and authenticate. Grok (`grok agent stdio`)
                    // requires a successful `authenticate` before `session/new`
                    // will return `configOptions` (the model list). We use the
                    // same hard-failing auth as the live run path so that auth
                    // errors surface clearly instead of silently producing an
                    // empty model list.
                    let init_response = initialize(&connection).await?;
                    eprintln!(
                        "[TRACE:models] initialize Ok: protocol={:?}, auth_methods={:?}",
                        init_response.protocol_version,
                        init_response.auth_methods,
                    );
                    match authenticate_if_needed(&connection, &init_response).await {
                        Ok(()) => {
                            eprintln!("[TRACE:models] authenticate_if_needed Ok");
                        }
                        Err(error) => {
                            eprintln!(
                                "[TRACE:models] authenticate_if_needed FAILED: {error}"
                            );
                            // For agents that advertise auth methods (e.g.
                            // Grok), session/new won't return configOptions
                            // without auth. Propagate the error so the caller
                            // sees a clear message instead of silently getting
                            // 0 models.
                            if !init_response.auth_methods.is_empty() {
                                return Err(error);
                            }
                            eprintln!(
                                "[TRACE:models] agent has no auth methods; \
                                 continuing to session/new despite auth error"
                            );
                        }
                    }
                    let response = connection
                        .send_request(NewSessionRequest::new(cwd))
                        .block_task()
                        .await?;
                    // Serialize the full response to JSON so we can see ALL
                    // fields, not just config_options. This helps diagnose
                    // whether Grok returns configOptions under a different key
                    // or format that the SDK's DefaultOnError deserializer
                    // silently drops.
                    let response_json = serde_json::to_string(&response)
                        .unwrap_or_else(|_| "<serialize failed>".into());
                    eprintln!(
                        "[TRACE:models] session/new Ok: config_options count={}, full response JSON={}",
                        response.config_options.as_deref().map(|opts| opts.len()).unwrap_or(0),
                        response_json,
                    );

                    // If session/new returned no config_options, check whether
                    // any ConfigOptionUpdate notifications arrived. Some agents
                    // (e.g. Grok) may send config options via a session/update
                    // notification instead of in the session/new response.
                    let mut effective_config_options = response.config_options.clone();
                    if effective_config_options.is_none() {
                        // Give the agent a moment to send any pending
                        // notifications before we check.
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        let notified = notification_config_options
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .clone();
                        if !notified.is_empty() {
                            eprintln!(
                                "[TRACE:models] recovered {} config options from notifications",
                                notified.len()
                            );
                            effective_config_options = Some(notified);
                        }
                    }

                    let models = models_from_config_options(effective_config_options.as_deref());
                    eprintln!("[TRACE:models] final model count: {}", models.len());
                    *discovered_models
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(models.clone());
                    Ok(models)
                }
            })
            .await;

        let models = match discovery_result {
            Ok(models) => {
                eprintln!("[models] discovery Ok â€” {} models", models.len());
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
                } else if is_codex_command_for(self.spec, &command) {
                    // codex-acp requires CODEX_API_KEY or OPENAI_API_KEY for
                    // authentication.  When neither is set the ACP authenticate
                    // call fails before session/new returns configOptions.
                    // Fall back to the curated catalog so the picker stays
                    // usable; the key is enforced again at run time via the
                    // custom-provider env or the inherited OPENAI_API_KEY.
                    tracing::debug!(
                        error = %error,
                        "codex model discovery failed; using static catalog"
                    );
                    crate::codex::catalog::static_models()
                } else {
                    tracing::debug!(
                        error = %error,
                        "ACP model discovery failed; using default model"
                    );
                    vec![default_acp_model(REASONING_LEVELS.to_vec())]
                }
            }
        };
        let mut cached_models = self.discovered_models.lock().await;
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
        // Idle-watchdog timestamp: updated on every `session/update`
        // notification and checked in the prompt-wait loop. If the agent
        // goes silent (no notifications, no prompt response) for longer
        // than the idle timeout, the harness synthesizes `Done(Completed)`
        // instead of hanging forever.
        let last_activity = Arc::new(Mutex::new(std::time::Instant::now()));
        let notification_activity = last_activity.clone();
        // Shared flag set while an agent-initiated request (elicitation,
        // permission) is pending. The idle watchdog checks this to avoid
        // synthesising EndTurn while the agent is legitimately blocked
        // waiting for user input.
        let pending_request = Arc::new(AtomicBool::new(false));
        let RunControls {
            request_input,
            steering,
            interrupt,
            report_memory,
        } = controls;
        let request_input = Arc::new(request_input);
        let permission_input = request_input.clone();
        let elicitation_input = request_input.clone();
        let ask_user_input = request_input.clone();
        let exit_plan_mode_input = request_input.clone();
        let elicitation_pending = pending_request.clone();
        let permission_pending = pending_request.clone();
        let ask_user_pending = pending_request.clone();
        let exit_plan_mode_pending = pending_request.clone();
        let permission_mode = request.effective_permission_mode();
        let mcp_server_url = self.mcp_server_url.clone();
        let prompt_transform = self
            .spec
            .map(|s| s.prompt_transform)
            .unwrap_or(identity_transform);
        let harness_id = self.id();

        // When the selected model belongs to a custom provider, build the
        // provider-specific env vars to inject into the codex-acp subprocess.
        // For Grok (and other ACP agents that read XAI_API_KEY from their
        // env), resolve the key from the login shell so GUI/daemon launches
        // that don't inherit the shell environment can still authenticate.
        let extra_env = if self.spec.is_some_and(|s| s.id == HarnessId::Codex) {
            request
                .custom_provider
                .as_ref()
                .map(|provider| codex_custom_provider_env(provider, request.model.as_deref()))
        } else {
            agent_resolved_env(&command)
        };

        tokio::spawn(async move {
            // Grok ignores `session/setConfigOption`, so the selected model is
            // handed over on the command line (`grok agent -m <model> stdio`)
            // rather than via the ACP session handshake. Non-Grok commands are
            // passed through unchanged.
            let agent = if is_grok_command(&command) {
                inject_grok_model_args(agent, request.model.as_deref())
            } else {
                agent
            };
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
                        // Update the idle-watchdog timestamp. This runs
                        // before the `live_updates` gate so the watchdog
                        // sees all notification activity, including
                        // pre-prompt replays (the timestamp is reset right
                        // before each prompt is sent, so those don't
                        // artificially extend the deadline).
                        *notification_activity
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            = std::time::Instant::now();
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
                        tracing::info!(
                            target: "comet_harness::acp",
                            "Received session/request_permission from agent"
                        );
                        permission_pending.store(true, Ordering::Relaxed);
                        let outcome = permission_outcome(
                            &permission,
                            permission_mode,
                            permission_input.as_ref().as_ref(),
                        )
                        .await;
                        permission_pending.store(false, Ordering::Relaxed);
                        responder.respond(RequestPermissionResponse::new(outcome))
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async move |elicitation: CreateElicitationRequest, responder, _cx| {
                        tracing::info!(
                            target: "comet_harness::acp",
                            message = %elicitation.message,
                            mode = ?elicitation.mode,
                            "Received elicitation/create request from agent"
                        );
                        elicitation_pending.store(true, Ordering::Relaxed);
                        let response = elicitation_response(
                            &elicitation,
                            elicitation_input.as_ref().as_ref(),
                        )
                        .await;
                        elicitation_pending.store(false, Ordering::Relaxed);
                        responder.respond(response)
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .with_handler(AskUserQuestionHandler::new(
                    ask_user_input,
                    ask_user_pending,
                ))
                .with_handler(ExitPlanModeHandler::new(
                    exit_plan_mode_input,
                    exit_plan_mode_pending,
                ))
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
                        last_activity.clone(),
                        pending_request.clone(),
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
