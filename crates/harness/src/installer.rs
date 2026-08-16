//! Harness binary health check + auto-install.
//!
//! Each harness (Claude Code, Codex, Cursor) depends on an external CLI binary
//! being available on the device. GUI-launched apps often miss the user's shell
//! PATH, so the harness resolvers search known locations extensively. When the
//! binary genuinely isn't installed, the error surfaces late — at `run()` or
//! `models()` time — as a `HarnessError::NotInstalled`.
//!
//! This module provides:
//!
//! - [`check_harness`]: a lightweight probe that reports whether the harness's
//!   binary is installed, available via npx fallback, or missing entirely.
//! - [`install_harness`]: runs `npm install -g <package>` for the harness's
//!   adapter package, so subsequent launches find the binary without the npx
//!   cold-start penalty.
//!
//! The install methods are npm-based because all three built-in harnesses
//! distribute through npm (`claude-agent-acp`, `codex-acp`, `cursor-agent`).

use std::path::PathBuf;
use std::time::Duration;

use comet_proto::{HarnessHealth, HarnessId, HarnessInstallResult};

/// The maximum time an npm install is allowed to run before being killed.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);

/// Per-harness metadata: what binary to look for and how to install it.
struct HarnessBinary {
    /// The binary name(s) searched on PATH (without extension; `.exe` is
    /// appended on Windows by the resolver).
    binaries: &'static [&'static str],
    /// The env var that overrides the binary path.
    env_override: &'static str,
    /// How to install this harness.
    install_method: InstallMethod,
}

/// The installation path for a harness binary.
enum InstallMethod {
    /// `npm install -g <package>` — used by ACP adapters (Claude, Codex).
    Npm {
        package: &'static str,
        /// `npx -y <package>` fallback when the binary isn't installed.
        npx_package: Option<&'static str>,
    },
    /// A shell install script — used by Cursor (not distributed via npm).
    Script {
        /// Command to run on macOS/Linux (`curl … | bash`).
        unix_command: &'static str,
        /// Command to run on Windows (`irm … | iex`).
        windows_command: &'static str,
        /// Human-readable URL for the error message / install hint.
        url: &'static str,
    },
}

fn harness_binary(id: HarnessId) -> Option<HarnessBinary> {
    match id {
        HarnessId::ClaudeCode => Some(HarnessBinary {
            binaries: &["claude-agent-acp"],
            env_override: "CLAUDE_ACP_EXECUTABLE",
            install_method: InstallMethod::Npm {
                package: "@agentclientprotocol/claude-agent-acp",
                npx_package: Some("@agentclientprotocol/claude-agent-acp"),
            },
        }),
        HarnessId::Codex => Some(HarnessBinary {
            binaries: &["codex-acp"],
            env_override: "CODEX_ACP_EXECUTABLE",
            install_method: InstallMethod::Npm {
                package: "@agentclientprotocol/codex-acp",
                npx_package: Some("@agentclientprotocol/codex-acp"),
            },
        }),
        HarnessId::Cursor => Some(HarnessBinary {
            // Cursor's CLI installs as `agent` (not `cursor-agent`); older
            // releases used `cursor-agent` and `cursor` as aliases.
            binaries: &["agent", "cursor-agent", "cursor"],
            env_override: "CURSOR_EXECUTABLE",
            install_method: InstallMethod::Script {
                unix_command: "curl https://cursor.com/install -fsS | bash",
                windows_command: "irm 'https://cursor.com/install?win32=true' | iex",
                url: "https://cursor.com/install",
            },
        }),
        HarnessId::Acp | HarnessId::Mock | HarnessId::Minswe => None,
    }
}

/// Human-readable name for a harness id, matching the descriptors.
fn harness_name(id: HarnessId) -> &'static str {
    match id {
        HarnessId::ClaudeCode => "Claude Code",
        HarnessId::Codex => "Codex",
        HarnessId::Cursor => "Cursor",
        HarnessId::Acp => "ACP Agent",
        HarnessId::Minswe => "mini",
        HarnessId::Mock => "Mock",
    }
}

