use comet_proto::{ApplyHarnessResult, HarnessOptimization, ProjectHarness};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const KARPATHY_SOURCE_URL: &str = "https://github.com/multica-ai/andrej-karpathy-skills";
const MEMORY_SOURCE_URL: &str = "https://arc42.org/";

const KARPATHY_MARKERS: &[&str] = &[
    "## 1. Think Before Coding",
    "## 2. Simplicity First",
    "## 3. Surgical Changes",
    "## 4. Goal-Driven Execution",
];

pub const CLAUDE_MD_AGENTS_REF: &str = "@AGENTS.md";
pub const CLAUDE_MD_MEMORY_REF: &str = "@docs/memory/INDEX.md";
const MEMORY_INDEX_MARKER: &str = "# Project memory index";
const ARCH_README_MARKER: &str = "# Architecture documentation (arc42)";

const KARPATHY_AGENTS_MD: &str = r#"# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
"#;

const KARPATHY_SKILL_MD: &str = r#"---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
license: MIT
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
"#;

pub fn contains_karpathy_guidelines(text: &str) -> bool {
    KARPATHY_MARKERS.iter().all(|&m| text.contains(m))
}

pub fn contains_agents_md_ref(text: &str) -> bool {
    text.to_lowercase().contains("@agents.md")
}

pub fn contains_memory_index_ref(text: &str) -> bool {
    text.to_lowercase().contains("@docs/memory/index.md")
}

const MEMORY_INDEX_MD: &str = r#"# Project memory index

> **Budget:** keep this file under ~1500 characters.
> **Always loaded** via `CLAUDE.md`. Put detail in `topics/` or `journal/`, not here.

## Hot facts

- (Add 3–8 short team-wide facts agents must always know.)

## Topics (read when relevant)

| Topic | File | When |
| --- | --- | --- |
| Conventions | [topics/conventions.md](./topics/conventions.md) | style, commits, PR, agent behavior |
| Tooling | [topics/tooling.md](./topics/tooling.md) | env, scripts, CI, hooks |
| Domain | [topics/domain.md](./topics/domain.md) | product behavior |
| Incidents | [topics/incidents.md](./topics/incidents.md) | recurring bugs / gotchas |

## Journal

Raw session lessons: [journal/](./journal/) (`YYYY-MM.md`).
**Not** imported into the default prompt. Promote into topics, then trim.

## Rules

1. Team-shared only — no personal prefs, no secrets.
2. One concern per topic file; compact instead of endless append.
3. Procedures → `.claude/skills/`, not memory essays.
4. Architecture changes → `docs/architecture/` (arc42) + ADR; link from here if needed.
"#;

const TOPIC_CONVENTIONS_MD: &str = r#"# Conventions

> Soft cap ~2–4k chars. Durable team conventions only.

## Agent guidelines

- Prefer repo `AGENTS.md` for coding behavior rules.
- Do not duplicate long guideline text here.

## Git / PR

- Review `docs/memory/**` and `docs/architecture/**` like code.
- Prefer topic-scoped memory edits over bloating `INDEX.md`.
- Never commit secrets or credentials.
"#;

const TOPIC_TOOLING_MD: &str = r#"# Tooling

> Soft cap ~2–4k chars. Env, commands, and agent tooling quirks.

## Commands

- Document install, test, and run commands the team actually uses.

## Paths

| Path | Role |
| --- | --- |
| `docs/memory/` | Team-shared memory (git) |
| `docs/architecture/` | arc42 architecture (git) |
| `.claude/` | Claude Code commands, skills, settings (Stop memory hook) |
"#;

const TOPIC_DOMAIN_MD: &str = r#"# Domain

> Soft cap ~2–4k chars. Product/domain facts agents need often.

## Product

- (What this project is, in 2–4 bullets.)

## Core concepts

| Concept | Meaning |
| --- | --- |
| (term) | (short definition) |

## Architecture pointer

Full design: `docs/architecture/` (arc42). Prefer ADRs over copying decisions into memory.
"#;

const TOPIC_INCIDENTS_MD: &str = r#"# Incidents / gotchas

> Soft cap ~2–4k chars. Recurring failures and fixes.

## Template

```markdown
### Short title (YYYY-MM)
- Symptom:
- Cause:
- Fix / avoid:
```

## Known

_(none yet)_
"#;

const JOURNAL_README_MD: &str = r#"# Memory journal

Append-only (by month) capture of session lessons. **Not** imported into `CLAUDE.md`.

## How to use

