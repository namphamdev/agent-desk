/**
 * Task workflows for "New task" sessions.
 *
 * Each workflow produces a first-user-prompt that steers the agent to load the
 * right project harness docs (memory index, topics, architecture, AGENTS.md)
 * before doing the work.
 */

export type WorkflowId =
  | "new_feature"
  | "bug_fix"
  | "review_pr"
  | "explore_feature";

export type WorkflowDefinition = {
  id: WorkflowId;
  label: string;
  description: string;
  /** Placeholder for the task description field. */
  taskPlaceholder: string;
  /** When true, show an optional PR URL / number field. */
  needsPrRef?: boolean;
};

export const WORKFLOWS: readonly WorkflowDefinition[] = [
  {
    id: "new_feature",
    label: "New feature",
    description: "Plan and implement a feature with tests and surgical diffs",
    taskPlaceholder: "What should we build?",
  },
  {
    id: "bug_fix",
    label: "Bug fix",
    description: "Reproduce, fix surgically, and verify with a failing test",
    taskPlaceholder: "What is broken? Steps, expected vs actual…",
  },
  {
    id: "review_pr",
    label: "Review PR",
    description: "Review a pull request for correctness, security, and quality",
    taskPlaceholder: "What should the review focus on? (optional notes)",
    needsPrRef: true,
  },
  {
    id: "explore_feature",
    label: "Explore feature",
    description: "Map how something works — read-only unless you ask to edit",
    taskPlaceholder: "What area or feature should we explore?",
  },
] as const;

export function getWorkflow(id: WorkflowId): WorkflowDefinition {
  const found = WORKFLOWS.find((w) => w.id === id);
  if (!found) throw new Error(`Unknown workflow: ${id}`);
  return found;
}

export function workflowSessionTitle(
  id: WorkflowId,
  task: string,
  prRef?: string,
): string {
  const label = getWorkflow(id).label;
  if (id === "review_pr" && prRef?.trim()) {
    const ref = prRef.trim().replace(/\s+/g, " ").slice(0, 40);
    const note = task.replace(/\s+/g, " ").trim().slice(0, 32);
    return note ? `${label}: ${ref} — ${note}` : `${label}: ${ref}`;
  }
  const short = task.replace(/\s+/g, " ").trim().slice(0, 48);
  return short ? `${label}: ${short}` : label;
}

/** Shared harness / memory orientation every workflow starts with. */
export const WORKFLOW_HARNESS_PREAMBLE = [
  "This project may use the terminal-react / Claude Code harness layout.",
  "Before doing the task, orient yourself with project docs (skip any path that does not exist):",
  "",
  "1. `docs/memory/INDEX.md` — always start here; open only the topic files it points to.",
  "2. Relevant topics under `docs/memory/topics/` (conventions, domain, tooling, incidents).",
  "3. `AGENTS.md` / `CLAUDE.md` — behavioral guidelines (think first, simplicity, surgical changes, goal-driven checks).",
  "4. `docs/architecture/` (arc42) — for structural or cross-cutting changes; do not paste full design into memory.",
  "5. Project skills under `.claude/skills/` or `.agents/skills/` when a procedure matches the task.",
  "",
  "Rules: do not invent docs that are missing; do not bloat INDEX.md; no secrets in memory files.",
].join("\n");

export type BuildWorkflowPromptOpts = {
  /** User's task description / focus. */
  task: string;
  /** PR URL, number, or branch — for review_pr. */
  prRef?: string;
};

function taskBlock(task: string): string {
  const t = task.trim();
  if (!t) return "(No extra task notes — use the workflow goal and inspect the project.)";
  return t;
}

function newFeaturePrompt(task: string): string {
  return [
    WORKFLOW_HARNESS_PREAMBLE,
    "",
    "## Workflow: New feature",
    "",
    "### Task",
    taskBlock(task),
    "",
    "### How to work",
    "1. Read memory INDEX + `topics/conventions.md` and `topics/domain.md` when present.",
    "2. For non-trivial design, skim the relevant `docs/architecture/` sections (or ADRs).",
    "3. State assumptions and success criteria. If the request is ambiguous, ask before coding.",
    "4. Prefer the smallest change that fully solves the request — no speculative abstractions.",
    "5. Implement with tests where they prove the feature; match existing project style.",
    "6. Multi-step work: brief plan with verify checks (`step → verify`), then execute.",
    "",
    "Start by confirming what you loaded from the harness docs, then propose a short plan and implement.",
  ].join("\n");
}

