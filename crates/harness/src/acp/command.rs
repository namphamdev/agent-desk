//! ACP agent command resolution.
//!
//! Built-in spec binaries are found through PATH + login-shell + node-version
//! manager scans (with an `npx -y <pinned>` fallback); user-configured
//! commands (`acp-agents.json`, `COMET_ACP_AGENT`) are normalized into a form
//! the SDK's `AcpAgent::from_str` can spawn reliably, including Windows
//! `.cmd`/`.bat` shim handling and PATH injection.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::HarnessError;

use super::AcpSpec;

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
pub(super) fn resolve_spec_command(spec: &AcpSpec) -> Result<String, HarnessError> {
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
/// executables â€” spawning them directly fails with "program not found" or OS
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
/// - JSON (`{"command":"...","args":[...]}`) â€” on Unix, returned as-is (already
///   structured; the SDK spawns the named program directly). On Windows, the
///   `"command"` field is resolved to a full `.exe`/`.cmd`/`.bat` path and
///   PATH is injected into `"env"` (npm shims like `grok` and `pi` install
///   extensionless scripts that fail with os error 193 when spawned directly).
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
pub(super) fn resolve_agent_command_string(command: &str) -> Result<String, HarnessError> {
    let trimmed = command.trim();
    // Compose a full PATH for the child: the resolved executable's directory
    // first, then our own PATH, then the login-shell PATH snapshot. npm-shim
    // CLIs are `#!/usr/bin/env node` scripts, and agents like OMP shell out to
    // runtimes (bun) that a daemon/service launch's PATH may lack.
    let composed_path = composed_child_path_string();

    // JSON commands need platform-specific resolution. On Windows the
    // "command" field may be a bare name like "grok" or "pi" that resolves to
    // an extensionless npm shim â€” spawning that directly fails with os error
    // 193 ("%1 is not a valid Win32 application"). On Unix the JSON is fine
    // as-is.
    if trimmed.starts_with('{') {
        #[cfg(not(windows))]
        {
            let _ = composed_path;
            return Ok(command.to_string());
        }
        #[cfg(windows)]
        {
            return resolve_json_command_windows(trimmed, &composed_path);
        }
    }

    // Split into program + rest. The program is the first token.
    let mut parts = trimmed.split_whitespace();
    let Some(program) = parts.next() else {
        return Ok(command.to_string());
    };
    let args: Vec<&str> = parts.collect();

    #[cfg(not(windows))]
    {
        let _ = (program, args, composed_path);
        // On Unix the bare command works; the child inherits our env which
        // already has a complete PATH.
        Ok(command.to_string())
    }
    #[cfg(windows)]
    {
        resolve_bare_command_windows(program, &args, &composed_path)
    }
}

/// On Windows, resolve a JSON ACP command's `"command"` field to a full
/// executable path and inject PATH into the child env. The SDK's
/// `AcpAgent::from_str` calls `std::process::Command::new(command)`, which on
/// Windows may find the extensionless npm shim (e.g. `grok` instead of
/// `grok.cmd`) and fail with os error 193. Resolving the full `.cmd`/`.bat`/
/// `.exe` path here avoids that.
#[cfg(windows)]
fn resolve_json_command_windows(
    json_str: &str,
    composed_path: &str,
) -> Result<String, HarnessError> {
    let mut value: serde_json::Value =
        serde_json::from_str(json_str).map_err(|_| HarnessError::NotInstalled(
            "ACP agent command is invalid JSON".into(),
        ))?;
    let program = value
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| HarnessError::NotInstalled(
            "ACP agent JSON command missing 'command' field".into(),
        ))?;

    let resolved_path = resolve_windows_executable(program)?;

    value["command"] = serde_json::Value::String(resolved_path);
    // Inject PATH so the child can find runtimes (node, bun) it shells out to.
    // Create the env object if missing; fail only if it exists but isn't an
    // object (malformed user input).
    if value.get("env").is_none() {
        value["env"] = serde_json::json!({});
    }
    let env = value
        .get_mut("env")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| {
            HarnessError::NotInstalled("ACP agent JSON command has invalid 'env' field".into())
        })?;
    env.insert("PATH".to_string(), serde_json::Value::String(composed_path.to_string()));
    Ok(value.to_string())
}