1. Add notes to `YYYY-MM.md` (create for the current month if missing).
2. Run `/memory-promote` (or manually) to move durable facts into `docs/memory/topics/`.
3. Delete or mark promoted lines so the journal stays a scratchpad.

## Format

```markdown
## YYYY-MM-DD — short title
- Context:
- Lesson:
- Promote to: topics/<file>.md | skill | arc42 | discard
```
"#;

const ARCH_README_MD: &str = r#"# Architecture documentation (arc42)

Canonical architecture for this project. Agents and humans read here for “how the system is built”; use `docs/memory/` for short team lessons only.

| § | Section | File |
| --- | --- | --- |
| 1 | Introduction and goals | [01-introduction-and-goals.md](./01-introduction-and-goals.md) |
| 2 | Constraints | [02-constraints.md](./02-constraints.md) |
| 3 | Context and scope | [03-context-and-scope.md](./03-context-and-scope.md) |
| 4 | Solution strategy | [04-solution-strategy.md](./04-solution-strategy.md) |
| 5 | Building block view | [05-building-block-view.md](./05-building-block-view.md) |
| 6 | Runtime view | [06-runtime-view.md](./06-runtime-view.md) |
| 7 | Deployment view | [07-deployment-view.md](./07-deployment-view.md) |
| 8 | Cross-cutting concepts | [08-crosscutting-concepts.md](./08-crosscutting-concepts.md) |
| 9 | Architecture decisions (ADRs) | [09-architecture-decisions/](./09-architecture-decisions/) |
| 10 | Quality requirements | [10-quality-requirements.md](./10-quality-requirements.md) |
| 11 | Risks and technical debt | [11-risks-and-technical-debt.md](./11-risks-and-technical-debt.md) |
| 12 | Glossary | [12-glossary.md](./12-glossary.md) |

## Related

| Store | Path |
| --- | --- |
| Memory index | `docs/memory/INDEX.md` |
| Memory topics | `docs/memory/topics/` |
| Agent behavior | `AGENTS.md` |

Fill sections as the system grows. Prefer a new ADR over silent redesign.
"#;

const ARCH_INTRO_MD: &str = r#"# 1. Introduction and goals

## 1.1 Summary

_(One paragraph: what this system is.)_

## 1.2 Quality goals

1. _(highest priority quality)_
2. _
3. _

## 1.3 Scope

**In scope:** …

**Out of scope:** …
"#;

const ARCH_ADR_README_MD: &str = r#"# 9. Architecture decisions (ADRs)

| ID | Title | Status |
| --- | --- | --- |
| _(add ADRs as decisions land)_ | | |

## ADR format

Each ADR records: context, decision, consequences, and alternatives considered.
"#;

const REMEMBER_COMMAND_MD: &str = r#"---
description: Capture a team lesson into project memory journal (not INDEX)
---

Capture durable **team** knowledge from this conversation into project memory.

## Rules

1. Write under `docs/memory/` only — never secrets or personal prefs.
2. Default: append to `docs/memory/journal/YYYY-MM.md` (current month; create if needed).
3. Do **not** dump long text into `docs/memory/INDEX.md` (keep INDEX small).
4. If the user names a topic and the fact is already curated, you may add a short bullet to the matching `docs/memory/topics/*.md` file instead.
5. If this is a procedure (multi-step how-to), prefer a skill under `.claude/skills/` over memory prose.
6. If this is an architecture decision, add/update an ADR under `docs/architecture/09-architecture-decisions/` and only link from memory.

## Journal entry format

```markdown
## YYYY-MM-DD — short title
- Context:
- Lesson:
- Promote to: topics/<file>.md | skill | arc42 | discard
```

## After writing

- Show the user the path and a one-line summary.
- Mention they can run `/memory-promote` later to move journal → topics.
"#;

const MEMORY_PROMOTE_COMMAND_MD: &str = r#"---
description: Promote journal lessons into topic memory files; keep INDEX small
---

Promote project memory from journal into curated topics.

## Steps

1. Read `docs/memory/INDEX.md` and note the character budget.
2. Read recent entries in `docs/memory/journal/` (current and previous month).
3. For each entry, decide: **topic** | **skill** | **arc42** | **discard**.
4. Apply edits surgically (small bullets, stable headings).
5. Update `INDEX.md` only for new topic rows or true hot facts — never paste full topics.
6. Remove or mark journal lines as promoted.
7. Summarize what moved; warn if INDEX (~1500 chars) or a topic (~2–4k) is over budget.

## Do not

