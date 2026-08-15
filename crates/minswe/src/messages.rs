//! Internal chat-message representation for the mini agent loop.
//!
//! A flat, append-only history mirroring mini-swe-agent's `self.messages`.
//! Each [`ChatMessage`] carries a [`MessageRole`] plus role-specific payload
//! (assistant text + tool calls, tool results, …) and serializes into the
//! OpenAI Chat Completions wire shape in [`ChatMessage::to_openai`].

use serde::{Deserialize, Serialize};

/// The roles the loop produces. (mini also has an `exit` role; we encode
/// exits as run termination instead of a history message.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    /// OpenAI tool-result message: the rendered observation for one action.
    Tool,
}

/// One assistant tool call: a parsed `bash` invocation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    /// The OpenAI-assigned tool-call id (echoed in the tool-result message).
    pub id: String,
    /// Always `"bash"` for this agent — any other name is a format error.
    pub name: String,
    /// Raw JSON `arguments` string (accumulated across streaming deltas).
    pub arguments: String,
}

/// The payload of a single message, keyed off its role.
#[derive(Debug, Clone, PartialEq)]
pub enum MessagePayload {
    /// System / user text (the rendered templates, steers, format errors).
    Text(String),
    /// Assistant turn: streamed text + zero or more tool calls.
    Assistant {
        content: Option<String>,
        tool_calls: Vec<ToolCall>,
    },
    /// A tool result: the rendered observation for one action.
    Tool { tool_call_id: String, content: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub payload: MessagePayload,
}

impl ChatMessage {
    pub fn system(text: impl Into<String>) -> Self {
        Self {
            role: MessageRole::System,
            payload: MessagePayload::Text(text.into()),
        }
    }

    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: MessageRole::User,
            payload: MessagePayload::Text(text.into()),
        }
    }

    pub fn assistant(content: Option<String>, tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: MessageRole::Assistant,
            payload: MessagePayload::Assistant {
                content,
                tool_calls,
            },
        }
    }

    pub fn tool(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::Tool,
            payload: MessagePayload::Tool {
                tool_call_id: tool_call_id.into(),
                content: content.into(),
            },
        }
    }

    /// Serialize into the OpenAI Chat Completions `messages[]` shape. Tool
    /// calls with an empty `arguments` are omitted from the wire (a partial
    /// fragment never makes it into the final assembled assistant message).
    pub fn to_openai(&self) -> serde_json::Value {
        match &self.payload {
            MessagePayload::Text(text) => serde_json::json!({
                "role": match self.role {
                    MessageRole::System => "system",
                    MessageRole::User => "user",
                    _ => "user",
                },
                "content": text,
            }),
            MessagePayload::Assistant { content, tool_calls } => {
                let mut value = serde_json::json!({ "role": "assistant" });
                if let Some(content) = content {
                    value["content"] = serde_json::Value::String(content.clone());
                }
                let calls: Vec<_> = tool_calls
                    .iter()
                    .filter(|c| !c.arguments.is_empty() || !c.name.is_empty())
                    .map(|c| {
                        serde_json::json!({
                            "id": c.id,
                            "type": "function",
                            "function": {
                                "name": c.name,
                                "arguments": c.arguments,
                            }
                        })
                    })
                    .collect();
                if !calls.is_empty() {
                    value["tool_calls"] = serde_json::Value::Array(calls);
                }
                value
            }
            MessagePayload::Tool {
                tool_call_id,
                content,
            } => serde_json::json!({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": content,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_messages_map_to_openai() {
        assert_eq!(
            ChatMessage::system("hi").to_openai(),
            serde_json::json!({"role": "system", "content": "hi"})
        );
        assert_eq!(
            ChatMessage::user("do it").to_openai(),
            serde_json::json!({"role": "user", "content": "do it"})
        );
    }

    #[test]
    fn assistant_message_with_tool_calls_maps() {
        let msg = ChatMessage::assistant(
            Some("thinking".into()),
            vec![ToolCall {
                id: "call_1".into(),
                name: "bash".into(),
                arguments: r#"{"command":"ls"}"#.into(),
            }],
        );
        let wire = msg.to_openai();
        assert_eq!(wire["role"], "assistant");
        assert_eq!(wire["content"], "thinking");
        assert_eq!(wire["tool_calls"][0]["function"]["name"], "bash");
    }

    #[test]
    fn tool_result_maps() {
        let msg = ChatMessage::tool("call_1", "ok");
        assert_eq!(
            msg.to_openai(),
            serde_json::json!({"role": "tool", "tool_call_id": "call_1", "content": "ok"})
        );
    }
}
