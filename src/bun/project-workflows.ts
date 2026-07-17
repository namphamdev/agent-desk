/**
 * Project-scoped workflow overrides (git-synced).
 *
 * File: `<project>/.terminal-react/workflows.json`
 * When the file exists and lists one or more workflows, that list fully
 * replaces global Settings / built-in workflows for New task in that project.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  normalizeWorkflowList,
  type WorkflowDefinition,
} from "../session/workflows";

export const PROJECT_WORKFLOWS_REL_PATH = ".terminal-react/workflows.json";

export type ProjectWorkflowsFile = {
  version: 1;
  workflows: WorkflowDefinition[];
};

export function projectWorkflowsPath(cwd: string): string {
  return join(resolve(cwd.trim()), PROJECT_WORKFLOWS_REL_PATH);
}

export type LoadProjectWorkflowsResult = {
  path: string;
  /** null when file missing or invalid / empty list. */
  workflows: WorkflowDefinition[] | null;
  exists: boolean;
};

export function loadProjectWorkflows(cwd: string): LoadProjectWorkflowsResult {
  const path = projectWorkflowsPath(cwd);
  if (!cwd.trim() || !existsSync(path)) {
    return { path, workflows: null, exists: false };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const list = Array.isArray(raw)
      ? normalizeWorkflowList(raw)
      : raw &&
          typeof raw === "object" &&
          Array.isArray((raw as ProjectWorkflowsFile).workflows)
        ? normalizeWorkflowList((raw as ProjectWorkflowsFile).workflows)
        : [];
    if (list.length === 0) {
      return { path, workflows: null, exists: true };
    }
    return { path, workflows: list, exists: true };
  } catch {
    return { path, workflows: null, exists: true };
  }
}

export type SaveProjectWorkflowsResult =
  | { ok: true; path: string; workflows: WorkflowDefinition[] | null }
  | { ok: false; error: string };

/**
 * Persist project workflows. Empty list removes the file so global/builtin
 * resolution is used again.
 */
export function saveProjectWorkflows(
  cwd: string,
  workflows: WorkflowDefinition[],
): SaveProjectWorkflowsResult {
  const folder = cwd.trim();
  if (!folder) {
    return { ok: false, error: "Project folder is required" };
  }
  const root = resolve(folder);
  if (!existsSync(root)) {
    return { ok: false, error: "Project folder does not exist" };
  }

  const path = projectWorkflowsPath(folder);
  const list = normalizeWorkflowList(workflows);

  try {
    if (list.length === 0) {
      if (existsSync(path)) {
        rmSync(path, { force: true });
      }
      return { ok: true, path, workflows: null };
    }

    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const payload: ProjectWorkflowsFile = { version: 1, workflows: list };
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { ok: true, path, workflows: list };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message || "Failed to save project workflows" };
  }
}
