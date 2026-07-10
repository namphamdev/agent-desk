import { describe, expect, it } from "vitest";
import { initialSession, reduce, reduceAll } from "./reducer";
import type { SessionUpdate } from "./types";
import { demoUpdates } from "../fixtures/demo";

describe("session reducer", () => {
  it("starts from an empty timeline in default mode", () => {
    expect(initialSession).toEqual({ timeline: [], mode: "default" });
  });

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

  it("concatenates duplicate user chunks (callers must not double-apply)", () => {
    // Regression guard for the "hellohello" UI bug: optimistic handlePrompt
    // plus a re-emitted user_message_chunk would merge into one bubble.
    const s = reduceAll([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hello" },
      },
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hello" },
      },
    ]);
    expect(s.timeline).toHaveLength(1);
    const entry = s.timeline[0];
    expect(entry.type).toBe("message");
    if (entry.type === "message") {
      expect(entry.content[0]).toEqual({ type: "text", text: "hellohello" });
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
    expect(s.timeline[0]).toMatchObject({ type: "message", role: "user" });
    expect(s.timeline[1]).toMatchObject({ type: "message", role: "agent" });
  });

  it("coalesces thought chunks separately from agent messages", () => {
    const s = reduceAll([
      {
        sessionUpdate: "thought_sequence_chunk",
        content: { type: "text", text: "thinking" },
      },
      {
        sessionUpdate: "thought_sequence_chunk",
        content: { type: "text", text: " more" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "answer" },
      },
    ]);
    expect(s.timeline).toHaveLength(2);
    const thought = s.timeline[0];
    expect(thought.type).toBe("message");
    if (thought.type === "message") {
      expect(thought.role).toBe("thought");
      expect(thought.content[0]).toEqual({ type: "text", text: "thinking more" });
    }
  });

  it("appends non-mergeable content blocks instead of overwriting", () => {
    const s = reduceAll([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "see image" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "image",
          data: "abc",
          mimeType: "image/png",
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
      },
    ]);
    expect(s.timeline).toHaveLength(1);
    const entry = s.timeline[0];
    expect(entry.type).toBe("message");
    if (entry.type === "message") {
      expect(entry.content).toHaveLength(3);
      expect(entry.content[0]).toEqual({ type: "text", text: "see image" });
      expect(entry.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(entry.content[2]).toEqual({ type: "text", text: "done" });
    }
  });

  it("creates tool_call entries with defaults", () => {
    const s = reduce(initialSession, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read foo.ts",
      kind: "read",
    });
    expect(s.timeline).toHaveLength(1);
    const entry = s.timeline[0];
    expect(entry.type).toBe("tool_call");
    if (entry.type === "tool_call") {
      expect(entry.toolCall).toMatchObject({
        toolCallId: "t1",
        title: "Read foo.ts",
        kind: "read",
        status: "pending",
        content: [],
      });
    }
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
      content: [
        {
          type: "diff",
          path: "foo.ts",
          oldText: "a",
          newText: "b",
        },
      ],
      rawOutput: { ok: true },
    });
    const entry = s.timeline[0];
    expect(entry.type).toBe("tool_call");
    if (entry.type === "tool_call") {
      expect(entry.toolCall.status).toBe("completed");
      expect(entry.toolCall.content).toHaveLength(1);
      expect(entry.toolCall.rawOutput).toEqual({ ok: true });
    }
  });

  it("merges partial tool_call_update fields without clobbering", () => {
    let s = initialSession;
    s = reduce(s, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Search",
      kind: "search",
      status: "in_progress",
      locations: [{ path: "a.ts", line: 1 }],
      content: [{ type: "content", content: { type: "text", text: "hit" } }],
    });
    s = reduce(s, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });
    const entry = s.timeline[0];
    expect(entry.type).toBe("tool_call");
    if (entry.type === "tool_call") {
      expect(entry.toolCall.title).toBe("Search");
      expect(entry.toolCall.kind).toBe("search");
      expect(entry.toolCall.locations).toEqual([{ path: "a.ts", line: 1 }]);
      expect(entry.toolCall.content).toHaveLength(1);
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

  it("updates only the matching tool call among several", () => {
    let s = initialSession;
    s = reduce(s, {
      sessionUpdate: "tool_call",
      toolCallId: "a",
      title: "A",
      status: "pending",
    });
    s = reduce(s, {
      sessionUpdate: "tool_call",
      toolCallId: "b",
      title: "B",
      status: "pending",
    });
    s = reduce(s, {
      sessionUpdate: "tool_call_update",
      toolCallId: "a",
      status: "failed",
    });
    expect(s.timeline).toHaveLength(2);
    const a = s.timeline[0];
    const b = s.timeline[1];
    expect(a.type).toBe("tool_call");
    expect(b.type).toBe("tool_call");
    if (a.type === "tool_call" && b.type === "tool_call") {
      expect(a.toolCall.status).toBe("failed");
      expect(b.toolCall.status).toBe("pending");
    }
  });

  it("appends plan entries and replaces mode", () => {
    let s = initialSession;
    s = reduce(s, {
      sessionUpdate: "plan",
      plan: {
        entries: [
          { content: "one", state: "pending" },
          { content: "two", state: "in_progress" },
        ],
      },
    });
    s = reduce(s, { sessionUpdate: "current_mode", mode: "plan" });
    expect(s.mode).toBe("plan");
    expect(s.timeline).toHaveLength(1);
    expect(s.timeline[0]).toMatchObject({
      type: "plan",
      plan: {
        entries: [
          { content: "one", state: "pending" },
          { content: "two", state: "in_progress" },
        ],
      },
    });
  });

  it("leaves state unchanged for unknown update shapes", () => {
    const s = reduce(initialSession, {
      // @ts-expect-error intentional unknown discriminator
      sessionUpdate: "not_a_real_update",
    });
    expect(s).toEqual(initialSession);
  });

  it("reduces the demo fixture into a coherent multi-entry timeline", () => {
    const s = reduceAll(demoUpdates);
    expect(s.timeline.length).toBeGreaterThanOrEqual(5);

    const types = s.timeline.map((e) => e.type);
    expect(types).toContain("message");
    expect(types).toContain("plan");
    expect(types).toContain("tool_call");

    const user = s.timeline.find(
      (e) => e.type === "message" && e.role === "user",
    );
    expect(user).toBeTruthy();

    const plan = s.timeline.find((e) => e.type === "plan");
    expect(plan?.type).toBe("plan");
    if (plan?.type === "plan") {
      expect(plan.plan.entries.length).toBe(3);
      expect(plan.plan.entries.some((e) => e.state === "completed")).toBe(true);
    }

    const edit = s.timeline.find(
      (e) => e.type === "tool_call" && e.toolCall.toolCallId === "t2",
    );
    expect(edit?.type).toBe("tool_call");
    if (edit?.type === "tool_call") {
      expect(edit.toolCall.status).toBe("completed");
      expect(edit.toolCall.content.some((c) => c.type === "diff")).toBe(true);
    }

    // Agent text chunks should coalesce into one growing message bubble
    // interrupted by tool calls, so there may be multiple agent messages.
    const agentMessages = s.timeline.filter(
      (e) => e.type === "message" && e.role === "agent",
    );
    expect(agentMessages.length).toBeGreaterThanOrEqual(1);
    const agentText = agentMessages
      .flatMap((e) => (e.type === "message" ? e.content : []))
      .filter((c) => c.type === "text")
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(agentText).toContain("mermaid");
    expect(agentText).toContain("VariantCard");
  });
});
