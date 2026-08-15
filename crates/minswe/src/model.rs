//! OpenAI-compatible streaming model client + the `ModelClient` trait.
//!
//! Scoped to OpenAI Chat Completions + tool-calling, this is the largest
//! divergence from upstream mini-swe-agent (which leans on `litellm`). See
//! §4 of `docs/research/minswe-rust-port.md` for the rationale and the
//! deliberately out-of-scope Anthropic-native path.
//!
//! Responsibilities (porting `LitellmModel`):
//! - Resolve provider config from `RunRequest.custom_provider`, else env /
//!   login-shell (`XAI_API_KEY` / `OPENAI_API_KEY`).
//! - `POST {base_url}/chat/completions` with `stream: true` and the single
//!   `bash` tool.
//! - Parse the SSE stream: text deltas → `on_delta(Text)`, provider reasoning
//!   deltas → `on_delta(Reasoning)`, accumulate `tool_calls[].function.arguments`
//!   per index.
//! - At `[DONE]`: assemble the assistant message, parse bash actions (unknown
//!   tool / missing `command` → `FormatError`), read `usage`.
//! - Retry transient HTTP errors (429/5xx/network) with exponential backoff;
//!   abort on 4xx auth/not-found/context-window.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use backon::{BackoffBuilder, ExponentialBuilder};
use futures::StreamExt;
use serde::Deserialize;

use comet_harness::shell_env;

use crate::messages::{ChatMessage, MessageRole, MessagePayload, ToolCall as WireToolCall};

/// The single tool this agent exposes (mirrors upstream `BASH_TOOL`). Built
/// lazily (the JSON macro isn't const-evaluable).
pub fn bash_tool() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute a bash command",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The bash command to execute"
                    }
                },
                "required": ["command"]
            }
        }
    })
}

/// One parsed bash action from a model response.
#[derive(Debug, Clone, PartialEq)]
pub struct BashAction {
    /// Echoed in the tool-result message.
    pub tool_call_id: String,
    pub command: String,
}

/// Token counts read from the response `usage` block.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Why the model stopped (`finish_reason`): `stop`, `length`, `tool_calls`, …
pub type FinishReason = Option<String>;

/// The fully-assembled assistant turn returned by [`ModelClient::query`].
#[derive(Debug, Clone)]
pub struct AssistantMessage {
    pub content: Option<String>,
    pub actions: Vec<BashAction>,
    pub usage: TokenUsage,
    pub finish_reason: FinishReason,
}

/// Per-delta kind pushed to the agent loop as the stream arrives.
#[derive(Debug, Clone, PartialEq)]
pub enum Delta {
    Text(String),
    Reasoning(String),
}

/// Raised when the model returned no valid bash action (missing tool calls,
/// unknown tool name, or unparseable arguments). Carries a rendered
/// observation message the loop appends to the history.
#[derive(Debug, Clone, thiserror::Error)]
#[error("format error: {feedback}")]
pub struct FormatError {
    /// The feedback to show the model (rendered format-error template).
    pub feedback: String,
}

