//! Cursor harness: spawns the installed `cursor-agent` (or `cursor`) CLI and
//! speaks its stream-json protocol.
//!
//! Cursor's CLI headless mode (`cursor-agent --print --output-format stream-json
//! --stream-partial-output`) emits NDJSON events very similar to Claude Code's:
//! `system`, `assistant`, `thinking`, `tool_call`, `tool_result`, and `result`
//! frames. Key differences from Claude:
//!
//! - No bidirectional control channel: tools are auto-approved in headless
//!   mode. There is no `can_use_tool` handshake, so the `request_input` bridge
//!   is never invoked (Cursor's AskUserQuestion equivalent is not exposed in
//!   the headless protocol yet).
//! - Steering: user lines written to stdin mid-run, consumed at turn
//!   boundaries (turn-boundary steering, like Codex).
//! - Interrupt: SIGTERM/SIGKILL escalation (no protocol-level interrupt frame
//!   exists in the current CLI).
//! - The prompt is passed as the last positional argument or via stdin.

mod catalog;
mod normalize;
mod wire;

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

use comet_proto::{
    AgentEvent, DoneStatus, HarnessId, Model, ReasoningLevel, RunRequest, SteeringMode,
};

use crate::{Harness, HarnessError, RunControls};
use catalog::static_models;
use normalize::Normalizer;

/// Locate the device's installed Cursor CLI: `CURSOR_EXECUTABLE`, then PATH,
/// then login-shell PATH, then known install locations.
/// Resolved per call — cheap after the snapshot is cached.
fn resolve_cursor_executable() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CURSOR_EXECUTABLE")
        && !p.is_empty()
    {
        return Some(PathBuf::from(p));
    }
    // Try both `cursor-agent` and `cursor` binary names.
    for exe in candidate_exe_names() {
        let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|path| {
                std::env::split_paths(&path)
                    .filter(|d| !d.as_os_str().is_empty())
                    .map(|d| d.join(exe))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(shell_path) = crate::shell_env::login_shell_path() {
            candidates.extend(
                std::env::split_paths(shell_path)
                    .filter(|d| !d.as_os_str().is_empty())
                    .map(|d| d.join(exe)),
            );
        }
        candidates.extend(known_install_dirs().into_iter().map(|d| d.join(exe)));
        candidates.extend(
            crate::node_version_manager_bins()
                .into_iter()
                .map(|d| d.join(exe)),
        );
        if let Some(found) = candidates.into_iter().find(|p| p.exists()) {
            return Some(found);
        }
    }
    None
}

fn candidate_exe_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["cursor-agent.exe", "cursor-agent.cmd", "cursor.cmd"]
    } else {
        &["cursor-agent", "cursor"]
    }
}

fn known_install_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    if let Some(home) = &home {
        // npm global install
        dirs.push(home.join(".npm-global").join("bin"));
        dirs.push(home.join(".local").join("bin"));
        // Cursor's own resources directory (where the CLI shim lives on some installs)
        if cfg!(target_os = "macos") {
            dirs.push(
                home.join("Library")
                    .join("Application Support")
                    .join("Cursor")
                    .join("bin"),
            );
        }
        if cfg!(windows) {
            dirs.push(home.join("AppData").join("Local").join("Programs").join("Cursor"));
            dirs.push(home.join("AppData").join("Roaming").join("npm"));
        }
    }
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    dirs
}

/// The Cursor harness. Construct with [`CursorHarness::new`]; tests point it
/// at a fake CLI with [`CursorHarness::with_executable`].
pub struct CursorHarness {
    executable: Option<PathBuf>,
    mcp_server_url: Option<String>,
    /// Grace between interrupt and SIGTERM.
    interrupt_grace: Duration,
    /// Grace between SIGTERM and SIGKILL.
    kill_grace: Duration,
}

