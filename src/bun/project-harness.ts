/**
 * Project AI Harness — per-project agent optimizations
 * (AGENTS.md, CLAUDE.md, skills, sharded memory, arc42, …).
 *
 * - Karpathy guidelines: https://github.com/multica-ai/andrej-karpathy-skills
 * - Project memory + arc42: git-synced INDEX/topics/journal + architecture docs
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type HarnessOptimizationId =
  | "karpathy-guidelines"
  | "project-memory";

export type HarnessOptimization = {
  id: HarnessOptimizationId;
  name: string;
  description: string;
  /** Short label for the source / inspiration. */
  sourceLabel: string;
  sourceUrl: string;
  applied: boolean;
  /** Human-readable where it was detected or applied. */
  details: string | null;
};

export type ProjectHarness = {
  project: string;
  cwd: string;
  /** True when the cwd exists and is a directory. */
  ok: boolean;
  error?: string;
  hasClaudeMd: boolean;
  hasAgentsMd: boolean;
  optimizations: HarnessOptimization[];
  /** Count of applied optimizations. */
  appliedCount: number;
};

export type ApplyHarnessResult =
  | {
      ok: true;
      harness: ProjectHarness;
      /** Files written/updated this apply. */
      written: string[];
    }
  | { ok: false; error: string };

const KARPATHY_SOURCE_URL =
  "https://github.com/multica-ai/andrej-karpathy-skills";

const MEMORY_SOURCE_URL = "https://arc42.org/";

/** Distinctive markers used to detect already-applied guidelines. */
const KARPATHY_MARKERS = [
  "## 1. Think Before Coding",
  "## 2. Simplicity First",
  "## 3. Surgical Changes",
  "## 4. Goal-Driven Execution",
] as const;

/** Claude Code import pointer — full guidelines live in AGENTS.md. */
export const CLAUDE_MD_AGENTS_REF = "@AGENTS.md";

/** Claude Code import for always-on team memory catalog. */
export const CLAUDE_MD_MEMORY_REF = "@docs/memory/INDEX.md";

const MEMORY_INDEX_MARKER = "# Project memory index";
const ARCH_README_MARKER = "# Architecture documentation (arc42)";

/**
 * Canonical AGENTS.md body from andrej-karpathy-skills (embedded for offline apply).
 * Keep in sync with https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/main/CLAUDE.md
 */
export const KARPATHY_AGENTS_MD = `# AGENTS.md

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
\`\`\`
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
\`\`\`

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
`;

/**
 * Skill package for agents that load project skills from .agents/skills.
 * Derived from skills/karpathy-guidelines/SKILL.md in the upstream repo.
 */
export const KARPATHY_SKILL_MD = `---
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
\`\`\`
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
\`\`\`

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
`;

export function containsKarpathyGuidelines(text: string): boolean {
  return KARPATHY_MARKERS.every((m) => text.includes(m));
}

/** True when CLAUDE.md already points at AGENTS.md. */
export function containsAgentsMdRef(text: string): boolean {
  return /@AGENTS\.md\b/i.test(text);
}

/** True when CLAUDE.md imports the sharded memory index. */
export function containsMemoryIndexRef(text: string): boolean {
  return /@docs\/memory\/INDEX\.md\b/i.test(text);
}

// ── Project memory + arc42 templates (generic; not TR-specific prose) ─────

export const MEMORY_INDEX_MD = `${MEMORY_INDEX_MARKER}

> **Budget:** keep this file under ~1500 characters.
> **Always loaded** via \`CLAUDE.md\`. Put detail in \`topics/\` or \`journal/\`, not here.

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

Raw session lessons: [journal/](./journal/) (\`YYYY-MM.md\`).
**Not** imported into the default prompt. Promote into topics, then trim.

## Rules

1. Team-shared only — no personal prefs, no secrets.
2. One concern per topic file; compact instead of endless append.
3. Procedures → \`.claude/skills/\`, not memory essays.
4. Architecture changes → \`docs/architecture/\` (arc42) + ADR; link from here if needed.
`;

const TOPIC_CONVENTIONS_MD = `# Conventions

> Soft cap ~2–4k chars. Durable team conventions only.

## Agent guidelines

- Prefer repo \`AGENTS.md\` for coding behavior rules.
- Do not duplicate long guideline text here.

## Git / PR

- Review \`docs/memory/**\` and \`docs/architecture/**\` like code.
- Prefer topic-scoped memory edits over bloating \`INDEX.md\`.
- Never commit secrets or credentials.
`;

