//! ACP model discovery: config-option introspection, reasoning-level mapping,
//! and the Grok fast paths (the local `models_cache.json` and the `grok
//! models` CLI).

use std::path::PathBuf;

use agent_client_protocol::schema::v1::{
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigKind, SessionConfigSelectOptions,
};
use anyhow::Context as _;

use comet_proto::{HarnessId, Model, ReasoningLevel};

use super::{AcpSpec, REASONING_LEVELS};

pub(super) fn model_config_option(options: &[SessionConfigOption]) -> Option<&SessionConfigOption> {
    options.iter().find(|option| {
        matches!(option.category, Some(SessionConfigOptionCategory::Model))
            || option.id.to_string().eq_ignore_ascii_case("model")
            || option.name.eq_ignore_ascii_case("model")
    })
}

pub(super) fn thought_level_config_option(options: &[SessionConfigOption]) -> Option<&SessionConfigOption> {
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

pub(super) fn mode_config_option(options: &[SessionConfigOption]) -> Option<&SessionConfigOption> {
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

pub(super) fn select_choices(
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

/// Check whether an ACP command string represents a Grok agent.
///
/// Matches two forms:
///   - npx-installed: JSON command whose args contain `@xai-official/grok`
///   - custom install: plain string or JSON whose executable is `grok`/`grok.exe`
pub(super) fn is_grok_command(command: &str) -> bool {
    if command.contains("@xai-official/grok") {
        return true;
    }
    // Check whether the executable's file stem is `grok`.
    let exe_stem = extract_executable(command)
        .and_then(|path| {
            std::path::Path::new(&path)
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
        });
    exe_stem.is_some_and(|stem| stem == "grok")
}

/// Detect whether the resolved command launches codex-acp (by spec id,
/// executable name, or npx package), so the caller can apply codex-specific
/// fallbacks regardless of whether the harness was created via `codex()`
/// (built-in spec) or the generic ACP path (installed agent).
pub(super) fn is_codex_command_for(spec: Option<AcpSpec>, command: &str) -> bool {
    if spec.is_some_and(|s| s.id == HarnessId::Codex) {
        return true;
    }
    if command.contains("@agentclientprotocol/codex-acp") {
        return true;
    }
    extract_executable(command)
        .and_then(|path| {
            std::path::Path::new(&path)
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
        })
        .is_some_and(|stem| stem == "codex-acp")
}

/// Extract the executable path from a command string (JSON or plain).
fn extract_executable(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.starts_with('{') {
        let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
        value.get("command")?.as_str().map(String::from)
    } else {
        // Plain string: first whitespace-delimited token (the executable).
        // Shell pipelines containing `|` are not supported.
        if trimmed.contains('|') {
            return None;
        }
        trimmed.split_whitespace().next().map(String::from)
    }
}

/// Read Grok models from the local cache file (`~/.grok/models_cache.json`).
///
/// This avoids spawning a subprocess and does not require `XAI_API_KEY` in
/// the process env, making it more reliable than `grok models` when the
/// daemon's environment differs from the user's terminal.
pub(super) fn grok_cached_models() -> anyhow::Result<Vec<Model>> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .context("neither HOME nor USERPROFILE is set")?;
    let cache_path = home.join(".grok").join("models_cache.json");
    let content = std::fs::read_to_string(&cache_path)
        .with_context(|| format!("read grok models cache: {}", cache_path.display()))?;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CacheFile {
        models: std::collections::BTreeMap<String, CacheEntry>,
    }
    #[derive(serde::Deserialize)]
    struct CacheEntry {
        info: CacheInfo,
    }
    #[derive(serde::Deserialize)]
    struct CacheInfo {
        id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        hidden: bool,
    }
    let cache: CacheFile =
        serde_json::from_str(&content).context("parse grok models cache JSON")?;
    let reasoning_levels = REASONING_LEVELS.to_vec();
    let models = cache
        .models
        .into_iter()
        .filter(|(_, entry)| !entry.info.hidden)
        .map(|(_, entry)| {
            let label = entry
                .info
                .name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| entry.info.id.clone());
            Model {
                id: entry.info.id,
                label,
                description: None,
                reasoning_levels: reasoning_levels.clone(),
                options: Vec::new(),
            }
        })
        .collect::<Vec<_>>();
    Ok(models)
}

/// Run `grok models` using the same executable and env as the ACP agent.
///
/// The ACP command JSON is `{"command":"...","args":[...,"agent","stdio"],
/// "env":{...}}`. This function replaces the `agent stdio` suffix with
/// `models`, runs the subprocess, and parses the output.
///
/// Output format (from `grok models`):
/// ```text
/// Default model: xai:grok-4.5
///
/// Available models:
///   * xai:grok-4.5 (default)
///   * xai:grok-codex
/// ```
pub(super) async fn grok_cli_models(command: &str) -> anyhow::Result<Vec<Model>> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CmdConfig {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: std::collections::BTreeMap<String, String>,
    }

    // Parse the command: JSON object or plain string.
    let trimmed = command.trim();
    let (executable, args, env) = if trimmed.starts_with('{') {
        let config: CmdConfig =
            serde_json::from_str(trimmed).context("parse Grok command JSON")?;
        (config.command, config.args, config.env)
    } else {
        // Plain string like `C:\Users\Admin\.grok\bin\grok.exe agent stdio`.
        // Shell pipelines containing `|` are not supported.
        if trimmed.contains('|') {
            anyhow::bail!("shell pipeline commands are not supported");
        }
        let mut parts = trimmed.split_whitespace();
        let executable = parts
            .next()
            .ok_or_else(|| anyhow::anyhow!("empty command"))?
            .to_string();
        let args: Vec<String> = parts.map(String::from).collect();
        (executable, args, std::collections::BTreeMap::new())
    };

    // Build `models` args: keep everything before `agent`, then add `models`.
    let mut models_args = args;
    if let Some(idx) = models_args.iter().position(|arg| arg == "agent") {
        models_args.truncate(idx);
    }
    models_args.push("models".into());

    let mut cmd = tokio::process::Command::new(&executable);
    cmd.args(&models_args);
    for (key, value) in &env {
        cmd.env(key, value);
    }
    // Inject XAI_API_KEY from the login shell when the process env lacks it.
    // GUI/daemon launches don't inherit shell variables, so the Grok CLI
    // needs the key resolved from the login-shell snapshot.
    if std::env::var_os("XAI_API_KEY").is_none() {
        if let Some(key) = crate::shell_env::login_shell_env_var("XAI_API_KEY") {
            cmd.env("XAI_API_KEY", key);
        }
    }
    eprintln!(
        "[TRACE:grok_cli_models] XAI_API_KEY in process env: {}",
        std::env::var("XAI_API_KEY").is_ok()
    );
    eprintln!(
        "[TRACE:grok_cli_models] running: {} {:?}",
        &executable, &models_args
    );
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());

    let output = cmd
        .output()
        .await
        .context("run `grok models`")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!(
        "[TRACE:grok_cli_models] exit_code={:?}, stdout_len={}, stderr_len={}, stderr={}",
        output.status.code(),
        stdout.len(),
        stderr.len(),
        &stderr[..stderr.len().min(500)],
    );
    eprintln!(
        "[TRACE:grok_cli_models] first 500 chars of stdout: {}",
        &stdout[..stdout.len().min(500)],
    );
    let models = parse_grok_models_output(&stdout, REASONING_LEVELS.to_vec());
    eprintln!("[TRACE:grok_cli_models] parsed {} models", models.len());
    Ok(models)
}