impl Default for CursorHarness {
    fn default() -> Self {
        Self {
            executable: None,
            mcp_server_url: None,
            interrupt_grace: Duration::from_secs(2),
            kill_grace: Duration::from_secs(3),
        }
    }
}

impl CursorHarness {
    pub fn new() -> Self {
        Self::default()
    }

    /// Use a fixed CLI binary instead of PATH/known-location resolution.
    pub fn with_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.executable = Some(path.into());
        self
    }

    /// Add Comet's managed code-context MCP server to this invocation.
    pub fn with_mcp_server(mut self, url: impl Into<String>) -> Self {
        self.mcp_server_url = Some(url.into());
        self
    }

    /// Tune the interrupt→SIGTERM→SIGKILL escalation timing.
    pub fn with_graces(mut self, interrupt_grace: Duration, kill_grace: Duration) -> Self {
        self.interrupt_grace = interrupt_grace;
        self.kill_grace = kill_grace;
        self
    }

    fn resolve_executable(&self) -> Result<PathBuf, HarnessError> {
        if let Some(p) = &self.executable {
            return Ok(p.clone());
        }
        resolve_cursor_executable().ok_or_else(|| {
            HarnessError::NotInstalled(
                "cursor-agent (searched PATH, the login shell's PATH, \
                 ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, \
                 Cursor's Application Support/bin, and \
                 fnm/nvm/volta/pnpm/bun install dirs; set CURSOR_EXECUTABLE \
                 to override)"
                    .into(),
            )
        })
    }

    fn build_command(&self, exe: &PathBuf, request: &RunRequest) -> Command {
        let mut cmd = Command::new(exe);
        crate::compose_child_path(&mut cmd, exe);
        cmd.args([
            "--print",
            "--output-format",
            "stream-json",
            "--stream-partial-output",
        ]);

        if let Some(model) = &request.model {
            cmd.arg("--model");
            cmd.arg(model);
        }

        // Reasoning level maps to Cursor's effort levels.
        if let Some(effort) = to_effort(request.reasoning) {
            cmd.args(["--thinking-effort", effort]);
        }

        // Permission / auto-approve: Cursor uses --auto or --allowedTools in
        // headless mode.
        match request.effective_permission_mode() {
            comet_proto::PermissionMode::Default => {
                cmd.args(["--auto"]);
            }
            comet_proto::PermissionMode::Plan => {
                cmd.args(["--plan"]);
            }
            comet_proto::PermissionMode::AcceptEdits => {
                cmd.args(["--auto"]);
            }
            comet_proto::PermissionMode::FullAccess => {
                cmd.args(["--auto", "--dangerously-skip-permissions"]);
            }
        }

        // Resume an existing session.
        if let Some(resume) = &request.resume {
            cmd.arg("--resume");
            cmd.arg(resume);
        }

        // MCP server config.
        if let Some(url) = &self.mcp_server_url {
            cmd.arg("--mcp-config");
            cmd.arg(
                serde_json::json!({
                    "mcpServers": {
                        "codebase-retrieval": {
                            "type": "http",
                            "url": url,
                        }
                    }
                })
                .to_string(),
            );
        }

        if !request.cwd.is_empty() {
            cmd.current_dir(&request.cwd);
        }

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd
    }
}

/// Map the unified reasoning level to Cursor's `--thinking-effort` value.
fn to_effort(reasoning: Option<ReasoningLevel>) -> Option<&'static str> {
    match reasoning? {
        ReasoningLevel::Minimal => Some("none"),
        ReasoningLevel::Low => Some("low"),
        ReasoningLevel::Medium => Some("medium"),
        ReasoningLevel::High => Some("high"),
        ReasoningLevel::XHigh => Some("high"),
        ReasoningLevel::Max => Some("max"),
        // Ultra/Ultracode/Ultrathink are harness-specific tiers that Cursor
        // doesn't distinguish from max.
        ReasoningLevel::Ultra | ReasoningLevel::Ultracode | ReasoningLevel::Ultrathink => {
            Some("max")
        }
    }
}

