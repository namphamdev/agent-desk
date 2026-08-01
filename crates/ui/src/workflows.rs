use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Shared harness / memory orientation every default workflow starts with.
pub const WORKFLOW_HARNESS_PREAMBLE: &str = "\
This project may use the Comet / Claude Code harness layout.
Before doing the task, orient yourself with project docs (skip any path that does not exist):

1. `docs/memory/INDEX.md` — always start here; open only the topic files it points to.
2. Relevant topics under `docs/memory/topics/` (conventions, domain, tooling, incidents).
3. `AGENTS.md` / `CLAUDE.md` — behavioral guidelines (think first, simplicity, surgical changes, goal-driven checks).
4. `docs/architecture/` (arc42) — for structural or cross-cutting changes; do not paste full design into memory.
5. Project skills under `.claude/skills/` or `.agents/skills/` when a procedure matches the task.

Rules: do not invent docs that are missing; do not bloat INDEX.md; no secrets in memory files.";

const EMPTY_TASK: &str = "(No extra task notes — use the workflow goal and inspect the project.)";
const EMPTY_PR_REF: &str = "(No PR ref given — use `gh pr list` / current branch / ask the user.)";

const NEW_FEATURE_TEMPLATE: &str = "\
## Workflow: New feature

### Task
{{task}}

### How to work
1. Read memory INDEX + `topics/conventions.md` and `topics/domain.md` when present.
2. For non-trivial design, skim the relevant `docs/architecture/` sections (or ADRs).
3. State assumptions and success criteria. If the request is ambiguous, ask before coding.
4. Prefer the smallest change that fully solves the request — no speculative abstractions.
5. Implement with tests where they prove the feature; match existing project style.
6. Multi-step work: brief plan with verify checks (`step → verify`), then execute.

Start by confirming what you loaded from the harness docs, then propose a short plan and implement.";

const BUG_FIX_TEMPLATE: &str = "\
## Workflow: Bug fix

### Bug report
{{task}}

### How to work
1. Read memory INDEX + `topics/incidents.md` (known gotchas) and `topics/domain.md` when present.
2. Reproduce the bug. Prefer a failing test first when practical.
3. Find the root cause — do not paper over symptoms.
4. Apply a surgical fix only; do not refactor unrelated code.
5. Verify: failing test/case now passes; no obvious regressions.
6. If this is a recurring pitfall, suggest a short journal note for `docs/memory/journal/` (do not write secrets).

Start by confirming harness context and how you will reproduce the bug, then fix it.";

const REVIEW_PR_TEMPLATE: &str = "\
## Workflow: Review PR

### Pull request
{{prRef}}

### Review focus
{{task}}

### How to work
1. Read memory INDEX + `topics/conventions.md` (PR/git norms) when present.
2. Load the PR: prefer `gh pr view` / `gh pr diff` / `gh pr checks` when available; else git fetch + diff against the base branch.
3. Review for:
   - Correctness — logic bugs, edge cases, broken contracts
   - Security — injection, secrets, unsafe paths or permissions
   - Regressions — unintended side effects
   - Tests — missing or weak coverage
   - Code quality — clarity, maintainability, unnecessary complexity
   - Docs/memory — knowledge file changes reviewed like code
4. For each finding: severity (blocker / major / minor / nit), file location, what's wrong, concrete fix suggestion.
5. End with an overall assessment (approve / request changes / needs discussion).
6. Do **not** implement fixes unless the user explicitly asks.

Start by identifying the PR diff scope, then produce the structured review.";

const EXPLORE_FEATURE_TEMPLATE: &str = "\
## Workflow: Explore feature

### Explore
{{task}}

### How to work
1. Read memory INDEX + `topics/domain.md` (and other topics INDEX suggests).
2. Check `docs/architecture/` for building-block / runtime notes if the area is structural.
3. Trace the code paths: entry points, key modules, data flow, and tests.
4. Produce a clear map: how it works, important files, extension points, risks/gotchas.
5. Stay **read-only** — do not edit files, run destructive commands, or refactor unless the user asks.

Start by loading harness context, then explore and report findings.";

pub const FREE_CHAT_TEMPLATE: &str = "\
## Workflow: Free chat

No fixed task template — the user will drive the conversation after this orientation.