- Merge everything into one MEMORY.md
- Put secrets in any memory file
- Duplicate AGENTS.md or full arc42 sections into topics
"#;

pub const MEMORY_STOP_HOOK_MARKER: &str = "PROJECT_MEMORY_STOP_HOOK";

pub const MEMORY_STOP_HOOK_PROMPT: &str = r#"PROJECT_MEMORY_STOP_HOOK
You are the project-memory Stop gate for a git-synced team memory system.

Decide whether the main agent may stop.

Approve (allow stop) when ANY of these is true:
- No team-durable lesson (routine coding, one-off debug, pure Q&A, or already-known facts).
- A journal/topic/ADR/skill capture for this session's lesson was already written under docs/memory/ or docs/architecture/ or .claude/skills/.
- The only leftovers are secrets, credentials, personal prefs, or local machine paths — never put those in memory.

Block (force continue) ONLY when ALL of these are true:
- This turn produced a reusable team lesson (gotcha, convention, tooling quirk, domain fact, or architecture decision).
- That lesson is not yet written to docs/memory/journal/YYYY-MM.md (preferred), a matching docs/memory/topics/*.md bullet, an ADR, or a skill.

When blocking, reason must tell the agent to:
1) Append a short journal entry to docs/memory/journal/YYYY-MM.md (current month; create if needed) using:
   ## YYYY-MM-DD — short title
   - Context:
   - Lesson:
   - Promote to: topics/<file>.md | skill | arc42 | discard
2) Do NOT grow docs/memory/INDEX.md with long dumps; no secrets.
3) Then stop (or run /memory-promote later for topic promotion).

Return decision approve or block with a short reason. Prefer approve when unsure."#;

fn build_project_memory_settings_doc() -> serde_json::Value {
    serde_json::json!({
        "hooks": {
            "Stop": [
                {
                    "hooks": [
                        {
                            "type": "prompt",
                            "prompt": MEMORY_STOP_HOOK_PROMPT,
                            "timeout": 30,
                            "statusMessage": "Checking project memory capture"
                        }
                    ]
                }
            ]
        }
    })
}

const CLAUDE_MD_MEMORY_BODY: &str = r#"# Architecture

Canonical architecture: `docs/architecture/` (arc42).
Read relevant sections before large structural changes.
Record decisions as ADRs under `docs/architecture/09-architecture-decisions/`.

# Memory

Team memory: `docs/memory/` (git-synced).

- **Always loaded:** `docs/memory/INDEX.md` only (keep it small).
- **Durable facts:** `docs/memory/topics/*.md` — open when INDEX says so.
- **Raw capture:** `docs/memory/journal/YYYY-MM.md` — not always loaded.
- **Commands:** `/remember` (capture), `/memory-promote` (journal → topics).
- **No secrets** or personal prefs in shared memory.
- **Procedures** → skills under `.claude/skills/`, not long memory essays.

Stop hook (in `.claude/settings.json`): after each turn, a prompt-type Stop gate asks whether a team-durable lesson should be journaled before the agent fully stops. Prefer approve when unsure; never store secrets.
"#;

fn write_new_file(
    abs_path: &Path,
    content: &str,
    rel_path: &str,
    written: &mut Vec<String>,
) -> std::io::Result<()> {
    if abs_path.exists() {
        if let Ok(existing) = fs::read_to_string(abs_path) {
            if !existing.trim().is_empty() {
                return Ok(());
            }
        }
    }
    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let content = if content.ends_with('\n') {
        content.to_string()
    } else {
        format!("{}\n", content)
    };
    fs::write(abs_path, content)?;
    written.push(rel_path.to_string());
    Ok(())
}

fn file_exists(path: &Path) -> bool {
    path.exists()
}

fn read_text(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn agents_md_path(cwd: &Path) -> PathBuf {
    cwd.join("AGENTS.md")
}

fn claude_md_path(cwd: &Path) -> PathBuf {
    cwd.join("CLAUDE.md")
}

const SKILL_ID: &str = "karpathy-guidelines";

fn agents_skill_dir(cwd: &Path) -> PathBuf {
    cwd.join(".agents").join("skills").join(SKILL_ID)
}

fn claude_skill_dir(cwd: &Path) -> PathBuf {
    cwd.join(".claude").join("skills").join(SKILL_ID)
}

fn is_skill_present(skill_dir: &Path) -> bool {
    let skill_md = skill_dir.join("SKILL.md");
    if let Some(content) = read_text(&skill_md) {
        contains_karpathy_guidelines(&content) || content.contains(&format!("name: {}", SKILL_ID))
    } else {
        false
    }
}

pub fn ensure_claude_skill_symlink(agents_dir: &Path, claude_dir: &Path) -> Result<bool, String> {
    if let Some(parent) = claude_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let target = fs::canonicalize(agents_dir).unwrap_or_else(|_| agents_dir.to_path_buf());

    if let Ok(st) = fs::symlink_metadata(claude_dir) {
        if st.is_symlink() {
            if let Ok(current) = fs::read_link(claude_dir) {
                let resolved = if current.is_absolute() {
                    current.clone()
                } else {
                    claude_dir.parent().unwrap_or(Path::new("")).join(&current)
                };
                let resolved = fs::canonicalize(&resolved).unwrap_or(resolved);
                if resolved == target {
                    return Ok(false);
                }
            }
            fs::remove_file(claude_dir).map_err(|e| e.to_string())?;
        } else if st.is_dir() {
            fs::remove_dir_all(claude_dir).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(claude_dir).map_err(|e| e.to_string())?;
        }
    }

    #[cfg(unix)]
    let rel = Path::new("..")
        .join("..")
        .join(".agents")
        .join("skills")
        .join(SKILL_ID);
    #[cfg(windows)]
    let rel = Path::new("..")
        .join("..")
        .join(".agents")
        .join("skills")
        .join(SKILL_ID); // Actually windows symlinks need special care, but comet runs on macOS mostly.

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(rel, claude_dir).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(rel, claude_dir).map_err(|e| e.to_string())?;
    }

    Ok(true)
}

fn detect_karpathy(cwd: &Path) -> (bool, Option<String>) {
    let mut labels = Vec::new();
    let mut core = false;

    if let Some(agents_md) = read_text(&agents_md_path(cwd)) {
        if contains_karpathy_guidelines(&agents_md) {
            labels.push("AGENTS.md".to_string());
            core = true;
        }
    }

    let claude_md = read_text(&claude_md_path(cwd));
    if let Some(ref md) = claude_md {
        if contains_karpathy_guidelines(md) {
            labels.push("CLAUDE.md (legacy inline)".to_string());
            core = true;
        } else if contains_agents_md_ref(md) && core {
            labels.push("CLAUDE.md → @AGENTS.md".to_string());
        }
    }

    let agents_dir = agents_skill_dir(cwd);
    let claude_dir = claude_skill_dir(cwd);

    if is_skill_present(&agents_dir) {
        labels.push(format!(".agents/skills/{}", SKILL_ID));
        core = true;
    }

    if let Ok(st) = fs::symlink_metadata(&claude_dir) {
        if st.is_symlink() && is_skill_present(&claude_dir) {
            labels.push(format!(".claude/skills/{} → .agents", SKILL_ID));
            core = true;
        } else if is_skill_present(&claude_dir) {
            labels.push(format!(".claude/skills/{}", SKILL_ID));
            core = true;
        }
    }

    if let Some(ref md) = claude_md {
        if contains_agents_md_ref(md) && core && !labels.iter().any(|l| l.starts_with("CLAUDE.md"))
        {
            labels.push("CLAUDE.md → @AGENTS.md".to_string());
        }
    }

    if !core {
        (false, None)
    } else {
        (true, Some(labels.join(" · ")))
    }
}

fn memory_index_path(cwd: &Path) -> PathBuf {
    cwd.join("docs").join("memory").join("INDEX.md")
}

fn detect_project_memory(cwd: &Path) -> (bool, Option<String>) {
    let mut labels = Vec::new();

    let index = read_text(&memory_index_path(cwd));
    if let Some(ref idx) = index {
        if idx.contains(MEMORY_INDEX_MARKER) {
            labels.push("docs/memory/INDEX.md".to_string());
        }
    }

    if let Some(claude_md) = read_text(&claude_md_path(cwd)) {
        if contains_memory_index_ref(&claude_md) {
            labels.push("CLAUDE.md → @docs/memory/INDEX.md".to_string());
        }
    }

    if file_exists(
        &cwd.join("docs")
            .join("memory")
            .join("topics")
            .join("conventions.md"),
    ) {
        labels.push("topics/".to_string());
    }

    if file_exists(&cwd.join(".claude").join("commands").join("remember.md")) {
        labels.push(".claude/commands".to_string());
    }

    let settings_raw = read_text(&cwd.join(".claude").join("settings.json"));
    if let Some(ref raw) = settings_raw {
        if raw.contains(MEMORY_STOP_HOOK_MARKER) {
            labels.push(".claude/settings.json Stop hook".to_string());
        }
    } else if let Some(raw) = read_text(&cwd.join(".claude").join("settings.example.json")) {
        if raw.contains(MEMORY_STOP_HOOK_MARKER) {
            labels.push(".claude/settings.example.json".to_string());
        }
    }

    if let Some(raw) = read_text(&cwd.join("docs").join("architecture").join("README.md")) {
        if raw.contains(ARCH_README_MARKER) {
            labels.push("docs/architecture/".to_string());
        }
    }

    if labels.is_empty() {
        return (false, None);
    }
    let applied = index
        .map(|idx| idx.contains(MEMORY_INDEX_MARKER))
        .unwrap_or(false);
    (applied, Some(labels.join(" · ")))
}

pub fn is_project_memory_stop_hook(hook: &Value) -> bool {
    if let Value::Object(map) = hook {
        if map.get("type").and_then(|v| v.as_str()) == Some("prompt") {
            if let Some(prompt) = map.get("prompt").and_then(|v| v.as_str()) {
                return prompt.contains(MEMORY_STOP_HOOK_MARKER);
            }
        }
        if map.get("type").and_then(|v| v.as_str()) == Some("command") {
            if let Some(command) = map.get("command").and_then(|v| v.as_str()) {
                return command.contains("[project memory]")
                    || command.contains("[terminal-react memory]")
                    || (command.contains("docs/memory") && command.contains("/remember"));
            }
        }
    }
    false
}

pub fn ensure_project_memory_stop_hook(settings: &mut Value) -> bool {
    let mut changed = false;
    let mut found_ours = false;

    let base = match settings {
        Value::Object(map) => map,
        _ => {
            *settings = Value::Object(serde_json::Map::new());
            settings.as_object_mut().unwrap()
        }
    };

    let hooks_root = base
        .entry("hooks")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let hooks_map = match hooks_root {
        Value::Object(map) => map,
        _ => {
            *hooks_root = Value::Object(serde_json::Map::new());
            hooks_root.as_object_mut().unwrap()
        }
    };

    let stop_list = hooks_map
        .entry("Stop")
        .or_insert_with(|| Value::Array(Vec::new()));
    let stop_array = match stop_list {
        Value::Array(arr) => arr,
        _ => {
            *stop_list = Value::Array(Vec::new());
            stop_list.as_array_mut().unwrap()
        }
    };

    for group in stop_array.iter_mut() {
        if let Value::Object(group_map) = group {
            if let Some(Value::Array(inner)) = group_map.get_mut("hooks") {
                for h in inner.iter_mut() {
                    if is_project_memory_stop_hook(h) {
                        found_ours = true;
                        if h.get("type").and_then(|v| v.as_str()) == Some("prompt")
                            && h.get("prompt").and_then(|v| v.as_str())
                                == Some(MEMORY_STOP_HOOK_PROMPT)
                        {
                            continue;
                        }
                        *h = serde_json::json!({
                            "type": "prompt",
                            "prompt": MEMORY_STOP_HOOK_PROMPT,
                            "timeout": 30,
                            "statusMessage": "Checking project memory capture"
                        });
                        changed = true;
                    }
                }
            }
        }
    }

    if !found_ours {
        stop_array.push(serde_json::json!({
            "hooks": [
                {
                    "type": "prompt",
                    "prompt": MEMORY_STOP_HOOK_PROMPT,
                    "timeout": 30,
                    "statusMessage": "Checking project memory capture"
                }
            ]
        }));
        changed = true;
    }

    changed
}

pub fn ensure_claude_settings_memory(root: &Path, written: &mut Vec<String>) -> Result<(), String> {
    let example_path = root.join(".claude").join("settings.example.json");
    let settings_path = root.join(".claude").join("settings.json");

    let example_existing = read_text(&example_path);
    if example_existing
        .as_ref()
        .map(|s| s.trim().is_empty() || !s.contains(MEMORY_STOP_HOOK_MARKER))
        .unwrap_or(true)
    {
        if let Some(parent) = example_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let doc = build_project_memory_settings_doc();
        fs::write(
            &example_path,
            format!("{}\n", serde_json::to_string_pretty(&doc).unwrap()),
        )
        .map_err(|e| e.to_string())?;
        written.push(".claude/settings.example.json".to_string());
    }

    let raw = read_text(&settings_path);
    let mut parsed = serde_json::Value::Object(serde_json::Map::new());
    if let Some(ref r) = raw {
        if !r.trim().is_empty() {
            if let Ok(v) = serde_json::from_str(r) {
                parsed = v;
            } else {
                return Ok(());
            }
        }
    }

    let changed = ensure_project_memory_stop_hook(&mut parsed);
    if changed || raw.as_ref().map(|r| r.trim().is_empty()).unwrap_or(true) {
        if let Some(parent) = settings_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(
            &settings_path,
            format!("{}\n", serde_json::to_string_pretty(&parsed).unwrap()),
        )
        .map_err(|e| e.to_string())?;
        written.push(".claude/settings.json".to_string());
    }
    Ok(())
}

pub fn ensure_claude_md_memory(
    claude_path: &Path,
    written: &mut Vec<String>,
) -> Result<(), String> {
    let existing = read_text(claude_path);
    if let Some(mut next) = existing {
        let mut changed = false;

        if !contains_memory_index_ref(&next) {
            if contains_agents_md_ref(&next) {
                let lower = next.to_lowercase();
                if let Some(pos) = lower.find("@agents.md") {
                    let end_pos = next[pos..]
                        .find('\n')
                        .map_or(next.len(), |offset| pos + offset + 1);
                    let before = &next[..end_pos];
                    let after = &next[end_pos..];
                    next = format!("{}{}\n{}", before, CLAUDE_MD_MEMORY_REF, after);
                } else {
                    next = format!("{}\n{}", CLAUDE_MD_MEMORY_REF, next);
                }
            } else {
                let sep = if next.starts_with('\n') { "" } else { "\n" };
                next = format!(
                    "{}\n{}{}{}",
                    CLAUDE_MD_AGENTS_REF, CLAUDE_MD_MEMORY_REF, sep, next
                );
            }
            changed = true;
        } else if !contains_agents_md_ref(&next) {
            next = format!("{}\n{}", CLAUDE_MD_AGENTS_REF, next);
            changed = true;
        }

        let has_memory_heading = next.starts_with("# Memory") || next.contains("\n# Memory");
        if !has_memory_heading {
            let sep = if next.ends_with('\n') { "\n" } else { "\n\n" };
            next = format!("{}{}{}", next, sep, CLAUDE_MD_MEMORY_BODY);
            changed = true;
        }

        if changed {
            let next = if next.ends_with('\n') {
                next
            } else {
                format!("{}\n", next)
            };
            fs::write(claude_path, next).map_err(|e| e.to_string())?;
            written.push("CLAUDE.md".to_string());
        }
    } else {
        let body = format!(
            "{}\n{}\n\n{}",
            CLAUDE_MD_AGENTS_REF, CLAUDE_MD_MEMORY_REF, CLAUDE_MD_MEMORY_BODY
        );
        if let Some(parent) = claude_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(claude_path, format!("{}\n", body)).map_err(|e| e.to_string())?;
        written.push("CLAUDE.md".to_string());
    }
    Ok(())
}

fn apply_karpathy(root: &Path, written: &mut Vec<String>) -> Result<(), String> {
    let agents_path = agents_md_path(root);
    if let Some(existing) = read_text(&agents_path) {
        if !contains_karpathy_guidelines(&existing) {
            let sep = if existing.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
            fs::write(
                &agents_path,
                format!("{}{}{}", existing, sep, KARPATHY_AGENTS_MD),
            )
            .map_err(|e| e.to_string())?;
            written.push("AGENTS.md".to_string());
        }
    } else {
        fs::write(&agents_path, KARPATHY_AGENTS_MD).map_err(|e| e.to_string())?;
        written.push("AGENTS.md".to_string());
    }

    let claude_path = claude_md_path(root);
    if let Some(existing) = read_text(&claude_path) {
        if !contains_agents_md_ref(&existing) {
            let sep = if existing.starts_with('\n') { "" } else { "\n" };
            fs::write(
                &claude_path,
                format!("{}\n{}{}", CLAUDE_MD_AGENTS_REF, sep, existing),
            )
            .map_err(|e| e.to_string())?;
            written.push("CLAUDE.md".to_string());
        }
    } else {
        fs::write(&claude_path, format!("{}\n", CLAUDE_MD_AGENTS_REF))
            .map_err(|e| e.to_string())?;
        written.push("CLAUDE.md".to_string());
    }

    let skill_dir = agents_skill_dir(root);
    let skill_md = skill_dir.join("SKILL.md");
    fs::create_dir_all(&skill_dir).map_err(|e| e.to_string())?;

    if let Some(prior) = read_text(&skill_md) {
        if !contains_karpathy_guidelines(&prior) {
            fs::write(&skill_md, KARPATHY_SKILL_MD).map_err(|e| e.to_string())?;
            written.push(format!(".agents/skills/{}/SKILL.md", SKILL_ID));
        }
    } else {
        fs::write(&skill_md, KARPATHY_SKILL_MD).map_err(|e| e.to_string())?;
        written.push(format!(".agents/skills/{}/SKILL.md", SKILL_ID));
    }

    let changed = ensure_claude_skill_symlink(&skill_dir, &claude_skill_dir(root))?;
    if changed {
        written.push(format!(
            ".claude/skills/{} → .agents/skills/{}",
            SKILL_ID, SKILL_ID
        ));
    }

    Ok(())
}

fn apply_project_memory(root: &Path, written: &mut Vec<String>) -> Result<(), String> {
    write_new_file(
        &memory_index_path(root),
        MEMORY_INDEX_MD,
        "docs/memory/INDEX.md",
        written,
    )
    .map_err(|e| e.to_string())?;
    write_new_file(
        &root
            .join("docs")
            .join("memory")
            .join("topics")
            .join("conventions.md"),
        TOPIC_CONVENTIONS_MD,
        "docs/memory/topics/conventions.md",
        written,
    )
    .map_err(|e| e.to_string())?;
    write_new_file(
        &root
            .join("docs")
            .join("memory")
            .join("topics")
            .join("tooling.md"),
        TOPIC_TOOLING_MD,
        "docs/memory/topics/tooling.md",
        written,
    )
    .map_err(|e| e.to_string())?;
    write_new_file(
        &root
            .join("docs")
            .join("memory")
            .join("topics")
            .join("domain.md"),
        TOPIC_DOMAIN_MD,
        "docs/memory/topics/domain.md",
        written,
    )
    .map_err(|e| e.to_string())?;
    write_new_file(
        &root
            .join("docs")
            .join("memory")
            .join("topics")
            .join("incidents.md"),
        TOPIC_INCIDENTS_MD,
        "docs/memory/topics/incidents.md",
        written,
    )
    .map_err(|e| e.to_string())?;
    write_new_file(
        &root
            .join("docs")
            .join("memory")
            .join("journal")
            .join("README.md"),
        JOURNAL_README_MD,
        "docs/memory/journal/README.md",
        written,
    )
    .map_err(|e| e.to_string())?;
    write_new_file(
        &root.join("docs").join("architecture").join("README.md"),
        ARCH_README_MD,
        "docs/architecture/README.md",
        written,
    )
    .map_err(|e| e.to_string())?;
    write_new_file(
        &root
            .join("docs")
            .join("architecture")
            .join("01-introduction-and-goals.md"),
        ARCH_INTRO_MD,
        "docs/architecture/01-introduction-and-goals.md",
        written,
    )
    .map_err(|e| e.to_string())?;
    write_new_file(
        &root
            .join("docs")
            .join("architecture")
            .join("09-architecture-decisions")
            .join("README.md"),
        ARCH_ADR_README_MD,
        "docs/architecture/09-architecture-decisions/README.md",
        written,
    )
    .map_err(|e| e.to_string())?;
    write_new_file(
        &root.join(".claude").join("commands").join("remember.md"),
        REMEMBER_COMMAND_MD,
        ".claude/commands/remember.md",
        written,
    )
    .map_err(|e| e.to_string())?;
    write_new_file(
        &root
            .join(".claude")
            .join("commands")
            .join("memory-promote.md"),
        MEMORY_PROMOTE_COMMAND_MD,
        ".claude/commands/memory-promote.md",
        written,
    )
    .map_err(|e| e.to_string())?;

    ensure_claude_settings_memory(root, written)?;
    ensure_claude_md_memory(&claude_md_path(root), written)?;

    Ok(())
}

pub fn get_project_harness(cwd: &str, project_name: Option<&str>) -> ProjectHarness {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return ProjectHarness {
            project: project_name.unwrap_or("unknown").to_string(),
            cwd: "".to_string(),
            ok: false,
            error: Some("No project path".to_string()),
            has_claude_md: false,
            has_agents_md: false,
            optimizations: vec![],
            applied_count: 0,
        };
    }

    let resolved = Path::new(trimmed); // PathBuf resolving is trivial if absolute
    if !resolved.is_dir() {
        return ProjectHarness {
            project: project_name.map(|s| s.to_string()).unwrap_or_else(|| {
                resolved
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            }),
            cwd: resolved.to_string_lossy().to_string(),
            ok: false,
            error: Some("Project folder not found or is not a directory".to_string()),
            has_claude_md: false,
            has_agents_md: false,
            optimizations: vec![],
            applied_count: 0,
        };
    }

    let has_claude_md = file_exists(&claude_md_path(resolved));
    let has_agents_md = file_exists(&agents_md_path(resolved));

    let karpathy = detect_karpathy(resolved);
    let memory = detect_project_memory(resolved);

    let optimizations = vec![
        HarnessOptimization {
            id: "karpathy-guidelines".to_string(),
            name: "Karpathy guidelines".to_string(),
            description: "Think before coding, simplicity first, surgical changes, goal-driven execution — reduces wrong assumptions and overengineered diffs.".to_string(),
            source_label: "andrej-karpathy-skills".to_string(),
            source_url: KARPATHY_SOURCE_URL.to_string(),
            applied: karpathy.0,
            details: karpathy.1,
        },
        HarnessOptimization {
            id: "project-memory".to_string(),
            name: "Project memory + arc42".to_string(),
            description: "Sharded git-synced team memory (INDEX + topics + journal), arc42 architecture scaffold, Claude /remember and /memory-promote commands. Avoids one growing MEMORY.md.".to_string(),
            source_label: "arc42 · team memory".to_string(),
            source_url: MEMORY_SOURCE_URL.to_string(),
            applied: memory.0,
            details: memory.1,
        },
    ];

    let applied_count = optimizations.iter().filter(|o| o.applied).count();

    ProjectHarness {
        project: project_name.map(|s| s.to_string()).unwrap_or_else(|| {
            resolved
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        }),
        cwd: resolved.to_string_lossy().to_string(),
        ok: true,
        error: None,
        has_claude_md,
        has_agents_md,
        optimizations,
        applied_count,
    }
}

pub fn apply_project_harness(
    cwd: &str,
    optimization_id: &str,
    project_name: Option<&str>,
) -> ApplyHarnessResult {
    let status = get_project_harness(cwd, project_name);
    if !status.ok {
        return ApplyHarnessResult::failure(
            status
                .error
                .unwrap_or_else(|| "Invalid project".to_string()),
        );
    }

    if optimization_id != "karpathy-guidelines" && optimization_id != "project-memory" {
        return ApplyHarnessResult::failure(format!("Unknown optimization: {}", optimization_id));
    }

    let root = Path::new(&status.cwd);
    let mut written = Vec::new();

    if optimization_id == "karpathy-guidelines" {
        if let Err(e) = apply_karpathy(root, &mut written) {
            return ApplyHarnessResult::failure(e);
        }
    } else {
        if let Err(e) = apply_project_memory(root, &mut written) {
            return ApplyHarnessResult::failure(e);
        }
    }

    let harness = get_project_harness(cwd, project_name);
    ApplyHarnessResult::success(harness, written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_karpathy_harness() {
        let dir = tempdir().unwrap();
        let path = dir.path().to_str().unwrap().to_string();

        let status = get_project_harness(&path, Some("TestProject"));
        assert!(!status.optimizations[0].applied);

        let res = apply_project_harness(&path, "karpathy-guidelines", Some("TestProject"));
        assert!(res.ok);

        let status2 = get_project_harness(&path, Some("TestProject"));
        assert!(status2.optimizations[0].applied);
        assert!(status2.has_agents_md);
        assert!(status2.has_claude_md);
    }

    #[test]
    fn test_memory_harness() {
        let dir = tempdir().unwrap();
        let path = dir.path().to_str().unwrap().to_string();

        let status = get_project_harness(&path, Some("TestProject"));
        assert!(!status.optimizations[1].applied);

        let res = apply_project_harness(&path, "project-memory", Some("TestProject"));
        assert!(res.ok);

        let status2 = get_project_harness(&path, Some("TestProject"));
        assert!(status2.optimizations[1].applied);
        assert!(status2.has_claude_md);
    }

    #[cfg(unix)]
    #[test]
    fn replaces_legacy_skill_copy_and_reapply_is_idempotent() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let legacy = claude_skill_dir(root);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("SKILL.md"), "duplicate").unwrap();

        let first = apply_project_harness(root.to_str().unwrap(), "karpathy-guidelines", None);
        assert!(first.ok);
        assert!(fs::symlink_metadata(&legacy).unwrap().is_symlink());

        let second = apply_project_harness(root.to_str().unwrap(), "karpathy-guidelines", None);
        assert!(second.ok);
        assert_eq!(second.written, Some(Vec::new()));
    }
}