const TOPIC_TOOLING_MD = `# Tooling

> Soft cap ~2–4k chars. Env, commands, and agent tooling quirks.

## Commands

- Document install, test, and run commands the team actually uses.

## Paths

| Path | Role |
| --- | --- |
| \`docs/memory/\` | Team-shared memory (git) |
| \`docs/architecture/\` | arc42 architecture (git) |
| \`.claude/\` | Claude Code commands, skills, example hooks |
`;

const TOPIC_DOMAIN_MD = `# Domain

> Soft cap ~2–4k chars. Product/domain facts agents need often.

## Product

- (What this project is, in 2–4 bullets.)

## Core concepts

| Concept | Meaning |
| --- | --- |
| (term) | (short definition) |

## Architecture pointer

Full design: \`docs/architecture/\` (arc42). Prefer ADRs over copying decisions into memory.
`;

const TOPIC_INCIDENTS_MD = `# Incidents / gotchas

> Soft cap ~2–4k chars. Recurring failures and fixes.

## Template

\`\`\`markdown
### Short title (YYYY-MM)
- Symptom:
- Cause:
- Fix / avoid:
\`\`\`

## Known

_(none yet)_
`;

const JOURNAL_README_MD = `# Memory journal

Append-only (by month) capture of session lessons. **Not** imported into \`CLAUDE.md\`.

## How to use

1. Add notes to \`YYYY-MM.md\` (create for the current month if missing).
2. Run \`/memory-promote\` (or manually) to move durable facts into \`docs/memory/topics/\`.
3. Delete or mark promoted lines so the journal stays a scratchpad.

## Format

\`\`\`markdown
## YYYY-MM-DD — short title
- Context:
- Lesson:
- Promote to: topics/<file>.md | skill | arc42 | discard
\`\`\`
`;

const ARCH_README_MD = `${ARCH_README_MARKER}

Canonical architecture for this project. Agents and humans read here for “how the system is built”; use \`docs/memory/\` for short team lessons only.

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
| Memory index | \`docs/memory/INDEX.md\` |
| Memory topics | \`docs/memory/topics/\` |
| Agent behavior | \`AGENTS.md\` |

Fill sections as the system grows. Prefer a new ADR over silent redesign.
`;

const ARCH_INTRO_MD = `# 1. Introduction and goals

## 1.1 Summary

_(One paragraph: what this system is.)_

## 1.2 Quality goals

1. _(highest priority quality)_
2. _
3. _

## 1.3 Scope

**In scope:** …

**Out of scope:** …
`;

const ARCH_ADR_README_MD = `# 9. Architecture decisions (ADRs)

| ID | Title | Status |
| --- | --- | --- |
| _(add ADRs as decisions land)_ | | |

## ADR format

Each ADR records: context, decision, consequences, and alternatives considered.
`;

const REMEMBER_COMMAND_MD = `---
description: Capture a team lesson into project memory journal (not INDEX)
---

Capture durable **team** knowledge from this conversation into project memory.

## Rules

1. Write under \`docs/memory/\` only — never secrets or personal prefs.
2. Default: append to \`docs/memory/journal/YYYY-MM.md\` (current month; create if needed).
3. Do **not** dump long text into \`docs/memory/INDEX.md\` (keep INDEX small).
4. If the user names a topic and the fact is already curated, you may add a short bullet to the matching \`docs/memory/topics/*.md\` file instead.
5. If this is a procedure (multi-step how-to), prefer a skill under \`.claude/skills/\` over memory prose.
6. If this is an architecture decision, add/update an ADR under \`docs/architecture/09-architecture-decisions/\` and only link from memory.

## Journal entry format

\`\`\`markdown
## YYYY-MM-DD — short title
- Context:
- Lesson:
- Promote to: topics/<file>.md | skill | arc42 | discard
\`\`\`

## After writing

- Show the user the path and a one-line summary.
- Mention they can run \`/memory-promote\` later to move journal → topics.
`;