/// On Windows, resolve an executable name or path to a real Win32 executable.
///
/// npm/node install both an extensionless bash shim and a `.cmd` shim for
/// CLI tools. `std::process::Command::new` may find the extensionless file
/// first, causing os error 193 ("%1 is not a valid Win32 application").
///
/// This function:
/// 1. Passes through paths that already have `.exe`/`.cmd`/`.bat`.
/// 2. If the path exists as-is but has no executable extension, tries
///    appending `.exe`/`.cmd`/`.bat` (the shim siblings).
/// 3. Falls back to `find_on_paths` for bare names.
#[cfg(windows)]
pub(super) fn resolve_windows_executable(program: &str) -> Result<String, HarnessError> {
    // Already has a valid executable extension (case-insensitive — Windows
    // PATHEXT stores `.EXE`/`.CMD`/`.BAT` in uppercase, and the file system
    // treats extensions case-insensitively).
    if Path::new(program)
        .extension()
        .is_some_and(|ext| matches!(ext.to_str(), Some(e) if matches!(e.to_ascii_lowercase().as_str(), "exe" | "cmd" | "bat")))
    {
        return Ok(program.to_string());
    }

    // The program may be an absolute path to the extensionless shim
    // (e.g. `C:\Program Files\nodejs\npx`). Try the executable extensions
    // as siblings before falling back to a PATH search.
    for ext in &[".exe", ".cmd", ".bat"] {
        let candidate = format!("{program}{ext}");
        if Path::new(&candidate).is_file() {
            return Ok(candidate);
        }
    }

    // Bare name â€” search PATH for a real executable.
    find_on_paths(program)
        .map(|p| p.display().to_string())
        .ok_or_else(|| {
            HarnessError::NotInstalled(format!(
                "ACP agent command program '{program}' was not found on PATH. \
                 Update the agent command in Settings > ACP agents to point to \
                 an installed executable."
            ))
        })
}

/// On Windows, resolve a bare command (program + args) to a JSON config with
/// the full executable path and PATH injected into the env.
#[cfg(windows)]
fn resolve_bare_command_windows(
    program: &str,
    args: &[&str],
    composed_path: &str,
) -> Result<String, HarnessError> {
    let cmd_path = resolve_windows_executable(program)?;

    // Always wrap in JSON on Windows so we can inject PATH into the
    // child environment. Without this, agents that shell out to bun,
    // node, or other runtimes fail ("'bun' is not recognized") because
    // the daemon's PATH may not include those install dirs.
    let mut json = serde_json::json!({ "command": cmd_path, "env": { "PATH": composed_path } });
    if !args.is_empty() {
        json["args"] = serde_json::Value::Array(
            args.iter().map(|a| serde_json::Value::String((*a).to_string())).collect(),
        );
    }
    Ok(json.to_string())
}

/// Build the PATH string a child process should receive: the resolved
/// executable's directory (if known), then our own PATH, then the login-shell
/// PATH snapshot â€” deduped.
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AcpHarnessConfig {
    pub(super) active_agent_id: Option<String>,
    #[serde(default)]
    pub(super) agents: Vec<AcpHarnessAgent>,
}

#[derive(Deserialize)]
pub(super) struct AcpHarnessAgent {
    pub(super) id: String,
    pub(super) command: String,
}

/// Normalize a resolved ACP agent command so the SDK's `AcpAgent::from_str`
/// accepts it. Users sometimes paste MCP-style JSON configs that include a
/// `"type"` field (e.g. `{"type":"stdio","command":"..."}`); the ACP SDK's
/// `AcpAgentConfig` uses `#[serde(deny_unknown_fields)]` and rejects anything
/// beyond `command`, `args`, `env`. Strip the offending field before the SDK
/// ever sees it.
pub(super) fn normalize_acp_command(command: String) -> String {
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

