import type {
  ContentBlock,
  SessionUpdate,
  TimelineEntry,
  ToolCall,
} from "./types";

export interface SessionState {
  timeline: TimelineEntry[];
  mode: string;
}

export const initialSession: SessionState = { timeline: [], mode: "default" };

let counter = 0;
const uid = (prefix: string) => `${prefix}-${counter++}`;

/**
 * Two content blocks of the same primitive type can be merged when they arrive
 * as consecutive streaming chunks (e.g. text deltas). We append rather than
 * replace so a message grows naturally as it streams.
 */
function mergeContent(a: ContentBlock, b: ContentBlock): ContentBlock | null {
  if (a.type === "text" && b.type === "text") {
    return { type: "text", text: a.text + b.text };
  }
  return null;
}

/**
 * Fold a new content chunk into the last message of `role` if it's the
 * trailing entry; otherwise start a new message entry. This is how we turn a
 * stream of `*_message_chunk` updates into coherent message bubbles.
 */
function appendMessage(
  state: SessionState,
  role: "user" | "agent" | "thought",
  content: ContentBlock,
): SessionState {
  const timeline = state.timeline;
  const last = timeline[timeline.length - 1];
  if (last && last.type === "message" && last.role === role) {
    const items = last.content;
    const tail = items[items.length - 1];
    const merged = tail ? mergeContent(tail, content) : null;
    const nextItems = merged
      ? [...items.slice(0, -1), merged]
      : [...items, content];
    return {
      ...state,
      timeline: [
        ...timeline.slice(0, -1),
        { ...last, content: nextItems },
      ],
    };
  }
  return {
    ...state,
    timeline: [
      ...timeline,
      { id: uid("msg"), type: "message", role, content: [content] },
    ],
  };
}

function applyToolCall(
  state: SessionState,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>,
): SessionState {
  const toolCall: ToolCall = {
    toolCallId: update.toolCallId,
    title: update.title,
    kind: update.kind,
    status: update.status ?? "pending",
    content: update.content ?? [],
    locations: update.locations,
    rawInput: update.rawInput,
  };
  return {
    ...state,
    timeline: [
      ...state.timeline,
      { id: uid("tool"), type: "tool_call", toolCall },
    ],
  };
}

function applyToolCallUpdate(
  state: SessionState,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
): SessionState {
  const timeline = state.timeline.map((entry) => {
    if (
      entry.type !== "tool_call" ||
      entry.toolCall.toolCallId !== update.toolCallId
    ) {
      return entry;
    }
    const tc = entry.toolCall;
    return {
      ...entry,
      toolCall: {
        ...tc,
        title: update.title ?? tc.title,
        kind: update.kind ?? tc.kind,
        status: update.status ?? tc.status,
        content: update.content ? [...tc.content, ...update.content] : tc.content,
        locations: update.locations ?? tc.locations,
        rawOutput: update.rawOutput ?? tc.rawOutput,
      },
    };
  });
  return { ...state, timeline };
}

/** Reduce one session/update notification onto the session state. Pure. */
export function reduce(
  state: SessionState,
  update: SessionUpdate,
): SessionState {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return appendMessage(state, "agent", update.content);
    case "user_message_chunk":
      return appendMessage(state, "user", update.content);
    case "thought_sequence_chunk":
      return appendMessage(state, "thought", update.content);
    case "tool_call":
      return applyToolCall(state, update);
    case "tool_call_update":
      return applyToolCallUpdate(state, update);
    case "plan":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { id: uid("plan"), type: "plan", plan: update.plan },
        ],
      };
    case "current_mode":
      return { ...state, mode: update.mode };
    default:
      return state;
  }
}

/** Convenience: reduce a whole recorded stream of updates. */
export function reduceAll(updates: SessionUpdate[]): SessionState {
  return updates.reduce(reduce, initialSession);
}