/// Resolved connection details for one model call.
#[derive(Debug, Clone)]
pub struct ProviderEndpoint {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// The streaming query the agent loop drives. Implementations stream deltas
/// through `on_delta` and return the assembled message (or a [`FormatError`]).
/// A `ModelClient` keeps the door open for a future native-Anthropic client.
#[async_trait]
pub trait ModelClient: Send + Sync {
    async fn query(
        &self,
        messages: &[ChatMessage],
        on_delta: &mut (dyn FnMut(Delta) + Send),
    ) -> Result<AssistantMessage, ModelError>;
}

/// Errors a model call can surface: a fatal HTTP/transport failure, or a
/// recoverable [`FormatError`] (the loop retries the turn with feedback).
#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("format error: {0}")]
    Format(#[from] FormatError),
    #[error("model request failed: {0}")]
    Http(String),
}

/// Resolve the provider endpoint from a `custom_provider` (preferred) or the
/// process/login-shell env (`XAI_API_KEY`, then `OPENAI_API_KEY`). Returns
/// `None` when nothing is configured — the caller surfaces a clear error.
pub fn resolve_endpoint(
    custom_provider: Option<&comet_proto::CustomProviderEnv>,
    model_override: Option<&str>,
    request_model: Option<&str>,
) -> Option<ProviderEndpoint> {
    let model = model_override
        .or(request_model)
        .map(str::to_string)
        .unwrap_or_else(|| "default".to_string());

    if let Some(provider) = custom_provider {
        let base_url = normalize_base_url(&provider.base_url);
        tracing::debug!(
            provider_id = %provider.provider_id,
            base_url = %base_url,
            model = %model,
            "mini: using custom provider for model endpoint",
        );
        return Some(ProviderEndpoint {
            base_url,
            api_key: provider.api_key.clone(),
            model,
        });
    }

    // Env resolution, with login-shell fallback for GUI/daemon launches (the
    // same problem acp/mod.rs solves for Grok).
    let (api_key, default_base, source) = if let Some(key) = std::env::var("XAI_API_KEY")
        .ok()
        .filter(|k| !k.is_empty())
        .or_else(|| shell_env::login_shell_env_var("XAI_API_KEY").map(|v| v.to_string_lossy().into_owned()))
    {
        (key, "https://api.x.ai/v1", "XAI_API_KEY")
    } else if let Some(key) = std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|k| !k.is_empty())
        .or_else(|| shell_env::login_shell_env_var("OPENAI_API_KEY").map(|v| v.to_string_lossy().into_owned()))
    {
        (key, "https://api.openai.com/v1", "OPENAI_API_KEY")
    } else {
        tracing::warn!(
            "mini: no custom provider and no XAI_API_KEY/OPENAI_API_KEY resolved; \
             run will end with a configuration error"
        );
        return None;
    };
    tracing::debug!(
        source,
        model = %model,
        "mini: no custom provider; falling back to env API key",
    );

    let base_url = std::env::var("OPENAI_BASE_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| default_base.to_string());
    Some(ProviderEndpoint {
        base_url: normalize_base_url(&base_url),
        api_key,
        model,
    })
}

/// Ensure the base URL ends with a version segment and no trailing slash, and
/// that the model endpoint is appended by the caller (not baked in here).
fn normalize_base_url(raw: &str) -> String {
    let trimmed = raw.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

/// The OpenAI-compatible streaming client.
pub struct OpenAiCompatClient {
    endpoint: ProviderEndpoint,
    http: reqwest::Client,
    timeout: Duration,
}

impl OpenAiCompatClient {
    pub fn new(endpoint: ProviderEndpoint) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("reqwest client");
        Self {
            endpoint,
            http,
            timeout: Duration::from_secs(120),
        }
    }

    /// Test seam: inject a custom HTTP client (e.g. pointing at a mock server).
    pub fn with_http(endpoint: ProviderEndpoint, http: reqwest::Client) -> Self {
        Self {
            endpoint,
            http,
            timeout: Duration::from_secs(120),
        }
    }

    #[allow(dead_code)]
    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    fn build_body(&self, messages: &[ChatMessage]) -> serde_json::Value {
        let wire: Vec<_> = messages.iter().map(ChatMessage::to_openai).collect();
        serde_json::json!({
            "model": self.endpoint.model,
            "messages": wire,
            "stream": true,
            "stream_options": { "include_usage": true },
            "tools": [bash_tool()],
            "tool_choice": "auto",
        })
    }

    async fn do_request(
        &self,
        body: serde_json::Value,
    ) -> Result<(AssistantMessage, Vec<Delta>), ModelError> {
        let url = format!("{}/chat/completions", self.endpoint.base_url);
        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.endpoint.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| ModelError::Http(format!("request failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(ModelError::Http(format!("HTTP {status}: {}", truncate(&text, 500))));
        }
        let mut stream = response.bytes_stream();
        let mut buf = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ModelError::Http(format!("stream read: {e}")))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
        }
        let (msg, deltas) = assemble_from_buffer(&buf)?;
        Ok((msg, deltas))
    }
}

