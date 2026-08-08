//! Cursor CLI stream-json wire frames (stdout JSONL).
//!
//! The `cursor-agent` CLI (Cursor's headless agent mode) emits newline-delimited
//! JSON events to stdout when invoked with `--output-format stream-json
//! --stream-partial-output`. The shape mirrors Claude Code's protocol closely
//! enough that the normalization layer follows the same pattern, but there are
//! key differences:
//!
//! - No bidirectional control channel: Cursor auto-approves tools in headless
//!   mode (`--allowed-tools` / `--auto`), so there is no `can_use_tool`
//!   handshake. Steering is write-only (stdin user lines).
//! - Tool calls arrive as top-level `{"type":"tool_call", …}` frames (not as
//!   content blocks inside assistant messages) with typed `toolName` + `input`.
//! - Tool results arrive inside `assistant` message content blocks as
//!   `tool_result` items (or as a separate `tool_result` top-level frame in
//!   some versions — both are handled).
//! - The terminal frame is `{"type":"result", …}` with `subtype` and `result`.
//!
//! Tolerant by construction: every field defaults, unknown frame types map to
//! [`Frame::Other`], so a newer CLI never breaks parsing.

use serde::Deserialize;
use serde_json::Value;

/// One parsed stdout line.
#[derive(Debug)]
pub(crate) enum Frame {
    System(SystemFrame),
    Assistant(MessageFrame),
    User(MessageFrame),
    Thinking(MessageFrame),
    ToolCall(ToolCallFrame),
    ToolResult(ToolResultFrame),
    Result(ResultFrame),
    /// Anything unknown — silently skipped.
    Other,
}

/// `{"type":"system", …}` — initial setup frame.
///
/// Cursor's system frame carries `session_id` and optionally `model` / `cwd`.
/// Unlike Claude's `subtype: "init"`, Cursor's system frame has no subtype.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct SystemFrame {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub tools: Vec<String>,
}

/// An `assistant`, `user`, or `thinking` frame.
///
/// Cursor's assistant messages have content blocks like Claude's
/// (`[{type:"text", text:"…"}]`), but some versions emit a flat `text` field
/// instead. Both shapes are handled.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct MessageFrame {
    #[serde(default)]
    pub message: MessageBody,
    /// Flat text shortcut (some Cursor versions emit this on thinking frames).
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub session_id: String,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct MessageBody {
    #[serde(default)]
    pub content: Value,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct ContentBlock {
    pub kind: String,
    pub text: String,
    pub thinking: String,
    pub id: String,
    pub name: String,
    pub input: Value,
    pub tool_use_id: String,
    pub is_error: Option<bool>,
}

impl MessageBody {
    pub fn blocks(&self) -> Vec<ContentBlock> {
        if let Some(arr) = self.content.as_array() {
            return arr.iter().filter_map(decode_block).collect();
        }
        // Flat string content → one text block.
        if let Some(s) = self.content.as_str()
            && !s.is_empty()
        {
            return vec![ContentBlock {
                kind: "text".into(),
                text: s.into(),
                ..Default::default()
            }];
        }
        Vec::new()
    }
}

fn decode_block(b: &Value) -> Option<ContentBlock> {
    Some(ContentBlock {
        kind: b.get("type").and_then(Value::as_str).unwrap_or("").into(),
        text: b.get("text").and_then(Value::as_str).unwrap_or("").into(),
        thinking: b
            .get("thinking")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        id: b.get("id").and_then(Value::as_str).unwrap_or("").into(),
        name: b
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        input: b.get("input").cloned().unwrap_or(Value::Null),
        tool_use_id: b
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        is_error: b.get("is_error").and_then(Value::as_bool),
    })
}

/// `{"type":"tool_call", "toolName":"…", "input":{…}}` — a tool invocation.
///
/// Cursor's top-level tool_call frame includes the tool name and its typed
/// input. Some versions nest the name under `tool` or `tool_name`.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ToolCallFrame {
    #[serde(default, alias = "tool", alias = "toolName", alias = "name")]
    pub tool_name: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub id: String,
    /// Some Cursor versions wrap details under `content[0]`.
    #[serde(default)]
    pub content: Value,
}

impl ToolCallFrame {
    pub fn effective_name(&self) -> String {
        if !self.tool_name.is_empty() {
            return self.tool_name.clone();
        }
        // Fallback: check content[0].name
        if let Some(name) = self
            .content
            .as_array()
            .and_then(|a| a.first())
            .and_then(|c| c.get("name"))
            .and_then(Value::as_str)
        {
            return name.into();
        }
        String::new()
    }

