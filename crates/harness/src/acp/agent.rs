//! The Tokio subprocess transport for ACP agents, plus process-tree memory
//! accounting.
//!
//! agent-client-protocol 2.0 uses async-process for child pipes. Its readers
//! busy-poll at idle on both macOS and Linux (upstream issue #254), consuming
//! most of a core per parked ACP session. Comet already runs a Tokio runtime,
//! so we keep the SDK's protocol implementation and supply it Tokio child
//! pipes.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::{
    AcpAgent, AcpAgentConfig, Agent, ConnectTo, LineDirection, Lines,
};
use futures::{AsyncBufReadExt, StreamExt};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

type DebugCallback = Arc<dyn Fn(&str, LineDirection) + Send + Sync + 'static>;
/// Optional observer invoked for each line the agent writes to its own
/// stderr (in addition to the debug logger). The harness uses this to
/// detect the agent's internal turn-completion markers (see
/// [`is_turn_completion_line`]) as an early `Done` signal for agents that
/// stream everything via notifications but never answer `session/prompt`.
type StderrObserver = Arc<dyn Fn(&str) + Send + Sync + 'static>;

/// Tokio-native replacement for the SDK's `AcpAgent` subprocess transport.
///
/// agent-client-protocol 2.0 uses async-process for child pipes. Its readers
/// busy-poll at idle on both macOS and Linux (upstream issue #254), consuming
/// most of a core per parked ACP session. Comet already runs a Tokio runtime,
/// so keep the SDK's protocol implementation and supply it Tokio child pipes.
pub(super) struct TokioAcpAgent {
    config: AcpAgentConfig,
    debug: DebugCallback,
    stderr_observer: Option<StderrObserver>,
    /// Where to record the spawned agent's PID so the memory-poll task can find
    /// it. On Unix the `/bin/sh` shim writes its own (pre-`exec`) PID, so this
    /// stays `None`. On Windows there is no exec-replace shim: the child PID is
    /// captured at spawn and written here instead.
    pid_file: Option<PathBuf>,
}

impl TokioAcpAgent {
    pub(super) fn new(agent: AcpAgent) -> Self {
        Self {
            config: agent.into_config(),
            debug: Arc::new(log_acp_line),
            stderr_observer: None,
            pid_file: None,
        }
    }

    /// Watch the agent's own stderr for turn-completion markers. The
    /// observer runs for every line the agent writes to stderr, after the
    /// debug logger.
    pub(super) fn with_stderr_observer(mut self, observer: Option<StderrObserver>) -> Self {
        self.stderr_observer = observer;
        self
    }

    pub(super) fn with_pid_file(mut self, pid_file: Option<PathBuf>) -> Self {
        self.pid_file = pid_file;
        self
    }

    /// Merge additional env vars into the subprocess environment. Later calls
    /// to the same key overwrite earlier ones; values from the original
    /// command config are preserved unless overridden.
    pub(super) fn with_extra_env(mut self, extra: HashMap<String, String>) -> Self {
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
        let program = self.config.command();
        let program_args = self.config.arguments().to_vec();
        let env = self.config.environment().clone();

        // On Windows, `.cmd` and `.bat` files are batch scripts, not real
        // executables. `CreateProcessW` (which underlies
        // `tokio::process::Command::spawn`) cannot execute them directly and
        // fails with OS error 193 ("%1 is not a valid Win32 application").
        // Route them through `cmd.exe /C`, which handles batch scripts
        // correctly.
        #[cfg(windows)]
        let mut command = if program
            .extension()
            .is_some_and(|ext| matches!(ext.to_str(), Some("cmd" | "bat")))
        {
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.arg("/C").arg(program).args(&program_args);
            cmd
        } else {
            let mut cmd = tokio::process::Command::new(program);
            cmd.args(&program_args);
            cmd
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut cmd = tokio::process::Command::new(program);
            cmd.args(program_args);
            cmd
        };

        command
            .envs(env)
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
        // child's PID directly â€” it is the root of the agent's process tree.
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
        let stderr_observer = self.stderr_observer.clone();
        let stderr_task = tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt as _;

            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stderr_debug(&line, LineDirection::Stderr);
                if let Some(observer) = &stderr_observer {
                    observer(&line);
                }
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

/// Detect an ACP agent's own stderr log line announcing that its current
/// turn finished.
///
/// Agents like codex-acp and grok-build-acp write their internal LLM-stream
/// logs to stderr: the terminal `sse_chunk` carries `finish_reason:"stop"`
/// and is followed by a `turn summary generated` line. Both mean the model
/// completed the turn — even though the agent may never send the JSON-RPC
/// `session/prompt` response (the grok-build-acp bug). The harness treats
/// either marker as an early completion signal so `Done(Completed)` is
/// synthesized immediately instead of waiting out the idle watchdog.
pub(super) fn is_turn_completion_line(line: &str) -> bool {
    line.contains("turn summary generated")
        || line.contains("\"finish_reason\":\"stop\"")
        || line.contains("\"finish_reason\": \"stop\"")
}

fn log_acp_line(line: &str, direction: LineDirection) {
    match direction {
        LineDirection::Stderr => tracing::warn!(stderr = %line, "ACP agent stderr"),
        LineDirection::Stdout => {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
                    tracing::info!(
                        target: "comet_harness::acp",
                        method = %method,
                        id = ?value.get("id"),
                        "ACP agent sent JSON-RPC message"
                    );
                }
                if let Some(error) = value.get("error") {
                    tracing::warn!(error = %error, "ACP agent returned a protocol error");
                }
            }
        }
        LineDirection::Stdin => {}
    }
}

