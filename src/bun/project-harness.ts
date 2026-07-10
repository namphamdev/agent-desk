/**
 * Project AI Harness — per-project agent optimizations (AGENTS.md, CLAUDE.md, skills, …).
 *
 * First optimization: Karpathy guidelines
 * https://github.com/multica-ai/andrej-karpathy-skills
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

/** Claude Code import pointer — full guidelines live in AGENTS.md. */
export const CLAUDE_MD_AGENTS_REF = "@AGENTS.md";

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

  const agentsMd = readText(agentsMdPath(cwd));
  if (agentsMd && containsKarpathyGuidelines(agentsMd)) {
    labels.push("AGENTS.md");
  }

  const claudeMd = readText(claudeMdPath(cwd));
  if (claudeMd && containsAgentsMdRef(claudeMd)) {
    labels.push("CLAUDE.md → @AGENTS.md");
  } else if (claudeMd && containsKarpathyGuidelines(claudeMd)) {
    // Legacy: full guidelines were inlined into CLAUDE.md.
    labels.push("CLAUDE.md (legacy inline)");
  }

  const agentsDir = agentsSkillDir(cwd);
  const claudeDir = claudeSkillDir(cwd);
  if (isSkillPresent(agentsDir)) {
    labels.push(`.agents/skills/${SKILL_ID}`);
  }

  try {
    const st = lstatSync(claudeDir);
    if (st.isSymbolicLink() && isSkillPresent(claudeDir)) {
      labels.push(`.claude/skills/${SKILL_ID} → .agents`);
    } else if (isSkillPresent(claudeDir)) {
      // Standalone copy (legacy) — still counts as applied.
      labels.push(`.claude/skills/${SKILL_ID}`);
    }
  } catch {
    /* missing */
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

  const hasClaudeMd = fileExists(claudeMdPath(resolved));
  const hasAgentsMd = fileExists(agentsMdPath(resolved));

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
 * Karpathy: write/append AGENTS.md, ensure CLAUDE.md references @AGENTS.md,
 * install project skill under .agents/skills (+ symlink into .claude/skills).
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

    // 2) CLAUDE.md only points at AGENTS.md (Claude Code project memory).
    const claudePath = claudeMdPath(root);
    const existingClaude = readText(claudePath);
    if (!existingClaude) {
      writeFileSync(claudePath, `${CLAUDE_MD_AGENTS_REF}\n`, "utf8");
      written.push("CLAUDE.md");
    } else if (!containsAgentsMdRef(existingClaude)) {
      const sep = existingClaude.endsWith("\n") ? "" : "\n";
      // Prefer the import at the top so Claude loads AGENTS.md first.
      writeFileSync(
        claudePath,
        `${CLAUDE_MD_AGENTS_REF}\n${sep}${existingClaude}`,
        "utf8",
      );
      written.push("CLAUDE.md");
    }

    // 3) Canonical skill under .agents/skills; .claude/skills gets a symlink (no duplicate).
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
      return { ok: false, error: link.error };
    }
    if (link.changed) {
      written.push(`.claude/skills/${SKILL_ID} → .agents/skills/${SKILL_ID}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  const harness = getProjectHarness(root, projectName || status.project);
  return { ok: true, harness, written };
}
