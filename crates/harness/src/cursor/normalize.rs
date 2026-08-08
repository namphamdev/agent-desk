//! Frame → [`AgentEvent`] normalization for the Cursor CLI.
//!
//! Cursor's stream-json output uses a different vocabulary than Claude's
//! (top-level `tool_call`/`tool_result` frames, `thinking` type, tool names
//! like `shell`/`write`/`read`/`edit` instead of `Bash`/`Write`/`Read`/`Edit`),
//! but the normalization strategy is the same: map each wire frame into 0+
//! unified [`AgentEvent`]s.

use comet_proto::{AgentEvent, DoneStatus, HarnessId, TodoItem, ToolCall};
use serde_json::Value;

use super::wire::{ContentBlock, Frame};

/// Decode a Cursor tool name + input into a typed [`ToolCall`].
///
/// Cursor's tool names are lowercase verbs: `shell`, `read`, `write`, `edit`,
/// `list`, `search`, `glob`, `web_search`, `web_fetch`, `todo`.
/// These map to the same `ToolCall` variants Claude's normalizer produces.
pub(crate) fn decode_tool_call(name: &str, input: &Value) -> ToolCall {
    fn str_field(input: &Value, key: &str) -> String {
        input.get(key).and_then(Value::as_str).unwrap_or("").into()
    }

    // Normalize: Cursor uses snake_case; some versions use camelCase field names.
    let get_str = |input: &Value, keys: &[&str]| -> String {
        for k in keys {
            if let Some(s) = input.get(*k).and_then(Value::as_str) {
                return s.into();
            }
        }
        String::new()
    };
    let get_opt_str = |input: &Value, keys: &[&str]| -> Option<String> {
        for k in keys {
            if let Some(s) = input.get(*k).and_then(Value::as_str) {
                return Some(s.into());
            }
        }
        None
    };

    match name {
        "shell" | "Bash" | "bash" | "execute" | "run" => ToolCall::Exec {
            command: get_str(input, &["command", "cmd", "args"]),
        },
        "read" | "Read" | "read_file" | "readFile" => ToolCall::ReadFile {
            path: get_str(input, &["file_path", "filePath", "file_name", "fileName", "path"]),
        },
        "write" | "Write" | "write_file" | "writeFile" | "create" => ToolCall::WriteFile {
            path: get_str(input, &["file_path", "filePath", "file_name", "fileName", "path"]),
            content: get_opt_str(input, &["content", "file_text", "fileText"]),
        },
        "edit" | "Edit" | "edit_file" | "editFile" | "str_replace" => ToolCall::EditFile {
            path: get_str(input, &["file_path", "filePath", "file_name", "fileName", "path"]),
            old_string: get_opt_str(input, &["old_string", "oldString", "find", "to_replace"]),
            new_string: get_opt_str(input, &["new_string", "newString", "replace", "replacement"]),
        },
        "search" | "grep" | "Grep" => ToolCall::Search {
            pattern: get_str(input, &["pattern", "query", "regex"]),
            path: get_opt_str(input, &["path", "cwd", "directory"]),
        },
        "glob" | "Glob" | "list" | "List" | "list_files" | "listFiles" => {
            // `list` in Cursor lists directory contents, not a glob pattern.
            // Map it to Glob (closest semantic) using the path as the pattern
            // when the `pattern` field is absent.
            let pattern = get_str(input, &["pattern", "path", "directory"]);
            if pattern.is_empty() && name.starts_with("list") {
                ToolCall::Glob {
                    pattern: get_str(input, &["path", "directory"]),
                }
            } else {
                ToolCall::Glob { pattern }
            }
        }
        "web_fetch" | "WebFetch" | "fetch" => ToolCall::WebFetch {
            url: get_str(input, &["url", "uri"]),
            prompt: get_opt_str(input, &["prompt", "instruction"]),
        },
        "web_search" | "WebSearch" => ToolCall::WebSearch {
            query: get_str(input, &["query", "search_query"]),
        },
        "todo" | "TodoWrite" | "todo_write" => ToolCall::Todo {
            items: input
                .get("todos")
                .and_then(Value::as_array)
                .map(|a| a.as_slice())
                .unwrap_or_default()
                .iter()
                .map(|t| TodoItem {
                    text: str_field(t, "content")
                        .chars()
                        .take(4096)
                        .collect::<String>(),
                    done: t
                        .get("status")
                        .and_then(Value::as_str)
                        .map(|s| s == "completed" || s == "done")
                        .unwrap_or(false),
                })
                .collect(),
        },
        // MCP tools: Cursor uses `mcp__<server>__<tool>` like Claude.
        _ => match name.strip_prefix("mcp__").and_then(|r| r.split_once("__")) {
            Some((server, tool)) => ToolCall::Mcp {
                server: server.into(),
                tool: tool.into(),
                input: (!input.is_null()).then(|| input.clone()),
            },
            None => ToolCall::Unknown {
                name: name.into(),
                input: (!input.is_null()).then(|| input.clone()),
            },
        },
    }
}