#[cfg(unix)]
pub(super) fn instrument_agent_for_memory(agent: AcpAgent) -> (AcpAgent, Option<PathBuf>) {
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
pub(super) fn instrument_agent_for_memory(agent: AcpAgent) -> (AcpAgent, Option<PathBuf>) {
    // No exec-replace shim on Windows: the spawned child's PID is captured in
    // `TokioAcpAgent::connect_to` (see `with_pid_file`). Return the agent
    // unwrapped alongside a fresh pid file so the poll task has somewhere to
    // read from.
    let pid_file = std::env::temp_dir().join(format!("comet-acp-{}.pid", uuid::Uuid::new_v4()));
    (agent, Some(pid_file))
}

/// Build the codex-acp env vars that configure a custom provider inline,
/// mirroring the old native harness's `-c model_provider="custom" ...` flags.
/// codex-acp reads `MODEL_PROVIDER`, `CODEX_CONFIG` (merged into the session
/// config), and `CODEX_API_KEY`. The selected model id is included so codex-acp
/// uses it directly without needing a `session/setConfigOption` round-trip
/// that the adapter would reject for an unknown model.
/// Inject the user's selected model into a Grok agent's argv.
///
/// Grok's `grok agent stdio` ACP server does **not** implement the standard
/// `session/setConfigOption` method (it returns JSON-RPC `-32601 Method not
/// found`), so the app's model pick never reaches it through that path and
/// Grok falls back to its `[models] default` from `~/.grok/config.toml`. The
/// model is only honoured when passed on the command line: the parent
/// `grok agent` subcommand accepts `-m / --model <MODEL>` (and, symmetrically,
/// `--reasoning-effort <EFFORT>`).
///
/// This rewrites the agent's argv from `[…, "agent", "stdio"]` to
/// `[…, "agent", "-m", <model>, "stdio"]`, inserting the flag immediately
/// before `stdio` so it lands on the `agent` subcommand rather than the
/// `stdio` child. Returns the agent unchanged for non-Grok commands or when
/// no concrete model was selected (`None` / `"default"`).
pub(super) fn inject_grok_model_args(agent: AcpAgent, model: Option<&str>) -> AcpAgent {
    let Some(model) = model.filter(|model| {
        !model.is_empty() && *model != "default"
    }) else {
        return agent;
    };
    let config = agent.into_config();
    let mut new_args = config.arguments().to_vec();

    // Insert `-m <model>` immediately before the trailing `stdio` token (the
    // `agent` subcommand owns the flag). If the args don't match the expected
    // `["agent", "stdio"]` shape, append at the end as a safe fallback so the
    // flag is still present.
    if let Some(pos) = new_args.iter().rposition(|arg| arg.as_str() == "stdio") {
        new_args.insert(pos, "-m".to_string());
        new_args.insert(pos + 1, model.to_string());
    } else {
        new_args.push("-m".to_string());
        new_args.push(model.to_string());
    }

    AcpAgent::new(
        AcpAgentConfig::new(config.command())
            .args(new_args)
            .envs(config.environment().clone()),
    )
}

pub(super) fn codex_custom_provider_env(
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

pub(super) async fn poll_process_memory(
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
