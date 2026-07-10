import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "./types";
import {
  DEFAULT_REVIEW_PROMPT,
  isMutatingToolCall,
  reviewSessionTitle,
  summarizeSessionChanges,
} from "./session-summary";

function userMsg(text: string, id = "u1"): TimelineEntry {
  return {
    id,
    type: "message",
    role: "user",
    content: [{ type: "text", text }],
  };
}

function agentMsg(text: string, id = "a1"): TimelineEntry {
  return {
    id,
    type: "message",
    role: "agent",
    content: [{ type: "text", text }],
  };
}

function editTool(
  path: string,
  oldText: string,
  newText: string,
  id = "t1",
): TimelineEntry {
  return {
    id,
    type: "tool_call",
    toolCall: {
      toolCallId: id,
      title: `Edit ${path}`,
      kind: "edit",
      status: "completed",
      locations: [{ path }],
      content: [{ type: "diff", path, oldText, newText }],
    },
  };
}

describe("summarizeSessionChanges", () => {
  it("reports no reviewable content for empty timeline", () => {
    const s = summarizeSessionChanges([]);
    expect(s.hasChanges).toBe(false);
    expect(s.hasReviewableContent).toBe(false);
    expect(s.fileCount).toBe(0);
  });

  it("collects user goals and file diffs", () => {
    const timeline: TimelineEntry[] = [
      userMsg("Add a review feature"),
      editTool(
        "src/session/session-summary.ts",
        "export const x = 1",
        "export const x = 2",
      ),
    ];
    const s = summarizeSessionChanges(timeline, {
      sessionTitle: "Feature work",
      project: "terminal-react",
    });
    expect(s.hasChanges).toBe(true);
    expect(s.hasReviewableContent).toBe(true);
    expect(s.fileCount).toBe(1);
    expect(s.userGoals[0]).toContain("Add a review feature");
    expect(s.text).toContain("Session work summary");
    expect(s.text).toContain("Feature work");
    expect(s.text).toContain("terminal-react");
    expect(s.text).toContain("session-summary.ts");
    expect(s.text).toContain("export const x = 2");
  });

  it("treats diff content as a change even without edit kind", () => {
    const timeline: TimelineEntry[] = [
      {
        id: "t",
        type: "tool_call",
        toolCall: {
          toolCallId: "t",
          title: "Write file",
          kind: "other",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "a.ts",
              oldText: null,
              newText: "const a = 1",
            },
          ],
        },
      },
    ];
    const s = summarizeSessionChanges(timeline);
    expect(s.hasChanges).toBe(true);
    expect(s.files[0]?.path).toBe("a.ts");
  });

  it("detects Write-style tools with rawInput and no ACP kind/diff", () => {
    const timeline: TimelineEntry[] = [
      {
        id: "w",
        type: "tool_call",
        toolCall: {
          toolCallId: "w",
          title: "Write src/foo.ts",
          kind: "other",
          status: "completed",
          content: [],
          rawInput: {
            file_path: "src/foo.ts",
            content: "export const foo = 1\n",
          },
        },
      },
    ];
    const s = summarizeSessionChanges(timeline);
    expect(s.hasChanges).toBe(true);
    expect(s.files[0]?.path).toBe("src/foo.ts");
    expect(s.text).toContain("export const foo = 1");
  });

  it("detects shell rm/mv as file mutations (common in history)", () => {
    const timeline: TimelineEntry[] = [
      userMsg("remove ./ui.html file"),
      {
        id: "e",
        type: "tool_call",
        toolCall: {
          toolCallId: "e",
          title: 'rm ./ui.html && ls ./ui.html 2>&1 || echo "ui.html removed"',
          kind: "execute",
          status: "completed",
          content: [],
          rawInput: {
            command: "rm ./ui.html",
            description: "Remove ui.html file",
          },
        },
      },
      agentMsg("Removed ./ui.html."),
    ];
    const s = summarizeSessionChanges(timeline);
    expect(s.hasChanges).toBe(true);
    expect(s.hasReviewableContent).toBe(true);
    expect(s.files.some((f) => f.kind === "delete" || f.path.includes("ui.html"))).toBe(
      true,
    );
  });

  it("allows review when there are goals/agent replies but no file edits", () => {
    const s = summarizeSessionChanges([
      userMsg("what is this project"),
      agentMsg("It is a coding agent UI."),
    ]);
    expect(s.hasChanges).toBe(false);
    expect(s.hasReviewableContent).toBe(true);
    expect(s.text).toContain("User goals");
    expect(s.text).toContain("Agent notes");
  });

  it("truncates long diffs", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const s = summarizeSessionChanges([editTool("big.ts", "", long)], {
      maxDiffLines: 10,
    });
    expect(s.text).toContain("truncated");
  });

  it("includes delete tools as file changes", () => {
    const timeline: TimelineEntry[] = [
      {
        id: "d",
        type: "tool_call",
        toolCall: {
          toolCallId: "d",
          title: "Delete tmp.ts",
          kind: "delete",
          status: "completed",
          locations: [{ path: "tmp.ts" }],
          content: [],
        },
      },
    ];
    const s = summarizeSessionChanges(timeline);
    expect(s.hasChanges).toBe(true);
    expect(s.files[0]?.kind).toBe("delete");
  });
});

describe("isMutatingToolCall", () => {
  it("returns true for edit kind", () => {
    expect(
      isMutatingToolCall({
        toolCallId: "1",
        title: "x",
        kind: "edit",
        status: "completed",
        content: [],
      }),
    ).toBe(true);
  });

  it("returns false for plain read", () => {
    expect(
      isMutatingToolCall({
        toolCallId: "1",
        title: "Read package.json",
        kind: "read",
        status: "completed",
        content: [],
        rawInput: { file_path: "package.json" },
      }),
    ).toBe(false);
  });
});

describe("reviewSessionTitle", () => {
  it("prefixes Review:", () => {
    expect(reviewSessionTitle("My chat")).toBe("Review: My chat");
  });

  it("truncates long titles", () => {
    const t = reviewSessionTitle("a".repeat(80), 20);
    expect(t.startsWith("Review: ")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(20);
  });
});

describe("DEFAULT_REVIEW_PROMPT", () => {
  it("asks for a structured review", () => {
    expect(DEFAULT_REVIEW_PROMPT.toLowerCase()).toContain("review");
    expect(DEFAULT_REVIEW_PROMPT.toLowerCase()).toContain("severity");
    expect(DEFAULT_REVIEW_PROMPT.toLowerCase()).toContain("correctness");
  });
});
