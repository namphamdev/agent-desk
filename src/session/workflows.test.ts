import { describe, expect, it } from "vitest";
import {
  WORKFLOW_HARNESS_PREAMBLE,
  WORKFLOWS,
  buildWorkflowPrompt,
  getWorkflow,
  workflowSessionTitle,
  type WorkflowId,
} from "./workflows";

const ALL_IDS: WorkflowId[] = [
  "new_feature",
  "bug_fix",
  "review_pr",
  "explore_feature",
];

describe("WORKFLOWS", () => {
  it("defines the four task workflows", () => {
    expect(WORKFLOWS.map((w) => w.id)).toEqual(ALL_IDS);
  });

  it("marks review_pr as needing a PR ref field", () => {
    expect(getWorkflow("review_pr").needsPrRef).toBe(true);
    expect(getWorkflow("new_feature").needsPrRef).toBeUndefined();
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
  it("includes harness preamble and task for every workflow", () => {
    for (const id of ALL_IDS) {
      const prompt = buildWorkflowPrompt(id, {
        task: "Ship dark mode",
        prRef: id === "review_pr" ? "#99" : undefined,
      });
      expect(prompt).toContain(WORKFLOW_HARNESS_PREAMBLE.slice(0, 40));
      expect(prompt).toContain("docs/memory/INDEX.md");
      expect(prompt).toContain("AGENTS.md");
      if (id === "review_pr") {
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
});
