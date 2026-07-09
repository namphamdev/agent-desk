import { describe, expect, it } from "vitest";
import { initialSession, reduce, reduceAll } from "./reducer";
import type { SessionUpdate } from "./types";

describe("session reducer", () => {
  it("coalesces consecutive text chunks into one message", () => {
    const a: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    };
    const b: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: ", world" },
    };
    const s = reduceAll([a, b]);
    expect(s.timeline).toHaveLength(1);
    const entry = s.timeline[0];
    expect(entry.type).toBe("message");
    if (entry.type === "message") {
      expect(entry.role).toBe("agent");
      expect(entry.content[0]).toEqual({ type: "text", text: "Hello, world" });
    }
  });

  it("starts a new message when the role changes", () => {
    const s = reduceAll([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hi" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    ]);
    expect(s.timeline).toHaveLength(2);
  });

  it("applies tool_call_update to the right tool call", () => {
    let s = initialSession;
    s = reduce(s, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Edit foo.ts",
      kind: "edit",
    });
    s = reduce(s, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });
    const entry = s.timeline[0];
    expect(entry.type).toBe("tool_call");
    if (entry.type === "tool_call") {
      expect(entry.toolCall.status).toBe("completed");
    }
  });

  it("ignores updates for unknown tool calls gracefully", () => {
    const s = reduce(initialSession, {
      sessionUpdate: "tool_call_update",
      toolCallId: "nope",
      status: "completed",
    });
    expect(s.timeline).toHaveLength(0);
  });
});