    pub fn effective_input(&self) -> Value {
        if !self.input.is_null() {
            return self.input.clone();
        }
        if let Some(input) = self
            .content
            .as_array()
            .and_then(|a| a.first())
            .and_then(|c| c.get("input"))
        {
            return input.clone();
        }
        Value::Null
    }

    pub fn effective_id(&self) -> String {
        if !self.id.is_empty() {
            return self.id.clone();
        }
        // Synthesize a stable id from name+input when the CLI doesn't provide one.
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        self.effective_name().hash(&mut hasher);
        self.effective_input().to_string().hash(&mut hasher);
        format!("cursor_{:016x}", hasher.finish())
    }
}

/// `{"type":"tool_result", "toolUseId":"…", "isError":false}` — a tool result.
///
/// In some versions, tool results arrive as content blocks inside `assistant`
/// frames (handled via `MessageBody::blocks`). This top-level shape handles
/// the versions that emit them separately.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ToolResultFrame {
    #[serde(default, alias = "tool_use_id")]
    pub tool_use_id: String,
    #[serde(default)]
    pub is_error: bool,
}

/// `{"type":"result", "subtype":"…", "result":"…", "session_id":"…"}` — the
/// terminal frame.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ResultFrame {
    #[serde(default)]
    pub subtype: String,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub errors: Vec<Value>,
    #[serde(default)]
    pub session_id: Option<String>,
}

/// Parse one stdout JSONL line. `Err` = not JSON; unknown types = `Other`.
pub(crate) fn parse_frame(line: &str) -> Result<Frame, serde_json::Error> {
    let value: Value = serde_json::from_str(line)?;
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let frame = match kind {
        "system" | "init" => Frame::System(serde_json::from_value(value)?),
        "assistant" => Frame::Assistant(serde_json::from_value(value)?),
        "user" => Frame::User(serde_json::from_value(value)?),
        "thinking" => Frame::Thinking(serde_json::from_value(value)?),
        "tool_call" | "tool_use" => Frame::ToolCall(serde_json::from_value(value)?),
        "tool_result" => Frame::ToolResult(serde_json::from_value(value)?),
        "result" | "end" => Frame::Result(serde_json::from_value(value)?),
        _ => Frame::Other,
    };
    Ok(frame)
}

/// A stdin user turn. Cursor accepts user messages via stdin in stream-json
/// mode (same shape as Claude's).
pub(crate) fn user_message_line(text: &str) -> String {
    serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_system_frame() {
        let raw =
            r#"{"type":"system","model":"claude-sonnet-5","session_id":"abc","cwd":"/tmp"}"#;
        match parse_frame(raw).expect("parses") {
            Frame::System(f) => {
                assert_eq!(f.model, "claude-sonnet-5");
                assert_eq!(f.session_id, "abc");
                assert_eq!(f.cwd, "/tmp");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_assistant_text() {
        let raw = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]}}"#;
        match parse_frame(raw).expect("parses") {
            Frame::Assistant(f) => {
                let blocks = f.message.blocks();
                assert_eq!(blocks.len(), 1);
                assert_eq!(blocks[0].kind, "text");
                assert_eq!(blocks[0].text, "Hello!");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_tool_call() {
        let raw = r#"{"type":"tool_call","toolName":"shell","input":{"command":"ls -la"}}"#;
        match parse_frame(raw).expect("parses") {
            Frame::ToolCall(f) => {
                assert_eq!(f.effective_name(), "shell");
                assert_eq!(f.effective_input()["command"], "ls -la");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_tool_call_alt_field_names() {
        let raw = r#"{"type":"tool_call","tool":"write","input":{"file_name":"/x","content":"y"}}"#;
        match parse_frame(raw).expect("parses") {
            Frame::ToolCall(f) => assert_eq!(f.effective_name(), "write"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_result() {
        let raw = r#"{"type":"result","subtype":"success","result":"Done!","session_id":"abc"}"#;
        match parse_frame(raw).expect("parses") {
            Frame::Result(f) => {
                assert_eq!(f.subtype, "success");
                assert_eq!(f.result.as_deref(), Some("Done!"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_unknown_as_other() {
        let raw = r#"{"type":"mystery"}"#;
        assert!(matches!(parse_frame(raw).expect("parses"), Frame::Other));
    }

    #[test]
    fn non_json_errors() {
        assert!(parse_frame("not json").is_err());
    }

    #[test]
    fn user_line_shape() {
        let line = user_message_line("hello");
        let v: Value = serde_json::from_str(&line).expect("json");
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["content"], "hello");
    }
}
