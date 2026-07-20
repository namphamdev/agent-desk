/**
 * Task workflows for "New task" sessions.
 *
 * Built-ins ship with harness-aware prompt templates. Users can override the
 * global list in Settings, and projects can replace that list with a
 * git-synced `.terminal-react/workflows.json` file.
 */

export type WorkflowDefinition = {
  /** Stable id (built-in slug or custom). */
  id: string;
  label: string;
  description: string;
  /** Placeholder for the task description field. */
  taskPlaceholder: string;
  /** When true, show an optional PR URL / number field. */
  needsPrRef?: boolean;
  /**
   * When true (default), prepend {@link WORKFLOW_HARNESS_PREAMBLE} before the
   * prompt template.
   */
  includeHarnessPreamble?: boolean;
  /**
   * Prompt body. Placeholders: `{{task}}`, `{{prRef}}`.
   * Empty task/prRef are filled with friendly fallbacks at build time.
   */
  promptTemplate: string;
};

/** @deprecated Prefer string ids; kept for call-site clarity. */
export type WorkflowId = string;

/** Built-in workflow ids (still the default list when no overrides exist). */
export const BUILTIN_WORKFLOW_IDS = [
  "new_feature",
  "bug_fix",
  "review_pr",
  "explore_feature",
] as const;

export type BuiltinWorkflowId = (typeof BUILTIN_WORKFLOW_IDS)[number];

/** Shared harness / memory orientation every default workflow starts with. */
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

const EMPTY_TASK =
  "(No extra task notes — use the workflow goal and inspect the project.)";

const EMPTY_PR_REF =
  "(No PR ref given — use `gh pr list` / current branch / ask the user.)";

