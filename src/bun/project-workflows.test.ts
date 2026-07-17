import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjectWorkflows,
  projectWorkflowsPath,
  saveProjectWorkflows,
} from "./project-workflows";

describe("project-workflows", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function tempProject() {
    const dir = mkdtempSync(join(tmpdir(), "tr-project-wf-"));
    dirs.push(dir);
    return dir;
  }

  it("returns null when file missing", () => {
    const cwd = tempProject();
    const r = loadProjectWorkflows(cwd);
    expect(r.exists).toBe(false);
    expect(r.workflows).toBeNull();
    expect(r.path).toBe(projectWorkflowsPath(cwd));
  });

  it("round-trips workflows and removes file when empty", () => {
    const cwd = tempProject();
    const save = saveProjectWorkflows(cwd, [
      {
        id: "custom",
        label: "Custom",
        description: "d",
        taskPlaceholder: "t",
        promptTemplate: "Hello {{task}}",
      },
    ]);
    expect(save.ok).toBe(true);
    if (!save.ok) return;

    const loaded = loadProjectWorkflows(cwd);
    expect(loaded.exists).toBe(true);
    expect(loaded.workflows?.[0]?.id).toBe("custom");
    expect(loaded.workflows?.[0]?.promptTemplate).toContain("{{task}}");

    const raw = JSON.parse(readFileSync(save.path, "utf8")) as {
      version: number;
      workflows: unknown[];
    };
    expect(raw.version).toBe(1);
    expect(raw.workflows).toHaveLength(1);

    const cleared = saveProjectWorkflows(cwd, []);
    expect(cleared.ok).toBe(true);
    expect(loadProjectWorkflows(cwd).workflows).toBeNull();
  });

  it("accepts a bare array on disk", () => {
    const cwd = tempProject();
    const path = projectWorkflowsPath(cwd);
    mkdirSync(join(cwd, ".terminal-react"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify([
        {
          id: "arr",
          label: "From array",
          promptTemplate: "{{task}}",
        },
      ]),
      "utf8",
    );
    const r = loadProjectWorkflows(cwd);
    expect(r.workflows?.[0]?.id).toBe("arr");
  });
});