const MEMORY_PROMOTE_COMMAND_MD = `---
description: Promote journal lessons into topic memory files; keep INDEX small
---

Promote project memory from journal into curated topics.

## Steps

1. Read \`docs/memory/INDEX.md\` and note the character budget.
2. Read recent entries in \`docs/memory/journal/\` (current and previous month).
3. For each entry, decide: **topic** | **skill** | **arc42** | **discard**.
4. Apply edits surgically (small bullets, stable headings).
5. Update \`INDEX.md\` only for new topic rows or true hot facts — never paste full topics.
6. Remove or mark journal lines as promoted.
7. Summarize what moved; warn if INDEX (~1500 chars) or a topic (~2–4k) is over budget.

## Do not

- Merge everything into one MEMORY.md
- Put secrets in any memory file
- Duplicate AGENTS.md or full arc42 sections into topics
`;

const CLAUDE_SETTINGS_EXAMPLE = `{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo \\"[project memory] If this session taught a team-durable lesson, run /remember (journal) or /memory-promote. Do not grow docs/memory/INDEX.md with long dumps. Architecture → docs/architecture/.\\""
          }
        ]
      }
    ]
  }
}
`;

const CLAUDE_MD_MEMORY_BODY = `# Architecture

Canonical architecture: \`docs/architecture/\` (arc42).
Read relevant sections before large structural changes.
Record decisions as ADRs under \`docs/architecture/09-architecture-decisions/\`.

# Memory

Team memory: \`docs/memory/\` (git-synced).

- **Always loaded:** \`docs/memory/INDEX.md\` only (keep it small).
- **Durable facts:** \`docs/memory/topics/*.md\` — open when INDEX says so.
- **Raw capture:** \`docs/memory/journal/YYYY-MM.md\` — not always loaded.
- **Commands:** \`/remember\` (capture), \`/memory-promote\` (journal → topics).
- **No secrets** or personal prefs in shared memory.
- **Procedures** → skills under \`.claude/skills/\`, not long memory essays.

Optional Stop-hook reminder: copy from \`.claude/settings.example.json\` into project or user Claude settings if desired.
`;

/** Write only when missing or empty; returns relative path if written. */
function writeNewFile(
  absPath: string,
  content: string,
  relPath: string,
  written: string[],
): void {
  const existing = readText(absPath);
  if (existing != null && existing.trim().length > 0) return;
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  written.push(relPath);
}

/**
 * Ensure CLAUDE.md imports memory index and has short Architecture/Memory guidance.
 * Preserves existing body content.
 */