const NEW_FEATURE_TEMPLATE = [
  "## Workflow: New feature",
  "",
  "### Task",
  "{{task}}",
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

const BUG_FIX_TEMPLATE = [
  "## Workflow: Bug fix",
  "",
  "### Bug report",
  "{{task}}",
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

const REVIEW_PR_TEMPLATE = [
  "## Workflow: Review PR",
  "",
  "### Pull request",
  "{{prRef}}",
  "",
  "### Review focus",
  "{{task}}",
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

const EXPLORE_FEATURE_TEMPLATE = [
  "## Workflow: Explore feature",
  "",
  "### Explore",
  "{{task}}",
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

/** Canonical built-in workflows (prompt templates included). */
export const BUILTIN_WORKFLOWS: readonly WorkflowDefinition[] = [
  {
    id: "new_feature",
    label: "New feature",
    description: "Plan and implement a feature with tests and surgical diffs",
    taskPlaceholder: "What should we build?",
    includeHarnessPreamble: true,
    promptTemplate: NEW_FEATURE_TEMPLATE,
  },
  {
    id: "bug_fix",
    label: "Bug fix",
    description: "Reproduce, fix surgically, and verify with a failing test",
    taskPlaceholder: "What is broken? Steps, expected vs actual…",
    includeHarnessPreamble: true,
    promptTemplate: BUG_FIX_TEMPLATE,
  },
  {
    id: "review_pr",
    label: "Review PR",
    description: "Review a pull request for correctness, security, and quality",
    taskPlaceholder: "What should the review focus on? (optional notes)",
    needsPrRef: true,
    includeHarnessPreamble: true,
    promptTemplate: REVIEW_PR_TEMPLATE,
  },
  {
    id: "explore_feature",
    label: "Explore feature",
    description: "Map how something works — read-only unless you ask to edit",
    taskPlaceholder: "What area or feature should we explore?",
    includeHarnessPreamble: true,
    promptTemplate: EXPLORE_FEATURE_TEMPLATE,
  },
] as const;

/** @deprecated Use {@link BUILTIN_WORKFLOWS} or {@link resolveWorkflows}. */
export const WORKFLOWS = BUILTIN_WORKFLOWS;

function slugifyId(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return s || "workflow";
}

/** Normalize a partially-defined workflow from settings or disk. */
export function normalizeWorkflowDefinition(
  raw: unknown,
  index = 0,
): WorkflowDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label =
    typeof o.label === "string" && o.label.trim()
      ? o.label.trim()
      : typeof o.name === "string" && o.name.trim()
        ? o.name.trim()
        : "";
  const promptTemplate =
    typeof o.promptTemplate === "string"
      ? o.promptTemplate
      : typeof o.template === "string"
        ? o.template
        : "";
  if (!label || !promptTemplate.trim()) return null;

  const idRaw =
    typeof o.id === "string" && o.id.trim() ? o.id.trim() : slugifyId(label);
  const id = slugifyId(idRaw) || `workflow_${index + 1}`;

  return {
    id,
    label,
    description:
      typeof o.description === "string" ? o.description.trim() : "",
    taskPlaceholder:
      typeof o.taskPlaceholder === "string" && o.taskPlaceholder.trim()
        ? o.taskPlaceholder.trim()
        : "Describe the task…",
    needsPrRef: o.needsPrRef === true ? true : undefined,
    includeHarnessPreamble:
      o.includeHarnessPreamble === false ? false : true,
    promptTemplate,
  };
}

/** Normalize a list; drop invalid rows; ensure unique ids (suffix on clash). */
export function normalizeWorkflowList(
  raw: unknown,
): WorkflowDefinition[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkflowDefinition[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const w = normalizeWorkflowDefinition(item, i);
    if (!w) return;
    let id = w.id;
    let n = 2;
    while (seen.has(id)) {
      id = `${w.id}_${n++}`;
    }
    seen.add(id);
    out.push(id === w.id ? w : { ...w, id });
  });
  return out;
}

export type ResolveWorkflowsSource = "project" | "global" | "builtin";

export type ResolveWorkflowsResult = {
  workflows: WorkflowDefinition[];
  source: ResolveWorkflowsSource;
};

/**
 * Project list replaces global/builtin when non-empty.
 * Global list replaces built-ins when non-empty.
 * Empty / missing → fall through.
 */
export function resolveWorkflows(opts: {
  global?: WorkflowDefinition[] | null;
  project?: WorkflowDefinition[] | null;
}): ResolveWorkflowsResult {
  const project = normalizeWorkflowList(opts.project ?? []);
  if (project.length > 0) {
    return { workflows: project, source: "project" };
  }
  const global = normalizeWorkflowList(opts.global ?? []);
  if (global.length > 0) {
    return { workflows: global, source: "global" };
  }
  return {
    workflows: BUILTIN_WORKFLOWS.map((w) => ({ ...w })),
    source: "builtin",
  };
}

export function getWorkflow(
  id: string,
  list?: readonly WorkflowDefinition[],
): WorkflowDefinition {
  const pool = list ?? BUILTIN_WORKFLOWS;
  const found = pool.find((w) => w.id === id);
  if (!found) throw new Error(`Unknown workflow: ${id}`);
  return found;
}

export function workflowSessionTitle(
  workflowOrId: WorkflowDefinition | string,
  task: string,
  prRef?: string,
  list?: readonly WorkflowDefinition[],
): string {
  const workflow =
    typeof workflowOrId === "string"
      ? getWorkflow(workflowOrId, list)
      : workflowOrId;
  const label = workflow.label;
  if (workflow.needsPrRef && prRef?.trim()) {
    const ref = prRef.trim().replace(/\s+/g, " ").slice(0, 40);
    const note = task.replace(/\s+/g, " ").trim().slice(0, 32);
    return note ? `${label}: ${ref} — ${note}` : `${label}: ${ref}`;
  }
  const short = task.replace(/\s+/g, " ").trim().slice(0, 48);
  return short ? `${label}: ${short}` : label;
}

export type BuildWorkflowPromptOpts = {
  /** User's task description / focus. */
  task: string;
  /** PR URL, number, or branch — for workflows with needsPrRef. */
  prRef?: string;
};

function applyTemplate(
  template: string,
  opts: BuildWorkflowPromptOpts,
): string {
  const task = opts.task.trim() || EMPTY_TASK;
  const prRef = opts.prRef?.trim() || EMPTY_PR_REF;
  return template
    .split("{{task}}")
    .join(task)
    .split("{{prRef}}")
    .join(prRef);
}

/** Build the first user prompt for a workflow-backed session. */
export function buildWorkflowPrompt(
  workflowOrId: WorkflowDefinition | string,
  opts: BuildWorkflowPromptOpts,
  list?: readonly WorkflowDefinition[],
): string {
  const workflow =
    typeof workflowOrId === "string"
      ? getWorkflow(workflowOrId, list)
      : workflowOrId;
  const body = applyTemplate(workflow.promptTemplate, opts);
  if (workflow.includeHarnessPreamble === false) return body;
  return [WORKFLOW_HARNESS_PREAMBLE, "", body].join("\n");
}

/**
 * Free-chat body (no fixed task). Still tells the agent about the memory
 * system so open-ended sessions orient the same way as named workflows.
 */
export const FREE_CHAT_TEMPLATE = [
  "## Workflow: Free chat",
  "",
  "No fixed task template — the user will drive the conversation after this orientation.",
  "",
  "### How to work",
  "1. Read memory INDEX; open only the topic files it points to when relevant.",
  "2. Follow `AGENTS.md` / `CLAUDE.md` (think first, simplicity, surgical changes, goal-driven checks).",
  "3. Use the project memory system: durable facts in `docs/memory/topics/`, raw capture in `docs/memory/journal/`; do not bloat INDEX; no secrets.",
  "4. For structural questions, prefer `docs/architecture/` over inventing design.",
  "",
  "Confirm you loaded harness context briefly, then wait for the user's next message.",
].join("\n");

/** First prompt for Free chat sessions (harness + memory orientation). */
export function buildFreeChatPrompt(): string {
  return [WORKFLOW_HARNESS_PREAMBLE, "", FREE_CHAT_TEMPLATE].join("\n");
}

/** Create a blank custom workflow for the settings editor. */
export function createEmptyWorkflow(label = "Custom workflow"): WorkflowDefinition {
  const id = `custom_${Date.now().toString(36)}`;
  return {
    id,
    label,
    description: "",
    taskPlaceholder: "Describe the task…",
    includeHarnessPreamble: true,
    promptTemplate: [
      `## Workflow: ${label}`,
      "",
      "### Task",
      "{{task}}",
      "",
      "### How to work",
      "1. Orient with project docs if useful.",
      "2. Complete the task.",
      "",
      "Start by confirming context, then do the work.",
    ].join("\n"),
  };
}

/** Deep clone of built-ins for the settings "Reset to defaults" action. */
export function cloneBuiltinWorkflows(): WorkflowDefinition[] {
  return BUILTIN_WORKFLOWS.map((w) => ({ ...w }));
}
