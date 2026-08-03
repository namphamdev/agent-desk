use std::collections::BTreeMap;

use comet_doc::{MessagePart, MessageRole, SessionMessageEntry};
use comet_proto::ToolCall;

const DEFAULT_MAX_CHARS: usize = 14_000;
const DEFAULT_MAX_GOALS: usize = 8;
const DEFAULT_MAX_AGENT_NOTES: usize = 3;

pub const DEFAULT_REVIEW_PROMPT: &str = "Review the work from the previous session (summarized in the starting context).\n\nFocus on:\n1. Correctness — logic bugs, edge cases, broken contracts\n2. Security — injection, secrets, unsafe paths or permissions\n3. Regressions — unintended side effects on existing behavior\n4. Tests — missing or weak coverage for the changes\n5. Code quality — clarity, maintainability, unnecessary complexity\n\nFor each finding report: severity (blocker / major / minor / nit), file location, what's wrong, and a concrete fix suggestion. End with an overall assessment.\nIf the summary has no structured file diffs, inspect the project (and git status/diff if available) against the user goals and tool activity listed above.";

pub struct SessionChangeSummary {
    pub text: String,
    pub has_changes: bool,
    pub has_reviewable_content: bool,
}

fn message_text(entry: &SessionMessageEntry) -> String {
    entry
        .parts
        .iter()
        .filter_map(|part| match part {
            MessagePart::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn compact(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        format!(
            "{}…",
            one_line
                .chars()
                .take(max.saturating_sub(1))
                .collect::<String>()
        )
    }
}

fn exec_mutates(command: &str) -> bool {
    let padded = format!(" {} ", command.to_ascii_lowercase());
    [
        " rm ",
        " rmdir ",
        " mv ",
        " cp ",
        " install ",
        " tee ",
        " truncate ",
        " chmod ",
        " chown ",
        " touch ",
        " mkdir ",
        " ln ",
        " sed -i ",
        " git apply ",
        " git checkout ",
        " git restore ",
        " git rm ",
        " git mv ",
        " git add ",
        " git commit ",
        " git reset ",
        " npm install ",
        " npm i ",
        " pnpm install ",
        " yarn add ",
        " bun add ",
        " pip install ",
        " cargo add ",
    ]
    .iter()
    .any(|needle| padded.contains(needle))
}

fn tool_summary(call: &ToolCall) -> (String, Option<(&str, &str)>) {
    match call {
        ToolCall::Exec { command } => (
            format!("Shell: {}", compact(command, 160)),
            exec_mutates(command).then_some(("(shell command)", "edit")),
        ),
        ToolCall::ReadFile { path } => (format!("Read {path}"), None),
        ToolCall::WriteFile { path, .. } => (format!("Write {path}"), Some((path, "edit"))),
        ToolCall::EditFile { path, .. } => (format!("Edit {path}"), Some((path, "edit"))),
        ToolCall::ApplyPatch { path } => {
            let path = path.as_deref().unwrap_or("(apply patch)");
            (format!("Apply patch {path}"), Some((path, "edit")))
        }
        ToolCall::Search { pattern, path } => (
            format!(
                "Search {}{}",
                pattern,
                path.as_deref()
                    .map(|p| format!(" in {p}"))
                    .unwrap_or_default()
            ),
            None,
        ),
        ToolCall::Glob { pattern } => (format!("Glob {pattern}"), None),
        ToolCall::WebFetch { url, .. } => (format!("Fetch {url}"), None),
        ToolCall::WebSearch { query } => (format!("Web search {query}"), None),
        ToolCall::Todo { .. } => ("Update todo list".into(), None),
        ToolCall::Mcp { server, tool, .. } => (format!("{server}: {tool}"), None),
        ToolCall::Unknown { name, .. } => (name.clone(), None),
    }
}

pub fn summarize_session_changes(
    entries: &[SessionMessageEntry],
    session_title: Option<&str>,
    project: Option<&str>,
) -> SessionChangeSummary {
    let mut user_goals = Vec::new();
    let mut agent_notes = Vec::new();
    let mut files: BTreeMap<String, String> = BTreeMap::new();
    let mut other_tools = Vec::new();
    let mut tool_count = 0usize;

    for entry in entries {
        let text = message_text(entry);
        if entry.role == MessageRole::User
            && !text.trim().is_empty()
            && user_goals.len() < DEFAULT_MAX_GOALS
        {
            user_goals.push(compact(&text, 240));
        } else if entry.role == MessageRole::Assistant
            && !text.trim().is_empty()
            && agent_notes.len() < DEFAULT_MAX_AGENT_NOTES
        {
            agent_notes.push(compact(&text, 320));
        }
        for part in &entry.parts {
            let MessagePart::Tool { call, is_error, .. } = part else {
                continue;
            };
            tool_count += 1;
            let (label, mutation) = tool_summary(call);
            if let Some((path, kind)) = mutation {
                files.insert(path.to_string(), kind.to_string());
            } else {
                other_tools.push(format!(
                    "- {label}{}",
                    if *is_error { " (failed)" } else { "" }
                ));
            }
        }
    }

    let has_changes = !files.is_empty();
    let has_reviewable_content =
        has_changes || !user_goals.is_empty() || tool_count > 0 || !agent_notes.is_empty();
    let mut sections = vec!["# Session work summary".to_string()];
    if let Some(title) = session_title.filter(|title| !title.trim().is_empty()) {
        sections.push(format!("**Session:** {title}"));
    }
    if let Some(project) = project.filter(|project| !project.trim().is_empty()) {
        sections.push(format!("**Project:** {project}"));
    }
    sections.push(String::new());

    if !user_goals.is_empty() {
        sections.push("## User goals".into());
        sections.extend(user_goals.iter().map(|goal| format!("- {goal}")));
        sections.push(String::new());
    }

    sections.push(if files.is_empty() {
        "## Files changed".into()
    } else {
        format!("## Files changed ({})", files.len())
    });
    if files.is_empty() {
        sections.push("_No structured file edits were recorded. If the agent used shell commands or tools without diffs, use git status/diff and the activity below._".into());
    } else {
        for (path, kind) in &files {
            sections.push(format!("### `{path}` ({kind})"));
            sections.push(
                "_No diff content is retained in the transcript; inspect the file and git diff._"
                    .into(),
            );
        }
    }
    sections.push(String::new());

    if !other_tools.is_empty() {
        sections.push("## Other tool activity".into());
        sections.extend(other_tools.iter().take(30).cloned());
        if other_tools.len() > 30 {
            sections.push(format!("- … and {} more", other_tools.len() - 30));
        }
        sections.push(String::new());
    }
    if !agent_notes.is_empty() {
        sections.push("## Agent notes (excerpts)".into());
        sections.extend(agent_notes.iter().map(|note| format!("- {note}")));
    }

    let mut text = sections.join("\n").trim().to_string();
    if text.chars().count() > DEFAULT_MAX_CHARS {
        text = format!(
            "{}\n\n… (summary truncated)",
            text.chars()
                .take(DEFAULT_MAX_CHARS - 40)
                .collect::<String>()
                .trim_end()
        );
    }
    SessionChangeSummary {
        text,
        has_changes,
        has_reviewable_content,
    }
}

pub fn review_session_title(source_title: Option<&str>, max: usize) -> String {
    let base = source_title
        .unwrap_or("session")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let prefix = "Review: ";
    let budget = max.saturating_sub(prefix.chars().count());
    if base.chars().count() <= budget {
        format!("{prefix}{base}")
    } else {
        format!(
            "{prefix}{}…",
            base.chars()
                .take(budget.saturating_sub(1).max(1))
                .collect::<String>()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use comet_doc::MessageStatus;

    fn entry(role: MessageRole, text: &str, parts: Vec<MessagePart>) -> SessionMessageEntry {
        let mut all = vec![MessagePart::Text {
            id: "t0".into(),
            text: text.into(),
        }];
        all.extend(parts);
        SessionMessageEntry {
            id: "m".into(),
            role,
            parts: all,
            created_at: 1,
            device_id: "d".into(),
            status: Some(MessageStatus::Complete),
            continuation_of: None,
        }
    }

    #[test]
    fn summary_collects_goals_changes_and_notes() {
        let entries = vec![
            entry(MessageRole::User, "Fix the parser", vec![]),
            entry(
                MessageRole::Assistant,
                "Implemented and tested it.",
                vec![MessagePart::Tool {
                    id: "tool".into(),
                    call: ToolCall::EditFile {
                        path: "src/parser.rs".into(),
                        old_string: None,
                        new_string: None,
                    },
                    is_error: false,
                    resolved: true,
                }],
            ),
        ];
        let summary = summarize_session_changes(&entries, Some("Parser"), Some("comet"));
        assert!(summary.has_changes && summary.has_reviewable_content);
        assert!(summary.text.contains("Fix the parser"));
        assert!(summary.text.contains("`src/parser.rs`"));
        assert!(summary.text.contains("Implemented and tested it"));
    }

    #[test]
    fn review_title_is_bounded_and_unicode_safe() {
        let title =
            review_session_title(Some("A very long résumé parser implementation title"), 24);
        assert!(title.chars().count() <= 24);
        assert!(title.starts_with("Review: ") && title.ends_with('…'));
    }
}