### How to work
1. Read memory INDEX; open only the topic files it points to when relevant.
2. Follow `AGENTS.md` / `CLAUDE.md` (think first, simplicity, surgical changes, goal-driven checks).
3. Use the project memory system: durable facts in `docs/memory/topics/`, raw capture in `docs/memory/journal/`; do not bloat INDEX; no secrets.
4. For structural questions, prefer `docs/architecture/` over inventing design.

Confirm you loaded harness context briefly, then wait for the user's next message.";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    #[serde(default)]
    pub id: String,
    #[serde(default, alias = "name")]
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_task_placeholder")]
    pub task_placeholder: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_pr_ref: bool,
    #[serde(default = "default_include_harness_preamble")]
    pub include_harness_preamble: bool,
    #[serde(alias = "template", default)]
    pub prompt_template: String,
}

fn default_task_placeholder() -> String {
    "Describe the task…".to_string()
}
fn default_include_harness_preamble() -> bool {
    true
}

impl WorkflowDefinition {
    pub fn is_valid(&self) -> bool {
        !self.label.trim().is_empty() && !self.prompt_template.trim().is_empty()
    }
}

pub fn builtin_workflows() -> Vec<WorkflowDefinition> {
    vec![
        WorkflowDefinition {
            id: "new_feature".into(),
            label: "New feature".into(),
            description: "Plan and implement a feature with tests and surgical diffs".into(),
            task_placeholder: "What should we build?".into(),
            needs_pr_ref: false,
            include_harness_preamble: true,
            prompt_template: NEW_FEATURE_TEMPLATE.into(),
        },
        WorkflowDefinition {
            id: "bug_fix".into(),
            label: "Bug fix".into(),
            description: "Reproduce, fix surgically, and verify with a failing test".into(),
            task_placeholder: "What is broken? Steps, expected vs actual…".into(),
            needs_pr_ref: false,
            include_harness_preamble: true,
            prompt_template: BUG_FIX_TEMPLATE.into(),
        },
        WorkflowDefinition {
            id: "review_pr".into(),
            label: "Review PR".into(),
            description: "Review a pull request for correctness, security, and quality".into(),
            task_placeholder: "What should the review focus on? (optional notes)".into(),
            needs_pr_ref: true,
            include_harness_preamble: true,
            prompt_template: REVIEW_PR_TEMPLATE.into(),
        },
        WorkflowDefinition {
            id: "explore_feature".into(),
            label: "Explore feature".into(),
            description: "Map how something works — read-only unless you ask to edit".into(),
            task_placeholder: "What area or feature should we explore?".into(),
            needs_pr_ref: false,
            include_harness_preamble: true,
            prompt_template: EXPLORE_FEATURE_TEMPLATE.into(),
        },
    ]
}

pub fn slugify_id(raw: &str) -> String {
    let s = raw.trim().to_lowercase();
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let out = out.trim_matches('_');
    if out.is_empty() {
        "workflow".into()
    } else {
        out.chars().take(48).collect()
    }
}

pub fn normalize_workflow_list(raw: Vec<WorkflowDefinition>) -> Vec<WorkflowDefinition> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (i, mut w) in raw.into_iter().enumerate() {
        w.label = w.label.trim().to_string();
        w.description = w.description.trim().to_string();
        w.task_placeholder = if w.task_placeholder.trim().is_empty() {
            default_task_placeholder()
        } else {
            w.task_placeholder.trim().to_string()
        };

        if !w.is_valid() {
            continue;
        }

        w.id = if w.id.trim().is_empty() {
            slugify_id(&w.label)
        } else {
            slugify_id(&w.id)
        };
        if w.id.is_empty() {
            w.id = format!("workflow_{}", i + 1);
        }

        let mut id = w.id.clone();
        let mut n = 2;
        while seen.contains(&id) {
            id = format!("{}_{}", w.id, n);
            n += 1;
        }
        seen.insert(id.clone());
        w.id = id;
        out.push(w);
    }
    out
}

#[derive(Debug, PartialEq)]
pub enum ResolveWorkflowsSource {
    Project,
    Global,
    Builtin,
}

pub struct ResolveWorkflowsResult {
    pub workflows: Vec<WorkflowDefinition>,
    pub source: ResolveWorkflowsSource,
}