#[async_trait]
impl Harness for CursorHarness {
    fn id(&self) -> HarnessId {
        HarnessId::Cursor
    }
    fn display_name(&self) -> &str {
        "Cursor"
    }
    fn supports_steering(&self) -> bool {
        true
    }
    fn steering_mode(&self) -> SteeringMode {
        SteeringMode::TurnBoundary
    }
    fn reasoning_levels(&self) -> &[ReasoningLevel] {
        &[
            ReasoningLevel::Low,
            ReasoningLevel::Medium,
            ReasoningLevel::High,
            ReasoningLevel::XHigh,
            ReasoningLevel::Max,
        ]
    }

    async fn models(&self, _acp_agent_id: Option<&str>) -> Result<Vec<Model>, HarnessError> {
        self.resolve_executable()?;
        Ok(static_models())
    }

    async fn run(
        &self,
        request: RunRequest,
        controls: RunControls,
    ) -> Result<BoxStream<'static, Result<AgentEvent, HarnessError>>, HarnessError> {
        let exe = self.resolve_executable()?;
        let mut cmd = self.build_command(&exe, &request);
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                HarnessError::NotInstalled(exe.display().to_string())
            } else {
                HarnessError::Io(e)
            }
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| HarnessError::Protocol("cursor child has no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| HarnessError::Protocol("cursor child has no stdout".into()))?;
        let stderr_tail = crate::StderrTail::default();
        if let Some(stderr) = child.stderr.take() {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "comet_harness::cursor", "stderr: {line}");
                    tail.push(&line);
                }
            });
        }

        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<StdinMsg>();
        tokio::spawn(stdin_writer(stdin, stdin_rx));

        // The initial prompt as the first stdin user line.
        let first = wire::user_message_line(&request.prompt);
        let _ = stdin_tx.send(StdinMsg::Line(first));

        let (event_tx, event_rx) = mpsc::channel::<Result<AgentEvent, HarnessError>>(256);
        tokio::spawn(run_session(Session {
            child,
            stdout_lines: BufReader::new(stdout).lines(),
            stdin_tx,
            event_tx,
            controls,
            interrupt_grace: self.interrupt_grace,
            kill_grace: self.kill_grace,
            stderr_tail,
        }));

        Ok(futures::stream::unfold(event_rx, |mut rx| async move {
            rx.recv().await.map(|ev| (ev, rx))
        })
        .boxed())
    }
}

enum StdinMsg {
    Line(String),
    Close,
}

async fn stdin_writer(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<StdinMsg>) {
    while let Some(msg) = rx.recv().await {
        match msg {
            StdinMsg::Line(line) => {
                let write = async {
                    stdin.write_all(line.as_bytes()).await?;
                    stdin.write_all(b"\n").await?;
                    stdin.flush().await
                };
                if let Err(e) = write.await {
                    tracing::debug!(target: "comet_harness::cursor", "stdin write failed (tolerated): {e}");
                    return;
                }
            }
            StdinMsg::Close => {
                let _ = stdin.shutdown().await;
                return;
            }
        }
    }
}

struct Session {
    child: Child,
    stdout_lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    stdin_tx: mpsc::UnboundedSender<StdinMsg>,
    event_tx: mpsc::Sender<Result<AgentEvent, HarnessError>>,
    controls: RunControls,
    interrupt_grace: Duration,
    kill_grace: Duration,
    stderr_tail: crate::StderrTail,
}