export function ensureClaudeMdMemory(claudePath: string): string[] {
  const written: string[] = [];
  const existing = readText(claudePath);
  if (!existing) {
    const body = `${CLAUDE_MD_AGENTS_REF}\n${CLAUDE_MD_MEMORY_REF}\n\n${CLAUDE_MD_MEMORY_BODY}`;
    mkdirSync(dirname(claudePath), { recursive: true });
    writeFileSync(claudePath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
    written.push("CLAUDE.md");
    return written;
  }

  let next = existing;
  let changed = false;

  if (!containsMemoryIndexRef(next)) {
    if (containsAgentsMdRef(next)) {
      // Insert memory import on the line after the first @AGENTS.md occurrence.
      next = next.replace(
        /^([^\n]*@AGENTS\.md[^\n]*\n)/m,
        `$1${CLAUDE_MD_MEMORY_REF}\n`,
      );
      if (!containsMemoryIndexRef(next)) {
        next = `${CLAUDE_MD_MEMORY_REF}\n${next}`;
      }
    } else {
      next = `${CLAUDE_MD_AGENTS_REF}\n${CLAUDE_MD_MEMORY_REF}\n${next.startsWith("\n") ? "" : "\n"}${next}`;
    }
    changed = true;
  } else if (!containsAgentsMdRef(next)) {
    next = `${CLAUDE_MD_AGENTS_REF}\n${next}`;
    changed = true;
  }

  if (!/^#\s*Memory\b/m.test(next) && !/\n#\s*Memory\b/m.test(next)) {
    const sep = next.endsWith("\n") ? "\n" : "\n\n";
    next = `${next}${sep}${CLAUDE_MD_MEMORY_BODY}`;
    changed = true;
  }

  if (changed) {
    writeFileSync(claudePath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
    written.push("CLAUDE.md");
  }
  return written;
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function readText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function agentsMdPath(cwd: string): string {
  return join(cwd, "AGENTS.md");
}

function claudeMdPath(cwd: string): string {
  return join(cwd, "CLAUDE.md");
}

const SKILL_ID = "karpathy-guidelines";

function agentsSkillDir(cwd: string): string {
  return join(cwd, ".agents", "skills", SKILL_ID);
}

function claudeSkillDir(cwd: string): string {
  return join(cwd, ".claude", "skills", SKILL_ID);
}

function isSkillPresent(skillDir: string): boolean {
  const skillMd = join(skillDir, "SKILL.md");
  const content = readText(skillMd);
  return !!(
    content &&
    (containsKarpathyGuidelines(content) ||
      content.includes(`name: ${SKILL_ID}`))
  );
}

/**
 * Point `.claude/skills/<id>` at the canonical `.agents/skills/<id>` tree.
 * Replaces a prior real copy (duplicate) with a symlink.
 */
export function ensureClaudeSkillSymlink(
  agentsDir: string,
  claudeDir: string,
): { ok: true; changed: boolean } | { ok: false; error: string } {
  try {
    mkdirSync(dirname(claudeDir), { recursive: true });
    const target = resolve(agentsDir);
    try {
      const st = lstatSync(claudeDir);
      if (st.isSymbolicLink()) {
        const current = resolve(dirname(claudeDir), readlinkSync(claudeDir));
        if (current === target) return { ok: true, changed: false };
        rmSync(claudeDir, { force: true, recursive: true });
      } else {
        // Real dir/file from an older install — remove so we don't keep a duplicate.
        rmSync(claudeDir, { force: true, recursive: true });
      }
    } catch {
      /* does not exist */
    }
    // Relative to the symlink's parent (`.claude/skills/`): up to project root.
    //   .claude/skills/karpathy-guidelines → ../../.agents/skills/karpathy-guidelines
    const rel = join("..", "..", ".agents", "skills", SKILL_ID);
    symlinkSync(rel, claudeDir);
    return { ok: true, changed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

function detectKarpathy(cwd: string): {
  applied: boolean;
  details: string | null;
} {
  const labels: string[] = [];
  /** True when guidelines content or skill package exists (not just a CLAUDE.md pointer). */
  let core = false;

  const agentsMd = readText(agentsMdPath(cwd));
  if (agentsMd && containsKarpathyGuidelines(agentsMd)) {
    labels.push("AGENTS.md");
    core = true;
  }

  const claudeMd = readText(claudeMdPath(cwd));
  if (claudeMd && containsKarpathyGuidelines(claudeMd)) {
    // Legacy: full guidelines were inlined into CLAUDE.md.
    labels.push("CLAUDE.md (legacy inline)");
    core = true;
  } else if (claudeMd && containsAgentsMdRef(claudeMd) && core) {
    labels.push("CLAUDE.md → @AGENTS.md");
  }

  const agentsDir = agentsSkillDir(cwd);
  const claudeDir = claudeSkillDir(cwd);
  if (isSkillPresent(agentsDir)) {
    labels.push(`.agents/skills/${SKILL_ID}`);
    core = true;
  }

  try {
    const st = lstatSync(claudeDir);
    if (st.isSymbolicLink() && isSkillPresent(claudeDir)) {
      labels.push(`.claude/skills/${SKILL_ID} → .agents`);
      core = true;
    } else if (isSkillPresent(claudeDir)) {
      // Standalone copy (legacy) — still counts as applied.
      labels.push(`.claude/skills/${SKILL_ID}`);
      core = true;
    }
  } catch {
    /* missing */
  }

  // Pointer alone is not "applied" (project-memory may add @AGENTS.md without guidelines).
  if (claudeMd && containsAgentsMdRef(claudeMd) && core && !labels.some((l) => l.startsWith("CLAUDE.md"))) {
    labels.push("CLAUDE.md → @AGENTS.md");
  }

  if (!core) {
    return { applied: false, details: null };
  }
  return { applied: true, details: labels.join(" · ") };
}

function memoryIndexPath(cwd: string): string {
  return join(cwd, "docs", "memory", "INDEX.md");
}

function detectProjectMemory(cwd: string): {
  applied: boolean;
  details: string | null;
} {
  const labels: string[] = [];

  const index = readText(memoryIndexPath(cwd));
  if (index && index.includes(MEMORY_INDEX_MARKER)) {
    labels.push("docs/memory/INDEX.md");
  }

  const claudeMd = readText(claudeMdPath(cwd));
  if (claudeMd && containsMemoryIndexRef(claudeMd)) {
    labels.push("CLAUDE.md → @docs/memory/INDEX.md");
  }

  if (fileExists(join(cwd, "docs", "memory", "topics", "conventions.md"))) {
    labels.push("topics/");
  }

  if (fileExists(join(cwd, ".claude", "commands", "remember.md"))) {
    labels.push(".claude/commands");
  }

  if (
    fileExists(join(cwd, "docs", "architecture", "README.md")) &&
    (readText(join(cwd, "docs", "architecture", "README.md")) || "").includes(
      ARCH_README_MARKER,
    )
  ) {
    labels.push("docs/architecture/");
  }

  if (labels.length === 0) {
    return { applied: false, details: null };
  }
  // Applied when the always-loaded index exists (core of the optimization).
  const applied = !!(index && index.includes(MEMORY_INDEX_MARKER));
  return { applied, details: labels.join(" · ") };
}

function applyKarpathy(root: string, written: string[]): { error?: string } {
  // 1) Full guidelines in AGENTS.md (shared agent instructions).
  const agentsPath = agentsMdPath(root);
  const existingAgents = readText(agentsPath);
  if (!existingAgents) {
    writeFileSync(agentsPath, KARPATHY_AGENTS_MD, "utf8");
    written.push("AGENTS.md");
  } else if (!containsKarpathyGuidelines(existingAgents)) {
    const sep = existingAgents.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(
      agentsPath,
      `${existingAgents}${sep}${KARPATHY_AGENTS_MD}`,
      "utf8",
    );
    written.push("AGENTS.md");
  }

  // 2) CLAUDE.md points at AGENTS.md (preserve any memory imports already present).
  const claudePath = claudeMdPath(root);
  const existingClaude = readText(claudePath);
  if (!existingClaude) {
    writeFileSync(claudePath, `${CLAUDE_MD_AGENTS_REF}\n`, "utf8");
    written.push("CLAUDE.md");
  } else if (!containsAgentsMdRef(existingClaude)) {
    writeFileSync(
      claudePath,
      `${CLAUDE_MD_AGENTS_REF}\n${existingClaude.startsWith("\n") ? "" : "\n"}${existingClaude}`,
      "utf8",
    );
    written.push("CLAUDE.md");
  }

  // 3) Canonical skill under .agents/skills; .claude/skills gets a symlink.
  const skillDir = agentsSkillDir(root);
  const skillMd = join(skillDir, "SKILL.md");
  mkdirSync(skillDir, { recursive: true });
  const priorSkill = readText(skillMd);
  if (!priorSkill || !containsKarpathyGuidelines(priorSkill)) {
    writeFileSync(skillMd, KARPATHY_SKILL_MD, "utf8");
    written.push(`.agents/skills/${SKILL_ID}/SKILL.md`);
  }

  const link = ensureClaudeSkillSymlink(skillDir, claudeSkillDir(root));
  if (!link.ok) {
    return { error: link.error };
  }
  if (link.changed) {
    written.push(`.claude/skills/${SKILL_ID} → .agents/skills/${SKILL_ID}`);
  }
  return {};
}

function applyProjectMemory(root: string, written: string[]): void {
  writeNewFile(
    memoryIndexPath(root),
    MEMORY_INDEX_MD,
    "docs/memory/INDEX.md",
    written,
  );
  writeNewFile(
    join(root, "docs", "memory", "topics", "conventions.md"),
    TOPIC_CONVENTIONS_MD,
    "docs/memory/topics/conventions.md",
    written,
  );
  writeNewFile(
    join(root, "docs", "memory", "topics", "tooling.md"),
    TOPIC_TOOLING_MD,
    "docs/memory/topics/tooling.md",
    written,
  );
  writeNewFile(
    join(root, "docs", "memory", "topics", "domain.md"),
    TOPIC_DOMAIN_MD,
    "docs/memory/topics/domain.md",
    written,
  );
  writeNewFile(
    join(root, "docs", "memory", "topics", "incidents.md"),
    TOPIC_INCIDENTS_MD,
    "docs/memory/topics/incidents.md",
    written,
  );
  writeNewFile(
    join(root, "docs", "memory", "journal", "README.md"),
    JOURNAL_README_MD,
    "docs/memory/journal/README.md",
    written,
  );

  writeNewFile(
    join(root, "docs", "architecture", "README.md"),
    ARCH_README_MD,
    "docs/architecture/README.md",
    written,
  );
  writeNewFile(
    join(root, "docs", "architecture", "01-introduction-and-goals.md"),
    ARCH_INTRO_MD,
    "docs/architecture/01-introduction-and-goals.md",
    written,
  );
  writeNewFile(
    join(
      root,
      "docs",
      "architecture",
      "09-architecture-decisions",
      "README.md",
    ),
    ARCH_ADR_README_MD,
    "docs/architecture/09-architecture-decisions/README.md",
    written,
  );

  writeNewFile(
    join(root, ".claude", "commands", "remember.md"),
    REMEMBER_COMMAND_MD,
    ".claude/commands/remember.md",
    written,
  );
  writeNewFile(
    join(root, ".claude", "commands", "memory-promote.md"),
    MEMORY_PROMOTE_COMMAND_MD,
    ".claude/commands/memory-promote.md",
    written,
  );
  writeNewFile(
    join(root, ".claude", "settings.example.json"),
    CLAUDE_SETTINGS_EXAMPLE,
    ".claude/settings.example.json",
    written,
  );

  for (const rel of ensureClaudeMdMemory(claudeMdPath(root))) {
    written.push(rel);
  }
}

/**
 * Inspect harness status for a project working directory.
 */
export function getProjectHarness(
  cwd: string,
  projectName?: string,
): ProjectHarness {
  const trimmed = (cwd || "").trim();
  if (!trimmed) {
    return {
      project: projectName || "unknown",
      cwd: "",
      ok: false,
      error: "No project path",
      hasClaudeMd: false,
      hasAgentsMd: false,
      optimizations: [],
      appliedCount: 0,
    };
  }

  const resolved = resolve(trimmed);
  if (!fileExists(resolved)) {
    return {
      project: projectName || basename(resolved),
      cwd: resolved,
      ok: false,
      error: "Project folder not found",
      hasClaudeMd: false,
      hasAgentsMd: false,
      optimizations: [],
      appliedCount: 0,
    };
  }

  const hasClaudeMd = fileExists(claudeMdPath(resolved));
  const hasAgentsMd = fileExists(agentsMdPath(resolved));

  const karpathy = detectKarpathy(resolved);
  const memory = detectProjectMemory(resolved);
  const optimizations: HarnessOptimization[] = [
    {
      id: "karpathy-guidelines",
      name: "Karpathy guidelines",
      description:
        "Think before coding, simplicity first, surgical changes, goal-driven execution — reduces wrong assumptions and overengineered diffs.",
      sourceLabel: "andrej-karpathy-skills",
      sourceUrl: KARPATHY_SOURCE_URL,
      applied: karpathy.applied,
      details: karpathy.details,
    },
    {
      id: "project-memory",
      name: "Project memory + arc42",
      description:
        "Sharded git-synced team memory (INDEX + topics + journal), arc42 architecture scaffold, Claude /remember and /memory-promote commands. Avoids one growing MEMORY.md.",
      sourceLabel: "arc42 · team memory",
      sourceUrl: MEMORY_SOURCE_URL,
      applied: memory.applied,
      details: memory.details,
    },
  ];

  return {
    project: projectName || basename(resolved),
    cwd: resolved,
    ok: true,
    hasClaudeMd,
    hasAgentsMd,
    optimizations,
    appliedCount: optimizations.filter((o) => o.applied).length,
  };
}

/**
 * Apply a harness optimization to the project.
 */
export function applyProjectHarness(
  cwd: string,
  optimizationId: string,
  projectName?: string,
): ApplyHarnessResult {
  const status = getProjectHarness(cwd, projectName);
  if (!status.ok) {
    return { ok: false, error: status.error || "Invalid project" };
  }

  if (
    optimizationId !== "karpathy-guidelines" &&
    optimizationId !== "project-memory"
  ) {
    return { ok: false, error: `Unknown optimization: ${optimizationId}` };
  }

  const root = status.cwd;
  const written: string[] = [];

  try {
    if (optimizationId === "karpathy-guidelines") {
      const err = applyKarpathy(root, written);
      if (err.error) return { ok: false, error: err.error };
    } else {
      applyProjectMemory(root, written);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  const harness = getProjectHarness(root, projectName || status.project);
  return { ok: true, harness, written };
}