pub fn resolve_workflows(
    global: &[WorkflowDefinition],
    project: &[WorkflowDefinition],
) -> ResolveWorkflowsResult {
    let project_list = normalize_workflow_list(project.to_vec());
    if !project_list.is_empty() {
        return ResolveWorkflowsResult {
            workflows: project_list,
            source: ResolveWorkflowsSource::Project,
        };
    }
    let global_list = normalize_workflow_list(global.to_vec());
    if !global_list.is_empty() {
        return ResolveWorkflowsResult {
            workflows: global_list,
            source: ResolveWorkflowsSource::Global,
        };
    }
    ResolveWorkflowsResult {
        workflows: builtin_workflows(),
        source: ResolveWorkflowsSource::Builtin,
    }
}

pub fn workflow_session_title(
    workflow: &WorkflowDefinition,
    task: &str,
    pr_ref: Option<&str>,
) -> String {
    let label = &workflow.label;
    if workflow.needs_pr_ref {
        if let Some(r) = pr_ref {
            let ref_str = r.trim().split_whitespace().collect::<Vec<_>>().join(" ");
            let ref_str = if ref_str.chars().count() > 40 {
                ref_str.chars().take(40).collect::<String>()
            } else {
                ref_str
            };
            if !ref_str.is_empty() {
                let note = task.trim().split_whitespace().collect::<Vec<_>>().join(" ");
                let note = if note.chars().count() > 32 {
                    note.chars().take(32).collect::<String>()
                } else {
                    note
                };
                if !note.is_empty() {
                    return format!("{}: {} — {}", label, ref_str, note);
                }
                return format!("{}: {}", label, ref_str);
            }
        }
    }
    let short = task.trim().split_whitespace().collect::<Vec<_>>().join(" ");
    let short = if short.chars().count() > 48 {
        short.chars().take(48).collect::<String>()
    } else {
        short
    };
    if !short.is_empty() {
        format!("{}: {}", label, short)
    } else {
        label.clone()
    }
}

pub fn build_workflow_prompt(
    workflow: &WorkflowDefinition,
    task: &str,
    pr_ref: Option<&str>,
) -> String {
    let task_str = if task.trim().is_empty() {
        EMPTY_TASK
    } else {
        task.trim()
    };
    let pr_ref_str = if let Some(r) = pr_ref {
        if r.trim().is_empty() {
            EMPTY_PR_REF
        } else {
            r.trim()
        }
    } else {
        EMPTY_PR_REF
    };

    let body = workflow
        .prompt_template
        .replace("{{task}}", task_str)
        .replace("{{prRef}}", pr_ref_str);

    if workflow.include_harness_preamble {
        format!("{}\n\n{}", WORKFLOW_HARNESS_PREAMBLE, body)
    } else {
        body
    }
}