/// The per-run event loop: one task multiplexing stdout frames, the steering
/// mailbox, the interrupt token, and consumer liveness.
async fn run_session(session: Session) {
    let Session {
        mut child,
        mut stdout_lines,
        stdin_tx,
        event_tx,
        controls,
        interrupt_grace,
        kill_grace,
        stderr_tail,
    } = session;
    let RunControls {
        request_input: _,
        mut steering,
        interrupt,
        report_memory: _,
    } = controls;

    let mut norm = Normalizer::new();
    let mut steering_open = true;
    let mut interrupted = false;
    let mut interrupt_sent = false;
    let mut any_done = false;
    let mut done_after_interrupt = false;
    let mut escalation: Option<tokio::task::JoinHandle<()>> = None;

    'main: loop {
        tokio::select! {
            line = stdout_lines.next_line() => match line {
                Ok(Some(line)) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let frame = match wire::parse_frame(line) {
                        Ok(frame) => frame,
                        Err(e) => {
                            tracing::debug!(target: "comet_harness::cursor", "unparseable frame (skipped): {e}");
                            continue;
                        }
                    };
                    for ev in norm.normalize(frame, interrupted) {
                        let is_done = matches!(ev, AgentEvent::Done { .. });
                        if event_tx.send(Ok(ev)).await.is_err() {
                            break 'main;
                        }
                        if is_done {
                            any_done = true;
                            if interrupted {
                                done_after_interrupt = true;
                                break 'main;
                            }
                        }
                    }
                }
                Ok(None) => break 'main,
                Err(e) => {
                    let _ = event_tx.send(Err(HarnessError::Io(e))).await;
                    break 'main;
                }
            },

            steer = steering.recv(), if steering_open && !interrupted => match steer {
                Some(msg) => {
                    let line = wire::user_message_line(&msg.prompt);
                    let _ = stdin_tx.send(StdinMsg::Line(line));
                    let (prev, next) = norm.rotate_for_steer();
                    let ev = AgentEvent::Steered {
                        assistant_message_id: Some(prev),
                        next_assistant_message_id: Some(next),
                    };
                    if event_tx.send(Ok(ev)).await.is_err() {
                        break 'main;
                    }
                }
                None => {
                    steering_open = false;
                    let _ = stdin_tx.send(StdinMsg::Close);
                }
            },

            _ = interrupt.cancelled(), if !interrupt_sent => {
                interrupt_sent = true;
                interrupted = true;
                // Cursor has no protocol-level interrupt frame; escalate
                // directly to SIGTERM/SIGKILL after the grace period.
                if let Some(pid) = child.id() {
                    escalation = Some(tokio::spawn(async move {
                        tokio::time::sleep(interrupt_grace).await;
                        send_signal(pid, Signal::Term);
                        tokio::time::sleep(kill_grace).await;
                        send_signal(pid, Signal::Kill);
                    }));
                }
            },

            _ = event_tx.closed() => break 'main,
        }
    }

    // Terminal bookkeeping.
    if !event_tx.is_closed() {
        if interrupted && !done_after_interrupt {
            let _ = event_tx
                .send(Ok(AgentEvent::Done {
                    status: DoneStatus::Interrupted,
                    result: None,
                    error: None,
                    session_id: norm.session_id.clone(),
                }))
                .await;
        } else if !interrupted && !any_done {
            let status = child.try_wait().ok().flatten();
            let _ = event_tx
                .send(Ok(AgentEvent::Done {
                    status: DoneStatus::Errored,
                    result: None,
                    error: Some(crate::crash_message("cursor-agent", status, &stderr_tail)),
                    session_id: norm.session_id.clone(),
                }))
                .await;
        }
    }

    shutdown_child(&mut child, kill_grace).await;
    if let Some(handle) = escalation {
        handle.abort();
    }
}

async fn shutdown_child(child: &mut Child, kill_grace: Duration) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    if let Some(pid) = child.id() {
        send_signal(pid, Signal::Term);
        if tokio::time::timeout(kill_grace, child.wait()).await.is_ok() {
            return;
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

#[derive(Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

#[cfg(unix)]
fn send_signal(pid: u32, signal: Signal) {
    let sig = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    unsafe {
        libc::kill(pid as libc::pid_t, sig);
    }
}

#[cfg(not(unix))]
fn send_signal(_pid: u32, _signal: Signal) {}
