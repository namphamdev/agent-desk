import { describe, expect, it } from "vitest";
import {
  BUILTIN_WORKFLOWS,
  BUILTIN_WORKFLOW_IDS,
  WORKFLOW_HARNESS_PREAMBLE,
  buildWorkflowPrompt,
  getWorkflow,
  normalizeWorkflowList,
  resolveWorkflows,
  workflowSessionTitle,
  type WorkflowDefinition,
} from "./workflows";

describe("BUILTIN_WORKFLOWS", () => {
  it("defines the four task workflows", () => {
    expect(BUILTIN_WORKFLOWS.map((w) => w.id)).toEqual([...BUILTIN_WORKFLOW_IDS]);
  });

  it("marks review_pr as needing a PR ref field", () => {
    expect(getWorkflow("review_pr").needsPrRef).toBe(true);
    expect(getWorkflow("new_feature").needsPrRef).toBeUndefined();
  });

  it("includes prompt templates for every built-in", () => {
    for (const w of BUILTIN_WORKFLOWS) {
      expect(w.promptTemplate.trim().length).toBeGreaterThan(20);
      expect(w.promptTemplate).toContain("{{task}}");
    }
    expect(getWorkflow("review_pr").promptTemplate).toContain("{{prRef}}");
  });
});

describe("normalizeWorkflowList", () => {
  it("drops invalid rows and de-dupes ids", () => {
    const list = normalizeWorkflowList([
      { label: "A", promptTemplate: "hi {{task}}" },
      { id: "a", label: "B", promptTemplate: "bye {{task}}" },
      { label: "", promptTemplate: "x" },
      null,
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe("a");
    expect(list[1]?.id).toBe("a_2");
  });
});

describe("resolveWorkflows", () => {
  it("uses project list when non-empty (replaces global)", () => {
    const project: WorkflowDefinition[] = [
      {
        id: "only_proj",
        label: "Project only",
        description: "",
        taskPlaceholder: "x",
        promptTemplate: "P {{task}}",
      },
    ];
    const global: WorkflowDefinition[] = [
      {
        id: "global",
        label: "Global",
        description: "",
        taskPlaceholder: "x",
        promptTemplate: "G {{task}}",
      },
    ];
    const r = resolveWorkflows({ project, global });
    expect(r.source).toBe("project");
    expect(r.workflows.map((w) => w.id)).toEqual(["only_proj"]);
  });

  it("uses global when project empty", () => {
    const global: WorkflowDefinition[] = [
      {
        id: "g1",
        label: "G",
        description: "",
        taskPlaceholder: "t",
        promptTemplate: "{{task}}",
      },
    ];
    const r = resolveWorkflows({ project: [], global });
    expect(r.source).toBe("global");
    expect(r.workflows[0]?.id).toBe("g1");
  });

  it("falls back to built-ins", () => {
    const r = resolveWorkflows({});
    expect(r.source).toBe("builtin");
    expect(r.workflows.map((w) => w.id)).toEqual([...BUILTIN_WORKFLOW_IDS]);
  });
});

describe("workflowSessionTitle", () => {
  it("prefixes label and truncates long tasks", () => {
    const long = "a".repeat(80);
    const title = workflowSessionTitle("bug_fix", long);
    expect(title.startsWith("Bug fix: ")).toBe(true);
    expect(title.length).toBeLessThan(80);
  });

  it("uses PR ref for review titles", () => {
    expect(workflowSessionTitle("review_pr", "focus security", "#42")).toBe(
      "Review PR: #42 — focus security",
    );
    expect(workflowSessionTitle("review_pr", "", "https://example/pr/7")).toBe(
      "Review PR: https://example/pr/7",
    );
  });

  it("falls back to label when task empty", () => {
    expect(workflowSessionTitle("explore_feature", "  ")).toBe(
      "Explore feature",
    );
  });
});

describe("buildWorkflowPrompt", () => {
  it("includes harness preamble and task for every built-in", () => {
    for (const w of BUILTIN_WORKFLOWS) {
      const prompt = buildWorkflowPrompt(w.id, {
        task: "Ship dark mode",
        prRef: w.id === "review_pr" ? "#99" : undefined,
      });
      expect(prompt).toContain(WORKFLOW_HARNESS_PREAMBLE.slice(0, 40));
      expect(prompt).toContain("docs/memory/INDEX.md");
      expect(prompt).toContain("AGENTS.md");
      if (w.id === "review_pr") {
        expect(prompt).toContain("#99");
      } else {
        expect(prompt).toContain("Ship dark mode");
      }
    }
  });

  it("new feature emphasizes plan and minimal change", () => {
    const p = buildWorkflowPrompt("new_feature", { task: "Add export CSV" });
    expect(p).toContain("Workflow: New feature");
    expect(p.toLowerCase()).toContain("success criteria");
    expect(p.toLowerCase()).toContain("smallest change");
  });

  it("bug fix emphasizes reproduce and incidents topic", () => {
    const p = buildWorkflowPrompt("bug_fix", { task: "Crash on save" });
    expect(p).toContain("Workflow: Bug fix");
    expect(p).toContain("incidents.md");
    expect(p.toLowerCase()).toContain("failing test");
  });

  it("review PR is non-implementing and structured", () => {
    const p = buildWorkflowPrompt("review_pr", {
      task: "Auth changes",
      prRef: "https://github.com/org/repo/pull/12",
    });
    expect(p).toContain("Workflow: Review PR");
    expect(p).toContain("https://github.com/org/repo/pull/12");
    expect(p.toLowerCase()).toContain("do **not** implement");
    expect(p.toLowerCase()).toContain("severity");
  });

  it("explore stays read-only", () => {
    const p = buildWorkflowPrompt("explore_feature", {
      task: "How does harness apply work?",
    });
    expect(p).toContain("Workflow: Explore feature");
    expect(p.toLowerCase()).toContain("read-only");
    expect(p).toContain("domain.md");
  });

  it("handles empty task without crashing", () => {
    const p = buildWorkflowPrompt("new_feature", { task: "" });
    expect(p).toContain("No extra task notes");
  });

  it("skips preamble when disabled", () => {
    const w: WorkflowDefinition = {
      id: "plain",
      label: "Plain",
      description: "",
      taskPlaceholder: "t",
      includeHarnessPreamble: false,
      promptTemplate: "Only {{task}}",
    };
    const p = buildWorkflowPrompt(w, { task: "x" });
    expect(p).toBe("Only x");
    expect(p).not.toContain("docs/memory/INDEX.md");
  });

  it("builds from a custom definition without list lookup", () => {
    const w: WorkflowDefinition = {
      id: "ship",
      label: "Ship",
      description: "",
      taskPlaceholder: "t",
      promptTemplate: "Ship it: {{task}}",
    };
    expect(buildWorkflowPrompt(w, { task: "v1" })).toContain("Ship it: v1");
  });
});