pub fn build_free_chat_prompt() -> String {
    format!("{}\n\n{}", WORKFLOW_HARNESS_PREAMBLE, FREE_CHAT_TEMPLATE)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ProjectWorkflowsFile {
    pub version: u32,
    pub workflows: Vec<WorkflowDefinition>,
}

pub fn project_workflows_path(cwd: &Path) -> PathBuf {
    cwd.join(".comet").join("workflows.json")
}

pub fn parse_workflow_json(text: &str) -> Result<Vec<WorkflowDefinition>, serde_json::Error> {
    if let Ok(file) = serde_json::from_str::<ProjectWorkflowsFile>(text) {
        return Ok(normalize_workflow_list(file.workflows));
    }
    serde_json::from_str::<Vec<WorkflowDefinition>>(text).map(normalize_workflow_list)
}

pub fn load_project_workflows(cwd: &Path) -> Vec<WorkflowDefinition> {
    let path = project_workflows_path(cwd);
    if let Ok(text) = std::fs::read_to_string(&path) {
        return parse_workflow_json(&text).unwrap_or_default();
    }
    Vec::new()
}

pub fn save_project_workflows(cwd: &Path, workflows: &[WorkflowDefinition]) -> std::io::Result<()> {
    let path = project_workflows_path(cwd);
    let workflows = normalize_workflow_list(workflows.to_vec());
    if workflows.is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        };
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = ProjectWorkflowsFile {
        version: 1,
        workflows,
    };
    let json = serde_json::to_string_pretty(&file)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    std::fs::write(path, format!("{json}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_and_slugify() {
        let w = WorkflowDefinition {
            id: "".into(),
            label: "My Feature!".into(),
            description: "".into(),
            task_placeholder: "".into(),
            needs_pr_ref: false,
            include_harness_preamble: false,
            prompt_template: "Hello {{task}}".into(),
        };
        let normalized = normalize_workflow_list(vec![w]);
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].id, "my_feature");
        assert_eq!(normalized[0].task_placeholder, "Describe the task…");

        let invalid = WorkflowDefinition {
            id: "".into(),
            label: "  ".into(),
            description: "".into(),
            task_placeholder: "".into(),
            needs_pr_ref: false,
            include_harness_preamble: false,
            prompt_template: "".into(),
        };
        let normalized_empty = normalize_workflow_list(vec![invalid]);
        assert_eq!(normalized_empty.len(), 0);
    }

    #[test]
    fn test_resolve_workflows() {
        let global = vec![WorkflowDefinition {
            id: "global1".into(),
            label: "Global 1".into(),
            description: "".into(),
            task_placeholder: "".into(),
            needs_pr_ref: false,
            include_harness_preamble: false,
            prompt_template: "T".into(),
        }];

        let project = vec![WorkflowDefinition {
            id: "proj1".into(),
            label: "Project 1".into(),
            description: "".into(),
            task_placeholder: "".into(),
            needs_pr_ref: false,
            include_harness_preamble: false,
            prompt_template: "T".into(),
        }];

        // Project wins
        let r1 = resolve_workflows(&global, &project);
        assert_eq!(r1.source, ResolveWorkflowsSource::Project);
        assert_eq!(r1.workflows[0].id, "proj1");

        // Global wins
        let r2 = resolve_workflows(&global, &[]);
        assert_eq!(r2.source, ResolveWorkflowsSource::Global);
        assert_eq!(r2.workflows[0].id, "global1");

        // Builtin fallback
        let r3 = resolve_workflows(&[], &[]);
        assert_eq!(r3.source, ResolveWorkflowsSource::Builtin);
        assert_eq!(r3.workflows[0].id, "new_feature");
    }

    #[test]
    fn test_workflow_session_title() {
        let w = WorkflowDefinition {
            id: "id".into(),
            label: "Test".into(),
            description: "".into(),
            task_placeholder: "".into(),
            needs_pr_ref: true,
            include_harness_preamble: false,
            prompt_template: "T".into(),
        };

        assert_eq!(
            workflow_session_title(&w, "short task", Some("123")),
            "Test: 123 — short task"
        );
        assert_eq!(
            workflow_session_title(&w, "short task", None),
            "Test: short task"
        );

        let w2 = WorkflowDefinition {
            id: "id".into(),
            label: "Test".into(),
            description: "".into(),
            task_placeholder: "".into(),
            needs_pr_ref: false,
            include_harness_preamble: false,
            prompt_template: "T".into(),
        };
        assert_eq!(
            workflow_session_title(&w2, "short task", Some("123")),
            "Test: short task"
        );
    }

    #[test]
    fn project_workflows_round_trip_and_clear() {
        let dir = tempfile::tempdir().unwrap();
        let workflows = vec![WorkflowDefinition {
            id: "ship".into(),
            label: "Ship".into(),
            description: "Release it".into(),
            task_placeholder: "Version".into(),
            needs_pr_ref: false,
            include_harness_preamble: true,
            prompt_template: "Ship {{task}}".into(),
        }];
        save_project_workflows(dir.path(), &workflows).unwrap();
        assert_eq!(load_project_workflows(dir.path()), workflows);
        save_project_workflows(dir.path(), &[]).unwrap();
        assert!(!project_workflows_path(dir.path()).exists());
    }

    #[test]
    fn parses_bare_array_and_normalizes_duplicate_ids() {
        let parsed = parse_workflow_json(
            r#"[
                {"label":"One","promptTemplate":"First {{task}}"},
                {"id":"one","label":"Two","promptTemplate":"Second {{task}}"}
            ]"#,
        )
        .unwrap();
        assert_eq!(parsed[0].id, "one");
        assert_eq!(parsed[1].id, "one_2");
    }

    #[test]
    fn builds_prompt_with_substitutions_and_optional_preamble() {
        let workflow = &builtin_workflows()[2];
        let prompt = build_workflow_prompt(workflow, "Focus auth", Some("#42"));
        assert!(prompt.starts_with(WORKFLOW_HARNESS_PREAMBLE));
        assert!(prompt.contains("Focus auth"));
        assert!(prompt.contains("#42"));

        let mut plain = workflow.clone();
        plain.include_harness_preamble = false;
        assert!(
            !build_workflow_prompt(&plain, "Focus auth", Some("#42"))
                .contains(WORKFLOW_HARNESS_PREAMBLE)
        );
    }
}