/// Search for a binary by name across PATH, login-shell PATH, and node version
/// manager bins. This is a simplified version of the per-harness resolvers,
/// sufficient for a health probe (the harness's own resolver is the final
/// authority at run time).
fn find_binary(exe: &str) -> Option<PathBuf> {
    let extensions = if cfg!(windows) {
        // npm/npx ship as .cmd shims on Windows alongside an extensionless bash
        // script. The extensionless file causes os error 193 ("%1 is not a
        // valid Win32 application") if spawned directly, so we also generate
        // the real extensions and filter below.
        vec!["", ".exe", ".cmd", ".bat"]
    } else {
        vec![""]
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    let add_candidates = |dirs: &[std::path::PathBuf], candidates: &mut Vec<PathBuf>| {
        for dir in dirs {
            for ext in &extensions {
                candidates.push(dir.join(format!("{exe}{ext}")));
            }
        }
    };
    let path_dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|d| !d.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    add_candidates(&path_dirs, &mut candidates);
    if let Some(shell_path) = crate::shell_env::login_shell_path() {
        let shell_dirs: Vec<std::path::PathBuf> = std::env::split_paths(shell_path)
            .filter(|d| !d.as_os_str().is_empty())
            .collect();
        add_candidates(&shell_dirs, &mut candidates);
    }
    let nvm_dirs = crate::node_version_manager_bins();
    add_candidates(&nvm_dirs, &mut candidates);
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

/// Check whether `npx` is available on the system.
fn npx_available() -> bool {
    find_binary("npx").is_some()
}

/// Probe one harness's external binary availability.
pub fn check_harness(id: HarnessId) -> HarnessHealth {
    let name = harness_name(id).to_string();
    let Some(spec) = harness_binary(id) else {
        // ACP/Mock: no external binary to check.
        return HarnessHealth {
            id,
            name,
            installed: true,
            npx_fallback: false,
            available: true,
            install_package: None,
            message: "No external binary required".into(),
        };
    };

    // Check env override first (explicit user config wins).
    if let Some(p) = std::env::var_os(spec.env_override)
        && !p.is_empty()
    {
        return HarnessHealth {
            id,
            name,
            installed: true,
            npx_fallback: false,
            available: true,
            install_package: install_label(&spec.install_method),
            message: format!("Found via {} env override", spec.env_override),
        };
    }

    // Check each candidate binary name.
    for exe in spec.binaries {
        if find_binary(exe).is_some() {
            return HarnessHealth {
                id,
                name,
                installed: true,
                npx_fallback: false,
                available: true,
                install_package: install_label(&spec.install_method),
                message: format!("`{exe}` is installed"),
            };
        }
    }

    // Not installed — check npx fallback (npm-backed harnesses only).
    if let InstallMethod::Npm { npx_package: Some(_), .. } = &spec.install_method {
        if npx_available() {
            return HarnessHealth {
                id,
                name,
                installed: false,
                npx_fallback: true,
                available: true,
                install_package: install_label(&spec.install_method),
                message: format!(
                    "`{}` not found; npx fallback available (run Install for faster startup)",
                    spec.binaries[0]
                ),
            };
        }
    }

    // Not installed, no fallback.
    let message = match &spec.install_method {
        InstallMethod::Npm { package, .. } => format!(
            "`{}` not found; install with `npm install -g {}`",
            spec.binaries[0], package
        ),
        InstallMethod::Script { url, .. } => format!(
            "`{}` not found; install from {}",
            spec.binaries[0], url
        ),
    };
    HarnessHealth {
        id,
        name,
        installed: false,
        npx_fallback: false,
        available: false,
        install_package: install_label(&spec.install_method),
        message,
    }
}

/// Check all supported harness binaries.
pub fn check_all() -> Vec<HarnessHealth> {
    [
        HarnessId::ClaudeCode,
        HarnessId::Codex,
        HarnessId::Cursor,
    ]
    .into_iter()
    .map(check_harness)
    .collect()
}

/// Human-readable label for the install_package field (what the UI shows
/// next to the install button).
fn install_label(method: &InstallMethod) -> Option<String> {
    match method {
        InstallMethod::Npm { package, .. } => Some((*package).into()),
        InstallMethod::Script { url, .. } => Some((*url).into()),
    }
}

/// Install a harness's external binary.
///
/// - For npm-backed harnesses (Claude, Codex): runs `npm install -g <package>`.
/// - For script-backed harnesses (Cursor): runs the install script
///   (`curl … | bash` on macOS/Linux, `irm … | iex` on Windows).
///
/// This is an async function that spawns the install process, captures its
/// output, and verifies the binary is resolvable after the install completes.
pub async fn install_harness(id: HarnessId) -> HarnessInstallResult {
    let name = harness_name(id);
    let Some(spec) = harness_binary(id) else {
        return HarnessInstallResult {
            id,
            installed: false,
            error: Some(format!("{name} does not require an external binary")),
            output: None,
        };
    };

    match &spec.install_method {
        InstallMethod::Npm { package, .. } => {
            install_via_npm(id, spec.binaries, spec.env_override, package).await
        }
        InstallMethod::Script {
            unix_command,
            windows_command,
            ..
        } => {
            let command = if cfg!(windows) {
                windows_command
            } else {
                unix_command
            };
            install_via_script(id, spec.binaries, spec.env_override, command).await
        }
    }
}

/// Run `npm install -g <package>` and verify the binary is resolvable.
async fn install_via_npm(
    id: HarnessId,
    binaries: &[&str],
    env_override: &str,
    package: &str,
) -> HarnessInstallResult {
    let Some(npm) = find_binary("npm") else {
        return HarnessInstallResult {
            id,
            installed: false,
            error: Some(
                "npm not found; install Node.js from https://nodejs.org/ and try again".into(),
            ),
            output: None,
        };
    };

    let mut cmd = tokio::process::Command::new(&npm);
    crate::compose_child_path(&mut cmd, &npm);
    cmd.args(["install", "-g", package]);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return HarnessInstallResult {
                id,
                installed: false,
                error: Some(format!("Failed to start npm: {e}")),
                output: None,
            };
        }
    };

    let output = match tokio::time::timeout(INSTALL_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            return HarnessInstallResult {
                id,
                installed: false,
                error: Some(format!("npm process error: {e}")),
                output: None,
            };
        }
        Err(_) => {
            return HarnessInstallResult {
                id,
                installed: false,
                error: Some(format!(
                    "npm install timed out after {}s",
                    INSTALL_TIMEOUT.as_secs()
                )),
                output: None,
            };
        }
    };

    let combined = format_output(&output.stdout, &output.stderr);

    if !output.status.success() {
        return HarnessInstallResult {
            id,
            installed: false,
            error: Some(format!(
                "npm install failed with exit code {}",
                output.status.code().unwrap_or(-1)
            )),
            output: combined,
        };
    }

    verify_installed(id, binaries, env_override, combined)
}