function bugFixPrompt(task: string): string {
  return [
    WORKFLOW_HARNESS_PREAMBLE,
    "",
    "## Workflow: Bug fix",
    "",
    "### Bug report",
    taskBlock(task),
    "",
    "### How to work",
    "1. Read memory INDEX + `topics/incidents.md` (known gotchas) and `topics/domain.md` when present.",
    "2. Reproduce the bug. Prefer a failing test first when practical.",
    "3. Find the root cause — do not paper over symptoms.",
    "4. Apply a surgical fix only; do not refactor unrelated code.",
    "5. Verify: failing test/case now passes; no obvious regressions.",
    "6. If this is a recurring pitfall, suggest a short journal note for `docs/memory/journal/` (do not write secrets).",
    "",
    "Start by confirming harness context and how you will reproduce the bug, then fix it.",
  ].join("\n");
}

function reviewPrPrompt(task: string, prRef?: string): string {
  const target = prRef?.trim()
    ? prRef.trim()
    : "(No PR ref given — use `gh pr list` / current branch / ask the user.)";

  return [
    WORKFLOW_HARNESS_PREAMBLE,
    "",
    "## Workflow: Review PR",
    "",
    "### Pull request",
    target,
    "",
    "### Review focus",
    taskBlock(task),
    "",
    "### How to work",
    "1. Read memory INDEX + `topics/conventions.md` (PR/git norms) when present.",
    "2. Load the PR: prefer `gh pr view` / `gh pr diff` / `gh pr checks` when available; else git fetch + diff against the base branch.",
    "3. Review for:",
    "   - Correctness — logic bugs, edge cases, broken contracts",
    "   - Security — injection, secrets, unsafe paths or permissions",
    "   - Regressions — unintended side effects",
    "   - Tests — missing or weak coverage",
    "   - Code quality — clarity, maintainability, unnecessary complexity",
    "   - Docs/memory — knowledge file changes reviewed like code",
    "4. For each finding: severity (blocker / major / minor / nit), file location, what's wrong, concrete fix suggestion.",
    "5. End with an overall assessment (approve / request changes / needs discussion).",
    "6. Do **not** implement fixes unless the user explicitly asks.",
    "",
    "Start by identifying the PR diff scope, then produce the structured review.",
  ].join("\n");
}

function exploreFeaturePrompt(task: string): string {
  return [
    WORKFLOW_HARNESS_PREAMBLE,
    "",
    "## Workflow: Explore feature",
    "",
    "### Explore",
    taskBlock(task),
    "",
    "### How to work",
    "1. Read memory INDEX + `topics/domain.md` (and other topics INDEX suggests).",
    "2. Check `docs/architecture/` for building-block / runtime notes if the area is structural.",
    "3. Trace the code paths: entry points, key modules, data flow, and tests.",
    "4. Produce a clear map: how it works, important files, extension points, risks/gotchas.",
    "5. Stay **read-only** — do not edit files, run destructive commands, or refactor unless the user asks.",
    "",
    "Start by loading harness context, then explore and report findings.",
  ].join("\n");
}

/** Build the first user prompt for a workflow-backed session. */
export function buildWorkflowPrompt(
  id: WorkflowId,
  opts: BuildWorkflowPromptOpts,
): string {
  const task = opts.task ?? "";
  switch (id) {
    case "new_feature":
      return newFeaturePrompt(task);
    case "bug_fix":
      return bugFixPrompt(task);
    case "review_pr":
      return reviewPrPrompt(task, opts.prRef);
    case "explore_feature":
      return exploreFeaturePrompt(task);
    default: {
      const _exhaustive: never = id;
      throw new Error(`Unknown workflow: ${_exhaustive}`);
    }
  }
}