fn new_message_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Per-run normalization state.
pub(crate) struct Normalizer {
    saw_init: bool,
    assistant_message_id: String,
    pub session_id: Option<String>,
}

impl Normalizer {
    pub fn new() -> Self {
        Self {
            saw_init: false,
            assistant_message_id: new_message_id(),
            session_id: None,
        }
    }

    pub fn rotate_for_steer(&mut self) -> (String, String) {
        let prev = std::mem::replace(&mut self.assistant_message_id, new_message_id());
        (prev, self.assistant_message_id.clone())
    }

    /// Normalize one stdout frame into 0+ unified events.
    pub fn normalize(&mut self, frame: Frame, interrupted: bool) -> Vec<AgentEvent> {
        match frame {
            Frame::System(f) => {
                if self.saw_init {
                    return Vec::new();
                }
                self.saw_init = true;
                if !f.session_id.is_empty() {
                    self.session_id = Some(f.session_id.clone());
                }
                vec![AgentEvent::SessionStarted {
                    harness: HarnessId::Cursor,
                    model: f.model,
                    tools: f.tools,
                    cwd: f.cwd,
                    session_id: f.session_id,
                    assistant_message_id: self.assistant_message_id.clone(),
                }]
            }

            Frame::Thinking(f) => {
                // Thinking frames carry reasoning text. They may use flat text
                // or content blocks.
                let mut events = Vec::new();
                if !f.text.is_empty() {
                    events.push(AgentEvent::ReasoningDelta { text: f.text });
                }
                for block in f.message.blocks() {
                    if block.kind == "thinking" && !block.thinking.is_empty() {
                        events.push(AgentEvent::ReasoningDelta {
                            text: block.thinking,
                        });
                    } else if block.kind == "text" && !block.text.is_empty() {
                        events.push(AgentEvent::ReasoningDelta { text: block.text });
                    }
                }
                events
            }

            Frame::Assistant(f) => {
                let blocks = f.message.blocks();
                let mut out: Vec<AgentEvent> = Vec::new();

                for block in blocks.iter() {
                    match block.kind.as_str() {
                        "text" if !block.text.is_empty() => {
                            out.push(AgentEvent::TextDelta {
                                text: block.text.clone(),
                            });
                        }
                        "thinking" if !block.thinking.is_empty() => {
                            out.push(AgentEvent::ReasoningDelta {
                                text: block.thinking.clone(),
                            });
                        }
                        "tool_use" => {
                            out.push(AgentEvent::ToolCall {
                                id: block.id.clone(),
                                call: decode_tool_call(&block.name, &block.input),
                            });
                        }
                        "tool_result" => {
                            out.push(AgentEvent::ToolResult {
                                id: block.tool_use_id.clone(),
                                is_error: block.is_error.unwrap_or(false),
                            });
                        }
                        _ => {}
                    }
                }

                if !f.session_id.is_empty() && self.session_id.is_none() {
                    self.session_id = Some(f.session_id.clone());
                }

                // The enclosing assistant frame closes the streamed message.
                let (prev, _next) = self.rotate_for_steer();
                out.push(AgentEvent::AssistantMessageCompleted {
                    assistant_message_id: prev,
                });
                out
            }

            Frame::User(f) => {
                // Tool results can arrive inside user frames too (Claude
                // convention that Cursor sometimes follows).
                f.message
                    .blocks()
                    .into_iter()
                    .filter(|b: &ContentBlock| b.kind == "tool_result")
                    .map(|b| AgentEvent::ToolResult {
                        id: b.tool_use_id,
                        is_error: b.is_error.unwrap_or(false),
                    })
                    .collect()
            }

            Frame::ToolCall(f) => {
                vec![AgentEvent::ToolCall {
                    id: f.effective_id(),
                    call: decode_tool_call(&f.effective_name(), &f.effective_input()),
                }]
            }

            Frame::ToolResult(f) => {
                vec![AgentEvent::ToolResult {
                    id: f.tool_use_id,
                    is_error: f.is_error,
                }]
            }

            Frame::Result(f) => {
                if let Some(id) = &f.session_id {
                    self.session_id = Some(id.clone());
                }
                let error = if f.errors.is_empty() {
                    None
                } else {
                    Some(
                        f.errors
                            .iter()
                            .map(|e| match e {
                                Value::String(s) => s.clone(),
                                other => other.to_string(),
                            })
                            .collect::<Vec<_>>()
                            .join("; "),
                    )
                };
                let done = if f.subtype == "success" || (f.subtype.is_empty() && error.is_none()) {
                    AgentEvent::Done {
                        status: if interrupted {
                            DoneStatus::Interrupted
                        } else {
                            DoneStatus::Completed
                        },
                        result: f.result,
                        error: None,
                        session_id: f.session_id,
                    }
                } else {
                    AgentEvent::Done {
                        status: if interrupted {
                            DoneStatus::Interrupted
                        } else {
                            DoneStatus::Errored
                        },
                        result: None,
                        error: error.or_else(|| Some("The run ended with an error.".into())),
                        session_id: f.session_id,
                    }
                };
                vec![done]
            }

            Frame::Other => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_shell_tool() {
        assert_eq!(
            decode_tool_call("shell", &json!({"command": "cargo test"})),
            ToolCall::Exec {
                command: "cargo test".into()
            }
        );
    }

    #[test]
    fn decodes_edit_tool() {
        assert_eq!(
            decode_tool_call(
                "edit",
                &json!({"file_path": "/a", "old_string": "x", "new_string": "y"})
            ),
            ToolCall::EditFile {
                path: "/a".into(),
                old_string: Some("x".into()),
                new_string: Some("y".into())
            }
        );
    }

    #[test]
    fn decodes_unknown_tool() {
        let tc = decode_tool_call("mystery", &json!({"x": 1}));
        assert!(matches!(tc, ToolCall::Unknown { .. }));
    }

    #[test]
    fn decodes_mcp_tool() {
        assert_eq!(
            decode_tool_call("mcp__linear__search", &json!({"q": "bug"})),
            ToolCall::Mcp {
                server: "linear".into(),
                tool: "search".into(),
                input: Some(json!({"q": "bug"}))
            }
        );
    }

    #[test]
    fn system_frame_produces_session_started() {
        let frame = super::super::wire::parse_frame(
            r#"{"type":"system","model":"gpt-5","session_id":"s1","cwd":"/tmp"}"#,
        )
        .expect("parses");
        let events = Normalizer::new().normalize(frame, false);
        assert_eq!(events.len(), 1);
        match &events[0] {
            AgentEvent::SessionStarted {
                model, session_id, ..
            } => {
                assert_eq!(model, "gpt-5");
                assert_eq!(session_id, "s1");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn second_system_frame_is_dropped() {
        let mut norm = Normalizer::new();
        let f1 = super::super::wire::parse_frame(
            r#"{"type":"system","model":"gpt-5","session_id":"s1","cwd":"/tmp"}"#,
        )
        .expect("parses");
        let f2 = super::super::wire::parse_frame(
            r#"{"type":"system","model":"gpt-5","session_id":"s1","cwd":"/tmp"}"#,
        )
        .expect("parses");
        assert_eq!(norm.normalize(f1, false).len(), 1);
        assert_eq!(norm.normalize(f2, false).len(), 0);
    }

    #[test]
    fn result_success_maps_to_done() {
        let frame = super::super::wire::parse_frame(
            r#"{"type":"result","subtype":"success","result":"Done","session_id":"s1"}"#,
        )
        .expect("parses");
        let events = Normalizer::new().normalize(frame, false);
        match &events[0] {
            AgentEvent::Done { status, .. } => {
                assert_eq!(*status, DoneStatus::Completed);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
}
