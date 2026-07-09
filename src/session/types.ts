/**
 * ACP (Agent Client Protocol) data model.
 *
 * This mirrors the subset of the Agent Client Protocol we render today:
 * - Content blocks (MCP-derived): text, image, resource, resource_link
 * - Tool calls + tool-call content incl. diff + terminal
 * - Plans and session modes
 *
 * These are local render-focused types (not generated from the official SDK),
 * so the rendering pipeline is decoupled from the wire protocol. In Milestone 2
 * the Bun side will translate live ACP `session/update` notifications into these.
 *
 * Spec: https://agentclientprotocol.com/protocol
 */

// ---------------------------------------------------------------------------
// Content blocks (renderable payloads inside messages and tool calls)
// ---------------------------------------------------------------------------

export type TextContent = { type: "text"; text: string };
export type ImageContent = {
  type: "image";
  data: string; // base64
  mimeType: string;
  uri?: string;
};
export type ResourceContent = {
  type: "resource";
  resource:
    | { uri: string; text: string; mimeType?: string }
    | { uri: string; blob: string; mimeType?: string };
};
export type ResourceLinkContent = {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
  title?: string;
  description?: string;
};

export type ContentBlock =
  | TextContent
  | ImageContent
  | ResourceContent
  | ResourceLinkContent;

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export type ToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

/** A nested content block produced by a tool call. */
export type ToolCallContentItem =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export type ToolCallLocation = { path: string; line?: number };

export type ToolCall = {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status: ToolCallStatus;
  content: ToolCallContentItem[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
};

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export type PlanEntry = {
  content: string;
  state: "pending" | "in_progress" | "completed";
};

export type Plan = { entries: PlanEntry[] };

// ---------------------------------------------------------------------------
// Timeline entries (the output of the reducer)
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "agent" | "thought";

export type TimelineEntry =
  | { id: string; type: "message"; role: MessageRole; content: ContentBlock[] }
  | { id: string; type: "tool_call"; toolCall: ToolCall }
  | { id: string; type: "plan"; plan: Plan };

// ---------------------------------------------------------------------------
// session/update events (the input to the reducer)
// ---------------------------------------------------------------------------

/**
 * The agent streams progress via `session/update` notifications. Each carries a
 * single `sessionUpdate` discriminator. We model the renderable subset here.
 */
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "thought_sequence_chunk"; content: ContentBlock }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind?: ToolKind;
      status?: ToolCallStatus;
      content?: ToolCallContentItem[];
      locations?: ToolCallLocation[];
      rawInput?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      title?: string;
      kind?: ToolKind;
      status?: ToolCallStatus;
      content?: ToolCallContentItem[];
      locations?: ToolCallLocation[];
      rawOutput?: unknown;
    }
  | { sessionUpdate: "plan"; plan: Plan }
  | { sessionUpdate: "current_mode"; mode: string };
