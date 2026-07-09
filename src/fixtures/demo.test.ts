import { describe, expect, it } from "vitest";
import { demoUpdates } from "./demo";
import { reduceAll } from "../session/reducer";
import type { SessionUpdate } from "../session/types";

/**
 * End-to-end fixture contract: the recorded demo session must exercise every
 * renderer the UI cares about (messages, plan, tool calls, diffs, mermaid).
 */
describe("demo fixture", () => {
  it("is a non-empty sequence of valid session updates", () => {
    expect(demoUpdates.length).toBeGreaterThan(5);
    for (const u of demoUpdates) {
      expect(u).toHaveProperty("sessionUpdate");
    }
  });

  it("starts with a user message", () => {
    expect(demoUpdates[0]).toMatchObject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text" },
    });
  });

  it("includes plan, tool_call, tool_call_update, and agent chunks", () => {
    const kinds = new Set(demoUpdates.map((u) => u.sessionUpdate));
    expect(kinds.has("plan")).toBe(true);
    expect(kinds.has("tool_call")).toBe(true);
    expect(kinds.has("tool_call_update")).toBe(true);
    expect(kinds.has("agent_message_chunk")).toBe(true);
    expect(kinds.has("user_message_chunk")).toBe(true);
  });

  it("includes a diff tool-call content item", () => {
    const withDiff = demoUpdates.find(
      (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call" }> =>
        u.sessionUpdate === "tool_call" &&
        !!u.content?.some((c) => c.type === "diff"),
    );
    expect(withDiff).toBeTruthy();
    const diff = withDiff!.content!.find((c) => c.type === "diff");
    expect(diff).toMatchObject({
      type: "diff",
      path: expect.stringContaining("VariantSelector.tsx"),
    });
  });

  it("agent text includes mermaid and markdown table content", () => {
    const text = demoUpdates
      .filter(
        (u): u is Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }> =>
          u.sessionUpdate === "agent_message_chunk" &&
          u.content.type === "text",
      )
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");

    expect(text).toContain("```mermaid");
    expect(text).toContain("flowchart");
    expect(text).toMatch(/\|.*\|/); // markdown table
    expect(text).toContain("```tsx");
  });

  it("tool_call_update targets an existing tool_call id", () => {
    const ids = new Set(
      demoUpdates
        .filter(
          (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call" }> =>
            u.sessionUpdate === "tool_call",
        )
        .map((u) => u.toolCallId),
    );
    for (const u of demoUpdates) {
      if (u.sessionUpdate === "tool_call_update") {
        expect(ids.has(u.toolCallId)).toBe(true);
      }
    }
  });

  it("reduces cleanly into a timeline the UI can render", () => {
    const state = reduceAll(demoUpdates);
    expect(state.timeline.length).toBeGreaterThan(0);

    // Every entry has a stable id and a known type.
    for (const entry of state.timeline) {
      expect(entry.id).toBeTruthy();
      expect(["message", "tool_call", "plan"]).toContain(entry.type);
    }

    // Final tool edit should be completed after its update.
    const edit = state.timeline.find(
      (e) => e.type === "tool_call" && e.toolCall.toolCallId === "t2",
    );
    expect(edit?.type).toBe("tool_call");
    if (edit?.type === "tool_call") {
      expect(edit.toolCall.status).toBe("completed");
    }
  });
});