/// Parse the stdout of `grok models` into a list of models.
///
/// Accepts both `* <id>` and `- <id>` bullet styles (Grok uses `-` for
/// regular entries and `*` for the default). The default model (from the
/// "Default model:" header or a `(default)` suffix) is sorted first.
pub(super) fn parse_grok_models_output(stdout: &str, reasoning_levels: Vec<ReasoningLevel>) -> Vec<Model> {
    let mut default_id: Option<String> = None;
    let mut models: Vec<Model> = stdout
        .lines()
        .filter_map(|line| {
            // Capture the default model id for sorting.
            if let Some(rest) = line.trim().strip_prefix("Default model:") {
                default_id = Some(rest.trim().to_string());
            }
            // Parse model entries: `  * <id>` or `  - <id>`, optionally
            // followed by ` (default)`. Grok uses `-` for regular entries
            // and `*` for the default model.
            let trimmed = line.trim();
            let rest = trimmed
                .strip_prefix("* ")
                .or_else(|| trimmed.strip_prefix("- "))?;
            let rest = rest.trim();
            let (id, is_default) = match rest.strip_suffix(" (default)") {
                Some(id) => (id.trim(), true),
                None => (rest, false),
            };
            let id = id.to_string();
            if id.is_empty() {
                return None;
            }
            // Use default_id from the header line if we haven't seen it yet.
            if is_default && default_id.is_none() {
                default_id = Some(id.clone());
            }
            Some(Model {
                label: id.clone(),
                id,
                description: None,
                reasoning_levels: reasoning_levels.clone(),
                options: vec![],
            })
        })
        .collect();

    // Sort: default model first.
    if let Some(default) = default_id {
        models.sort_by_key(|m| m.id != default);
    }
    models
}

pub(super) fn models_from_config_options(options: Option<&[SessionConfigOption]>) -> Vec<Model> {
    eprintln!(
        "[TRACE:models_from_config_options] options present={}, option_count={}",
        options.is_some(),
        options.map(|o| o.len()).unwrap_or(0)
    );
    if let Some(opts) = options {
        for opt in opts {
            eprintln!(
                "[TRACE:models_from_config_options] option id={:?}, name={:?}, category={:?}, kind={:?}",
                opt.id, opt.name, opt.category, std::mem::discriminant(&opt.kind)
            );
        }
    }
    let reasoning_levels = reasoning_levels_from_config_options(options);
    let Some(option) = options.and_then(model_config_option) else {
        eprintln!("[TRACE:models_from_config_options] no model config option found -> default model");
        return vec![default_acp_model(reasoning_levels)];
    };
    eprintln!(
        "[TRACE:models_from_config_options] found model option id={:?}, name={:?}, kind={:?}",
        option.id, option.name, option.kind
    );
    let SessionConfigKind::Select(select) = &option.kind else {
        eprintln!("[TRACE:models_from_config_options] model option is not Select -> default model");
        return vec![default_acp_model(reasoning_levels)];
    };
    let mut choices = select_choices(option);
    eprintln!(
        "[TRACE:models_from_config_options] select choices count={}, current_value={:?}",
        choices.len(),
        select.current_value
    );
    let current = select.current_value.to_string();
    choices.sort_by_key(|choice| choice.value.to_string() != current);
    for choice in &choices {
        eprintln!(
            "[TRACE:models_from_config_options] choice value={:?}, name={:?}",
            choice.value, choice.name
        );
    }
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

pub(super) fn normalize_config_name(value: &str) -> String {
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

pub(super) fn reasoning_level_acp_value(
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
pub(super) fn default_acp_model(reasoning_levels: Vec<ReasoningLevel>) -> Model {
    Model {
        id: "default".into(),
        label: "Agent default".into(),
        description: Some("Model selected by the ACP agent".into()),
        reasoning_levels,
        options: vec![],
    }
}
