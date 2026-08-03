//! Lifecycle for the local vibervn code-context MCP server.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};

pub const MCP_URL: &str = "http://127.0.0.1:6699/mcp";
pub const DASHBOARD_URL: &str = "http://127.0.0.1:6699/";
const HEALTH_URL: &str = "http://127.0.0.1:6699/api/config";
const SETTINGS_FILE: &str = "context-engine-settings.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ContextEngineSettings {
    pub enabled: bool,
}

impl Default for ContextEngineSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl ContextEngineSettings {
    pub fn load(data_dir: &Path) -> Self {
        std::fs::read_to_string(Self::path(data_dir))
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(data_dir)?;
        let path = Self::path(data_dir);
        let temporary = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(self)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        std::fs::write(&temporary, json)?;
        std::fs::rename(temporary, path)
    }

    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join(SETTINGS_FILE)
    }
}

/// The environment remains an authoritative service/development override;
/// otherwise use the setting edited by the headed app.
pub fn enabled(data_dir: &Path) -> bool {
    environment_override().unwrap_or_else(|| ContextEngineSettings::load(data_dir).enabled)
}

pub fn environment_override() -> Option<bool> {
    match std::env::var("COMET_CONTEXT_ENGINE")
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some("0" | "false" | "off") => Some(false),
        Some("1" | "true" | "on") => Some(true),
        _ => None,
    }
}

/// A server Comet launched. `None` means an already-running server is reused.
pub struct ManagedContextEngine {
    child: Option<Child>,
}

impl ManagedContextEngine {
    /// Reuse port 6699 when it already serves HTTP, otherwise launch the
    /// published platform package through npx and wait until it is ready.
    pub async fn start(data_dir: &Path) -> anyhow::Result<Self> {
        if server_ready().await {
            tracing::info!(url = MCP_URL, "reusing context engine");
            return Ok(Self { child: None });
        }

        let work_dir = data_dir.join("context-engine");
        std::fs::create_dir_all(&work_dir)?;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(work_dir.join("context-engine.log"))?;
        let stderr = log.try_clone()?;
        let (program, prefix_args) = launch_command();
        let mut command = Command::new(&program);
        command
            .args(prefix_args)
            .args(["--port", "6699", "--bind", "127.0.0.1"])
            .current_dir(work_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(stderr))
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            command.as_std_mut().process_group(0);
        }
        let mut child = command.spawn()?;

        for _ in 0..120 {
            if server_ready().await {
                tracing::info!(url = MCP_URL, "context engine ready");
                return Ok(Self { child: Some(child) });
            }
            if let Some(status) = child.try_wait()? {
                anyhow::bail!("context engine exited during startup ({status})");
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        terminate(&mut child).await;
        anyhow::bail!("context engine did not become ready within 30 seconds")
    }

    pub async fn shutdown(&mut self) {
        if let Some(child) = &mut self.child {
            terminate(child).await;
        }
        self.child = None;
    }
}

impl Drop for ManagedContextEngine {
    fn drop(&mut self) {
        let Some(child) = &mut self.child else {
            return;
        };
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            }
        }
        let _ = child.start_kill();
    }
}

/// Prefer a global install, then npx's package resolver. The explicit
/// executable override is useful on service-managed hosts with a narrow PATH.
fn launch_command() -> (PathBuf, Vec<String>) {
    if let Some(path) =
        std::env::var_os("COMET_CONTEXT_ENGINE_EXECUTABLE").filter(|p| !p.is_empty())
    {
        return (PathBuf::from(path), Vec::new());
    }
    if let Some(path) = executable_on_path(if cfg!(windows) {
        "vibervn-context-engine.cmd"
    } else {
        "vibervn-context-engine"
    }) {
        return (path, Vec::new());
    }
    (
        PathBuf::from(if cfg!(windows) { "npx.cmd" } else { "npx" }),
        vec!["--yes".into(), "vibervn-context-engine@latest".into()],
    )
}

fn executable_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

async fn server_ready() -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
    else {
        return false;
    };
    client
        .get(HEALTH_URL)
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

async fn terminate(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The npx wrapper owns the router, which owns per-repo workers.
        // Signal the process group so all of them release their DB locks.
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
        }
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_ok()
        {
            return;
        }
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_executable_is_not_resolved() {
        assert!(executable_on_path("an-executable-that-does-not-exist").is_none());
    }

    #[test]
    fn settings_default_on_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ContextEngineSettings::load(dir.path()).enabled);
        let settings = ContextEngineSettings { enabled: false };
        settings.save(dir.path()).unwrap();
        assert_eq!(ContextEngineSettings::load(dir.path()), settings);
    }
}