#[async_trait]
impl ModelClient for OpenAiCompatClient {
    async fn query(
        &self,
        messages: &[ChatMessage],
        on_delta: &mut (dyn FnMut(Delta) + Send),
    ) -> Result<AssistantMessage, ModelError> {
        // Retry transient failures (429/5xx/network) with exponential backoff,
        // aborting on format errors and non-transient HTTP failures. Each
        // attempt collects its deltas; only the successful attempt's deltas
        // are forwarded to the caller — a retry must never duplicate streamed
        // output into the transcript.
        let mut backoff = ExponentialBuilder::default()
            .with_min_delay(Duration::from_millis(500))
            .with_max_delay(Duration::from_secs(8))
            .build();
        let mut attempt = 0u32;
        const MAX_ATTEMPTS: u32 = 5;
        loop {
            attempt += 1;
            match self.do_request(self.build_body(messages)).await {
                Ok((msg, deltas)) => {
                    for d in deltas {
                        on_delta(d);
                    }
                    return Ok(msg);
                }
                Err(err) if is_format_error(&err) => return Err(err),
                Err(err) if !is_transient(&err) => return Err(err),
                Err(err) if attempt >= MAX_ATTEMPTS => {
                    return Err(ModelError::Http(format!(
                        "model request failed after {MAX_ATTEMPTS} attempts: {err}"
                    )));
                }
                Err(_) => {
                    if let Some(delay) = backoff.next() {
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
    }
}

fn is_format_error(e: &ModelError) -> bool {
    matches!(e, ModelError::Format(_))
}

fn is_transient(e: &ModelError) -> bool {
    let ModelError::Http(msg) = e else {
        return false;
    };
    // Network errors (no HTTP code) are transient.
    if msg.starts_with("request failed") || msg.starts_with("stream read") {
        return true;
    }
    // HTTP 429 / 5xx are transient.
    msg.contains("HTTP 429")
        || msg.contains("HTTP 500")
        || msg.contains("HTTP 502")
        || msg.contains("HTTP 503")
        || msg.contains("HTTP 504")
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

/// One SSE `data:` payload parsed into the fields we consume.
#[derive(Debug, Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    usage: Option<StreamUsage>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    /// Provider reasoning (xAI `reasoning` field; some gateways alias
    /// `thinking`). Both are surfaced as `Delta::Reasoning`.
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    thinking: Option<String>,
    #[serde(default)]
    tool_calls: Vec<StreamToolCall>,
}

#[derive(Debug, Deserialize)]
struct StreamToolCall {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<StreamFunction>,
}

#[derive(Debug, Default, Deserialize)]
struct StreamFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
}

/// Pull one complete SSE event (ending in a blank line) off the front of
/// `buf`, returning `(event, remaining)`. (Kept for the SSE-parser unit test;
/// the live path assembles from the full buffer.)
#[cfg(test)]
fn take_sse_event(buf: &str) -> Option<(String, String)> {
    let sep = buf.find("\n\n")?;
    let (event, rest) = buf.split_at(sep);
    let event = event.to_string();
    let rest = rest[2..].to_string();
    Some((event, rest))
}


/// Reconstruct the final assistant message + parsed actions from the buffered
/// SSE stream, collecting the ordered deltas so the caller can replay them on
/// the successful attempt (a retry must never duplicate streamed output).
fn assemble_from_buffer(buf: &str) -> Result<(AssistantMessage, Vec<Delta>), ModelError> {
    let buf = buf.replace("\r\n", "\n");
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut finish_reason: Option<String> = None;
    let mut tool_calls: HashMap<usize, (String, String, String)> = HashMap::new();
    let mut usage = TokenUsage::default();
    let mut deltas: Vec<Delta> = Vec::new();

    for event in buf.split("\n\n") {
        let Some(data) = event.strip_prefix("data: ") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<StreamChunk>(data) else {
            continue;
        };
        for choice in &parsed.choices {
            if let Some(c) = &choice.delta.content {
                content.push_str(c);
                if !c.is_empty() {
                    deltas.push(Delta::Text(c.clone()));
                }
            }
            if let Some(r) = choice.delta.reasoning.as_ref().or(choice.delta.thinking.as_ref()) {
                reasoning.push_str(r);
                if !r.is_empty() {
                    deltas.push(Delta::Reasoning(r.clone()));
                }
            }
            for tc in &choice.delta.tool_calls {
                let entry = tool_calls
                    .entry(tc.index)
                    .or_insert_with(|| (String::new(), String::new(), String::new()));
                if let Some(id) = &tc.id {
                    entry.0 = id.clone();
                }
                if let Some(f) = &tc.function {
                    if let Some(name) = &f.name {
                        entry.1 = name.clone();
                    }
                    if let Some(args) = &f.arguments {
                        entry.2.push_str(args);
                    }
                }
            }
            if let Some(fr) = &choice.finish_reason {
                finish_reason = Some(fr.clone());
            }
        }
        if let Some(u) = &parsed.usage {
            usage = TokenUsage {
                input_tokens: u.prompt_tokens,
                output_tokens: u.completion_tokens,
            };
        }
    }

    // Parse actions; raise on the first unknown/invalid tool call.
    let mut actions = Vec::new();
    let mut indices: Vec<usize> = tool_calls.keys().copied().collect();
    indices.sort();
    for &idx in &indices {
        let (id, name, args_json) = &tool_calls[&idx];
        let mut command = String::new();
        let mut err = String::new();
        match serde_json::from_str::<serde_json::Value>(args_json) {
            Ok(v) => {
                if let Some(c) = v.get("command").and_then(|c| c.as_str()) {
                    command = c.to_string();
                } else {
                    err.push_str("Missing 'command' argument in bash tool call.");
                }
            }
            Err(e) => {
                err.push_str(&format!("Error parsing tool call arguments: {e}."));
            }
        }
        if name != "bash" {
            err.push_str(&format!("Unknown tool '{name}'."));
        }
        if !err.is_empty() {
            return Err(ModelError::Format(FormatError {
                feedback: crate::prompts::render_format_error(
                    err.trim(),
                    finish_reason.as_deref(),
                    indices.len(),
                ),
            }));
        }
        actions.push(BashAction {
            tool_call_id: id.clone(),
            command,
        });
    }

    if actions.is_empty() && tool_calls.is_empty() {
        // No tool calls at all — format error (the model must always act).
        let feedback = crate::prompts::render_format_error(
            "No tool calls found in the response. Every response MUST include at least one tool call.",
            finish_reason.as_deref(),
            0,
        );
        return Err(ModelError::Format(FormatError { feedback }));
    }

    let _ = reasoning;
    Ok((
        AssistantMessage {
            content: if content.is_empty() { None } else { Some(content) },
            actions,
            usage,
            finish_reason,
        },
        deltas,
    ))
}

// ---------------------------------------------------------------------------
// MockModelClient — scripted responses for unit/integration tests.
// ---------------------------------------------------------------------------

/// A scripted assistant turn for tests: a fixed message the mock returns.
#[derive(Debug, Clone)]
pub struct MockTurn {
    pub content: Option<String>,
    pub actions: Vec<BashAction>,
    pub reasoning: Option<String>,
    pub usage: TokenUsage,
    /// When set, `query` returns this format error instead of the canned turn
    /// (lets integration tests drive the format-error recovery path).
    pub format_error: Option<String>,
}

impl MockTurn {
    /// A turn that returns a valid assistant message.
    pub fn turn(content: Option<String>, actions: Vec<BashAction>) -> Self {
        Self {
            content,
            actions,
            reasoning: None,
            usage: TokenUsage::default(),
            format_error: None,
        }
    }

    /// A turn that raises a format error with the given feedback.
    pub fn format_error(feedback: impl Into<String>) -> Self {
        Self {
            content: None,
            actions: vec![],
            reasoning: None,
            usage: TokenUsage::default(),
            format_error: Some(feedback.into()),
        }
    }
}

/// A mock client that returns canned turns in sequence (the last turn repeats).
/// Used by `agent.rs` integration tests without needing a live endpoint.
pub struct MockModelClient {
    pub turns: Vec<MockTurn>,
    pub call_index: std::sync::atomic::AtomicUsize,
}

impl MockModelClient {
    pub fn new(turns: Vec<MockTurn>) -> Self {
        Self {
            turns,
            call_index: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl ModelClient for MockModelClient {
    async fn query(
        &self,
        _messages: &[ChatMessage],
        on_delta: &mut (dyn FnMut(Delta) + Send),
    ) -> Result<AssistantMessage, ModelError> {
        let idx = self
            .call_index
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let turn = self
            .turns
            .get(idx)
            .or_else(|| self.turns.last())
            .expect("at least one scripted turn");
        if let Some(feedback) = &turn.format_error {
            return Err(ModelError::Format(FormatError {
                feedback: feedback.clone(),
            }));
        }
        if let Some(r) = &turn.reasoning {
            if !r.is_empty() {
                on_delta(Delta::Reasoning(r.clone()));
            }
        }
        if let Some(c) = &turn.content {
            if !c.is_empty() {
                on_delta(Delta::Text(c.clone()));
            }
        }
        Ok(AssistantMessage {
            content: turn.content.clone(),
            actions: turn.actions.clone(),
            usage: turn.usage,
            finish_reason: Some(if turn.actions.is_empty() {
                "stop".into()
            } else {
                "tool_calls".into()
            }),
        })
    }
}

/// Helper for the wire message round-trip serialization used by the agent.
#[allow(dead_code)]
pub(crate) fn wire_tool_calls(actions: &[BashAction]) -> Vec<WireToolCall> {
    actions
        .iter()
        .map(|a| WireToolCall {
            id: a.tool_call_id.clone(),
            name: "bash".into(),
            arguments: serde_json::json!({ "command": a.command }).to_string(),
        })
        .collect()
}

#[allow(dead_code)]
pub(crate) fn messages_payload() -> MessagePayload {
    MessagePayload::Text(String::new())
}

#[allow(dead_code)]
pub(crate) fn unused_role() -> MessageRole {
    MessageRole::User
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hand-built SSE stream: one reasoning delta, two text deltas, one
    /// tool-call split across fragments, then usage + [DONE].
    fn fixture_stream() -> String {
        let chunks = [
            r#"data: {"choices":[{"delta":{"reasoning":"thinking "}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":" world"}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\"comma"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nd\":\"ls\"}"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            r#"data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}"#,
            "data: [DONE]",
        ];
        chunks.join("\n\n") + "\n\n"
    }

    #[test]
    fn take_sse_event_splits_on_blank_line() {
        let buf = "data: a\n\ndata: b\n\n";
        let (a, rest) = take_sse_event(buf).unwrap();
        assert_eq!(a, "data: a");
        assert_eq!(rest, "data: b\n\n");
    }

    #[test]
    fn assemble_accumulates_text_reasoning_and_toolcall() {
        let stream = fixture_stream();
        let (msg, deltas) = assemble_from_buffer(&stream).unwrap();
        assert_eq!(msg.content.as_deref(), Some("Hello world"));
        assert_eq!(msg.actions.len(), 1);
        assert_eq!(msg.actions[0].command, "ls");
        assert_eq!(msg.actions[0].tool_call_id, "call_1");
        assert_eq!(msg.usage.input_tokens, 10);
        assert_eq!(msg.usage.output_tokens, 5);
        assert_eq!(msg.finish_reason.as_deref(), Some("tool_calls"));
        assert!(deltas.iter().any(|d| matches!(d, Delta::Text(t) if t == "Hello")));
        assert!(deltas.iter().any(|d| matches!(d, Delta::Reasoning(t) if t == "thinking ")));
    }

    #[test]
    fn assemble_no_tool_calls_is_format_error() {
        let stream = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        let err = assemble_from_buffer(stream).unwrap_err();
        assert!(matches!(err, ModelError::Format(_)));
    }

    #[test]
    fn assemble_unknown_tool_is_format_error() {
        let stream = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"rmrf","arguments":"{}"}}]}}]}"#;
        let stream = format!("{stream}\n\ndata: [DONE]\n\n");
        let err = assemble_from_buffer(&stream).unwrap_err();
        let ModelError::Format(fe) = err else {
            panic!("expected format error");
        };
        assert!(fe.feedback.contains("Unknown tool"), "got: {}", fe.feedback);
    }

    #[test]
    fn normalize_base_url_appends_v1() {
        assert_eq!(normalize_base_url("https://api.x.ai"), "https://api.x.ai/v1");
        assert_eq!(normalize_base_url("https://api.x.ai/"), "https://api.x.ai/v1");
        assert_eq!(normalize_base_url("https://api.x.ai/v1"), "https://api.x.ai/v1");
        assert_eq!(
            normalize_base_url("https://api.x.ai/v1/"),
            "https://api.x.ai/v1"
        );
    }

    #[test]
    fn resolve_endpoint_from_custom_provider() {
        let provider = comet_proto::CustomProviderEnv {
            provider_id: "np".into(),
            name: "Test".into(),
            base_url: "https://api.test.com".into(),
            api_key: "sk-test".into(),
            formats: vec![comet_proto::CustomProviderFormat::ChatCompletions],
            codex_subagent_model: None,
        };
        let ep = resolve_endpoint(Some(&provider), None, Some("grok-1")).unwrap();
        assert_eq!(ep.base_url, "https://api.test.com/v1");
        assert_eq!(ep.api_key, "sk-test");
        assert_eq!(ep.model, "grok-1");
    }

    #[test]
    fn is_transient_classifies_http_codes() {
        assert!(is_transient(&ModelError::Http("HTTP 429: slow down".into())));
        assert!(is_transient(&ModelError::Http("HTTP 503: down".into())));
        assert!(!is_transient(&ModelError::Http("HTTP 401: bad key".into())));
        assert!(is_transient(&ModelError::Http("request failed: dns".into())));
    }

    #[tokio::test]
    async fn mock_client_returns_scripted_turns() {
        let mock = MockModelClient::new(vec![
            MockTurn {
                content: Some("first".into()),
                actions: vec![BashAction {
                    tool_call_id: "c1".into(),
                    command: "echo a".into(),
                }],
                reasoning: None,
                usage: TokenUsage::default(),
                format_error: None,
            },
            MockTurn {
                content: None,
                actions: vec![BashAction {
                    tool_call_id: "c2".into(),
                    command: "echo b".into(),
                }],
                reasoning: Some("hmm".into()),
                usage: TokenUsage {
                    input_tokens: 5,
                    output_tokens: 2,
                },
                format_error: None,
            },
        ]);
        let mut deltas = Vec::new();
        let m1 = mock.query(&[], &mut |d| deltas.push(d)).await.unwrap();
        assert_eq!(m1.content.as_deref(), Some("first"));
        assert_eq!(m1.actions[0].command, "echo a");
        deltas.clear();
        let m2 = mock.query(&[], &mut |d| deltas.push(d)).await.unwrap();
        assert_eq!(m2.usage.output_tokens, 2);
        assert!(deltas.iter().any(|d| matches!(d, Delta::Reasoning(_))));
    }
}
