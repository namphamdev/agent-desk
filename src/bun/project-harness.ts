/**
 * Project AI Harness — per-project agent optimizations (CLAUDE.md, skills, …).
 *
 * First optimization: Karpathy guidelines
 * https://github.com/multica-ai/andrej-karpathy-skills
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

export type HarnessOptimizationId = "karpathy-guidelines";

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

/** Distinctive markers used to detect already-applied guidelines. */
const KARPATHY_MARKERS = [
  "## 1. Think Before Coding",
  "## 2. Simplicity First",
  "## 3. Surgical Changes",
  "## 4. Goal-Driven Execution",
] as const;

/**
 * Canonical CLAUDE.md body from andrej-karpathy-skills (embedded for offline apply).
 * Keep in sync with https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/main/CLAUDE.md
 */
export const KARPATHY_CLAUDE_MD = `# CLAUDE.md

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

function claudeMdPaths(cwd: string): string[] {
  return [join(cwd, "CLAUDE.md"), join(cwd, ".claude", "CLAUDE.md")];
}

function findClaudeMd(cwd: string): { path: string; content: string } | null {
  for (const p of claudeMdPaths(cwd)) {
    const content = readText(p);
    if (content != null) return { path: p, content };
  }
  return null;
}

function skillDirCandidates(cwd: string): string[] {
  return [
    join(cwd, ".agents", "skills", "karpathy-guidelines"),
    join(cwd, ".claude", "skills", "karpathy-guidelines"),
  ];
}

function detectKarpathy(cwd: string): {
  applied: boolean;
  details: string | null;
} {
  const labels: string[] = [];
  const rootClaude = readText(join(cwd, "CLAUDE.md"));
  const nestedClaude = readText(join(cwd, ".claude", "CLAUDE.md"));
  if (rootClaude && containsKarpathyGuidelines(rootClaude)) {
    labels.push("CLAUDE.md");
  }
  if (nestedClaude && containsKarpathyGuidelines(nestedClaude)) {
    labels.push(".claude/CLAUDE.md");
  }

  for (const dir of skillDirCandidates(cwd)) {
    const skillMd = join(dir, "SKILL.md");
    const content = readText(skillMd);
    if (
      content &&
      (containsKarpathyGuidelines(content) ||
        content.includes("name: karpathy-guidelines"))
    ) {
      if (dir.includes(join(".agents", "skills"))) {
        labels.push(".agents/skills/karpathy-guidelines");
      } else {
        labels.push(".claude/skills/karpathy-guidelines");
      }
    }
  }

  if (labels.length === 0) {
    return { applied: false, details: null };
  }
  return { applied: true, details: labels.join(" · ") };
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

  const hasClaudeMd =
    fileExists(join(resolved, "CLAUDE.md")) ||
    fileExists(join(resolved, ".claude", "CLAUDE.md"));
  const hasAgentsMd =
    fileExists(join(resolved, "AGENTS.md")) ||
    fileExists(join(resolved, "Claude.md"));

  const karpathy = detectKarpathy(resolved);
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
 * Karpathy: write/append CLAUDE.md + install project skill under .agents/skills.
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

  if (optimizationId !== "karpathy-guidelines") {
    return { ok: false, error: `Unknown optimization: ${optimizationId}` };
  }

  const root = status.cwd;
  const written: string[] = [];

  try {
    // 1) CLAUDE.md at project root (Claude Code loads this via project settings).
    const claudePath = join(root, "CLAUDE.md");
    const existing = findClaudeMd(root);
    if (!existing) {
      writeFileSync(claudePath, KARPATHY_CLAUDE_MD, "utf8");
      written.push("CLAUDE.md");
    } else if (!containsKarpathyGuidelines(existing.content)) {
      const sep = existing.content.endsWith("\n") ? "\n" : "\n\n";
      const next = `${existing.content}${sep}${KARPATHY_CLAUDE_MD}`;
      writeFileSync(existing.path, next, "utf8");
      written.push(
        existing.path.includes(join(".claude", "CLAUDE.md"))
          ? ".claude/CLAUDE.md"
          : "CLAUDE.md",
      );
    }

    // 2) Project skill so agents that discover skills under .agents/skills also load it.
    const skillDir = join(root, ".agents", "skills", "karpathy-guidelines");
    const skillMd = join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    const priorSkill = readText(skillMd);
    if (!priorSkill || !containsKarpathyGuidelines(priorSkill)) {
      writeFileSync(skillMd, KARPATHY_SKILL_MD, "utf8");
      written.push(".agents/skills/karpathy-guidelines/SKILL.md");
    }

    // Mirror into .claude/skills for Claude Code skill discovery.
    const claudeSkillDir = join(
      root,
      ".claude",
      "skills",
      "karpathy-guidelines",
    );
    const claudeSkillMd = join(claudeSkillDir, "SKILL.md");
    mkdirSync(claudeSkillDir, { recursive: true });
    const priorClaudeSkill = readText(claudeSkillMd);
    if (!priorClaudeSkill || !containsKarpathyGuidelines(priorClaudeSkill)) {
      writeFileSync(claudeSkillMd, KARPATHY_SKILL_MD, "utf8");
      written.push(".claude/skills/karpathy-guidelines/SKILL.md");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  const harness = getProjectHarness(root, projectName || status.project);
  return { ok: true, harness, written };
}
