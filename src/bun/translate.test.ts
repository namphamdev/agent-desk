import { describe, expect, it } from "vitest";
import {
  translateAvailableCommands,
  translateSessionUpdate,
} from "./translate";
import type { SessionUpdate as WireUpdate } from "@agentclientprotocol/sdk";

describe("translateSessionUpdate", () => {
  it("maps agent_thought_chunk to thought_sequence_chunk", () => {
    const wire = {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "hmm" },
    } as WireUpdate;
    const local = translateSessionUpdate(wire);
    expect(local).toEqual({
      sessionUpdate: "thought_sequence_chunk",
      content: { type: "text", text: "hmm" },
    });
  });

  it("maps agent and user message chunks", () => {
    expect(
      translateSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      } as WireUpdate),
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    });

    expect(
      translateSessionUpdate({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "yo" },
      } as WireUpdate),
    ).toEqual({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "yo" },
    });
  });

  it("maps plan status -> state", () => {
    const wire = {
      sessionUpdate: "plan",
      entries: [{ content: "step", priority: "medium", status: "in_progress" }],
    } as WireUpdate;
    const local = translateSessionUpdate(wire);
    expect(local).toEqual({
      sessionUpdate: "plan",
      plan: { entries: [{ content: "step", state: "in_progress" }] },
    });
  });

  it("defaults unknown plan status to pending", () => {
    const wire = {
      sessionUpdate: "plan",
      entries: [{ content: "step", priority: "high", status: "unknown" }],
    } as unknown as WireUpdate;
    expect(translateSessionUpdate(wire)).toEqual({
      sessionUpdate: "plan",
      plan: { entries: [{ content: "step", state: "pending" }] },
    });
  });

  it("maps current_mode_update", () => {
    const wire = {
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    } as WireUpdate;
    expect(translateSessionUpdate(wire)).toEqual({
      sessionUpdate: "current_mode",
      mode: "plan",
    });
  });

  it("drops available_commands_update (handled separately)", () => {
    const wire = {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "test", description: "d" }],
    } as WireUpdate;
    expect(translateSessionUpdate(wire)).toBeNull();
  });

  it("maps image and resource_link content", () => {
    const image = translateSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "image",
        data: "base64data",
        mimeType: "image/png",
        uri: "file:///x.png",
      },
    } as WireUpdate);
    expect(image).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "image",
        data: "base64data",
        mimeType: "image/png",
        uri: "file:///x.png",
      },
    });

    const link = translateSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: "https://example.com",
        name: "Example",
        title: "T",
        description: "D",
        mimeType: "text/html",
      },
    } as WireUpdate);
    expect(link).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: "https://example.com",
        name: "Example",
        title: "T",
        description: "D",
        mimeType: "text/html",
      },
    });
  });

  it("maps text and blob resources", () => {
    const textRes = translateSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource",
        resource: {
          uri: "file:///a.ts",
          text: "const x = 1",
          mimeType: "text/typescript",
        },
      },
    } as WireUpdate);
    expect(textRes).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource",
        resource: { uri: "file:///a.ts", text: "const x = 1" },
      },
    });

    const blobRes = translateSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource",
        resource: {
          uri: "file:///b.bin",
          blob: "AA==",
          mimeType: "application/octet-stream",
        },
      },
    } as WireUpdate);
    expect(blobRes).toMatchObject({
      content: {
        type: "resource",
        resource: { uri: "file:///b.bin", blob: "AA==" },
      },
    });
  });

  it("maps tool_call with content, locations, and kind", () => {
    const wire = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Edit file",
      kind: "edit",
      status: "in_progress",
      locations: [{ path: "/tmp/a.ts", line: 10 }],
      content: [
        {
          type: "content",
          content: { type: "text", text: "preview" },
        },
        {
          type: "diff",
          path: "/tmp/a.ts",
          oldText: "old",
          newText: "new",
        },
        {
          type: "terminal",
          terminalId: "term-1",
        },
      ],
      rawInput: { path: "/tmp/a.ts" },
    } as WireUpdate;

    expect(translateSessionUpdate(wire)).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Edit file",
      kind: "edit",
      status: "in_progress",
      locations: [{ path: "/tmp/a.ts", line: 10 }],
      content: [
        { type: "content", content: { type: "text", text: "preview" } },
        {
          type: "diff",
          path: "/tmp/a.ts",
          oldText: "old",
          newText: "new",
        },
        { type: "terminal", terminalId: "term-1" },
      ],
      rawInput: { path: "/tmp/a.ts" },
    });
  });

  it("maps tool_call_update and normalizes unknown kinds/status", () => {
    const wire = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      title: "Done",
      kind: "weird_kind",
      status: "not_a_status",
      rawOutput: { ok: true },
    } as unknown as WireUpdate;

    expect(translateSessionUpdate(wire)).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      title: "Done",
      kind: "other",
      status: "pending",
      content: undefined,
      locations: undefined,
      rawOutput: { ok: true },
    });
  });

  it("returns null for unknown sessionUpdate variants", () => {
    const wire = {
      sessionUpdate: "session_info_update",
      title: "x",
    } as unknown as WireUpdate;
    expect(translateSessionUpdate(wire)).toBeNull();
  });
});

describe("translateAvailableCommands", () => {
  it("maps command list with optional fields", () => {
    const cmds = translateAvailableCommands({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        {
          name: "test",
          description: "Run tests",
          input: { hint: "<pattern>" },
        },
        {
          name: "compact",
        },
      ],
    } as Extract<WireUpdate, { sessionUpdate: "available_commands_update" }>);

    expect(cmds).toEqual([
      {
        name: "test",
        description: "Run tests",
        input: { hint: "<pattern>" },
      },
      {
        name: "compact",
        description: undefined,
        input: undefined,
      },
    ]);
  });

  it("returns empty array when commands missing", () => {
    const cmds = translateAvailableCommands({
      sessionUpdate: "available_commands_update",
    } as Extract<WireUpdate, { sessionUpdate: "available_commands_update" }>);
    expect(cmds).toEqual([]);
  });
});