/// Run an install script (shell on macOS/Linux, PowerShell on Windows) and
/// verify the binary is resolvable.
async fn install_via_script(
    id: HarnessId,
    binaries: &[&str],
    env_override: &str,
    command: &str,
) -> HarnessInstallResult {
    let (program, args) = if cfg!(windows) {
        ("powershell", vec!["-NoProfile".to_string(), "-Command".to_string(), command.to_string()])
    } else {
        ("bash", vec!["-c".to_string(), command.to_string()])
    };

    let program_path = match find_binary(program) {
        Some(p) => p,
        None => {
            // bash/powershell should always exist; fall back to the bare name
            // and let the OS resolve it.
            std::path::PathBuf::from(program)
        }
    };

    let mut cmd = tokio::process::Command::new(&program_path);
    crate::compose_child_path(&mut cmd, &program_path);
    cmd.args(&args);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return HarnessInstallResult {
                id,
                installed: false,
                error: Some(format!("Failed to start install script ({program}): {e}")),
                output: None,
            };
        }
    };

    let output = match tokio::time::timeout(INSTALL_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            return HarnessInstallResult {
                id,
                installed: false,
                error: Some(format!("Install script error: {e}")),
                output: None,
            };
        }
        Err(_) => {
            return HarnessInstallResult {
                id,
                installed: false,
                error: Some(format!(
                    "Install script timed out after {}s",
                    INSTALL_TIMEOUT.as_secs()
                )),
                output: None,
            };
        }
    };

    let combined = format_output(&output.stdout, &output.stderr);

    if !output.status.success() {
        return HarnessInstallResult {
            id,
            installed: false,
            error: Some(format!(
                "Install script failed with exit code {}",
                output.status.code().unwrap_or(-1)
            )),
            output: combined,
        };
    }

    verify_installed(id, binaries, env_override, combined)
}

/// Verify a binary is resolvable after an install attempt.
fn verify_installed(
    id: HarnessId,
    binaries: &[&str],
    env_override: &str,
    output: Option<String>,
) -> HarnessInstallResult {
    crate::shell_env::invalidate_cache();
    for exe in binaries {
        if find_binary(exe).is_some() {
            return HarnessInstallResult {
                id,
                installed: true,
                error: None,
                output,
            };
        }
    }
    HarnessInstallResult {
        id,
        installed: false,
        error: Some(format!(
            "Install succeeded but `{}` is still not found on PATH; \
             you may need to restart the app or set {} to the binary path",
            binaries[0], env_override,
        )),
        output,
    }
}

/// Combine stdout + stderr into a single trimmed string.
fn format_output(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    )
    .trim()
    .to_string();
    if combined.is_empty() { None } else { Some(combined) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_all_returns_three_harnesses() {
        let healths = check_all();
        assert_eq!(healths.len(), 3);
        let ids: Vec<HarnessId> = healths.iter().map(|h| h.id).collect();
        assert!(ids.contains(&HarnessId::ClaudeCode));
        assert!(ids.contains(&HarnessId::Codex));
        assert!(ids.contains(&HarnessId::Cursor));
    }

    #[test]
    fn check_harness_returns_install_package() {
        for id in [HarnessId::ClaudeCode, HarnessId::Codex, HarnessId::Cursor] {
            let health = check_harness(id);
            assert!(
                health.install_package.is_some(),
                "{id:?} should have an install package"
            );
            assert!(
                health.available || !health.installed,
                "{id:?}: available implies installed or npx_fallback"
            );
        }
    }

    #[test]
    fn acp_and_mock_need_no_binary() {
        let acp = check_harness(HarnessId::Acp);
        assert!(acp.installed);
        assert!(acp.available);
        assert!(acp.install_package.is_none());

        let mock = check_harness(HarnessId::Mock);
        assert!(mock.installed);
        assert!(mock.available);
        assert!(mock.install_package.is_none());
    }

    #[tokio::test]
    async fn install_unsupported_harness_returns_error() {
        let result = install_harness(HarnessId::Mock).await;
        assert!(!result.installed);
        assert!(result.error.is_some());
    }
}
