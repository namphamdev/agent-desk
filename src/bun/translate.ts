/**
 * Translate wire-level ACP `session/update` payloads into the local render
 * types in `src/session/types.ts`. Keeps the webview decoupled from the SDK.
 */
import type {
  ContentBlock as WireContent,
  SessionUpdate as WireUpdate,
  ToolCallContent as WireToolContent,
  ToolCallLocation as WireLocation,
  ToolCallStatus as WireStatus,
  ToolKind as WireKind,
  Plan as WirePlan,
} from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  Plan,
  SessionUpdate,
  ToolCallContentItem,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "../session/types";
import type { SessionConfigOption } from "../shared/rpc";

function translateContent(block: WireContent): ContentBlock | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
        uri: block.uri ?? undefined,
      };
    case "resource_link":
      return {
        type: "resource_link",
        uri: block.uri,
        name: block.name,
        mimeType: block.mimeType ?? undefined,
        title: block.title ?? undefined,
        description: block.description ?? undefined,
      };
    case "resource": {
      const r = block.resource;
      if ("text" in r && typeof r.text === "string") {
        return {
          type: "resource",
          resource: {
            uri: r.uri,
            text: r.text,
            mimeType: r.mimeType ?? undefined,
          },
        };
      }
      if ("blob" in r && typeof r.blob === "string") {
        return {
          type: "resource",
          resource: {
            uri: r.uri,
            blob: r.blob,
            mimeType: r.mimeType ?? undefined,
          },
        };
      }
      return null;
    }
    default:
      // audio / unknown — skip for now
      return null;
  }
}

function translateKind(kind?: WireKind): ToolKind | undefined {
  if (!kind) return undefined;
  const allowed: ToolKind[] = [
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "other",
  ];
  return (allowed as string[]).includes(kind) ? (kind as ToolKind) : "other";
}

function translateStatus(status?: WireStatus): ToolCallStatus | undefined {
  if (!status) return undefined;
  if (status === "pending" || status === "in_progress" || status === "completed" || status === "failed") {
    return status;
  }
  return "pending";
}

function translateLocations(
  locations?: WireLocation[],
): ToolCallLocation[] | undefined {
  if (!locations) return undefined;
  return locations.map((l) => ({
    path: l.path,
    line: l.line ?? undefined,
  }));
}

function translateToolContent(
  items?: WireToolContent[],
): ToolCallContentItem[] | undefined {
  if (!items) return undefined;
  const out: ToolCallContentItem[] = [];
  for (const item of items) {
    if (item.type === "content") {
      const c = translateContent(item.content);
      if (c) out.push({ type: "content", content: c });
    } else if (item.type === "diff") {
      out.push({
        type: "diff",
        path: item.path,
        oldText: item.oldText ?? null,
        newText: item.newText,
      });
    } else if (item.type === "terminal") {
      out.push({ type: "terminal", terminalId: item.terminalId });
    }
  }
  return out;
}

function translatePlan(plan: WirePlan): Plan {
  return {
    entries: (plan.entries ?? []).map((e) => ({
      content: e.content,
      // Local render model uses `state`; wire uses `status`.
      state:
        e.status === "completed" || e.status === "in_progress" || e.status === "pending"
          ? e.status
          : "pending",
    })),
  };
}

/**
 * Convert one wire `SessionUpdate` into zero-or-more local `SessionUpdate`s.
 * Unknown / non-renderable variants are dropped.
 */
export function translateSessionUpdate(
  update: WireUpdate,
): SessionUpdate | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = translateContent(update.content);
      if (!content) return null;
      return { sessionUpdate: "agent_message_chunk", content };
    }
    case "user_message_chunk": {
      const content = translateContent(update.content);
      if (!content) return null;
      return { sessionUpdate: "user_message_chunk", content };
    }
    case "agent_thought_chunk": {
      const content = translateContent(update.content);
      if (!content) return null;
      // Local model uses thought_sequence_chunk
      return { sessionUpdate: "thought_sequence_chunk", content };
    }
    case "tool_call":
      return {
        sessionUpdate: "tool_call",
        toolCallId: update.toolCallId,
        title: update.title,
        kind: translateKind(update.kind ?? undefined),
        status: translateStatus(update.status ?? undefined),
        content: translateToolContent(update.content ?? undefined),
        locations: translateLocations(update.locations ?? undefined),
        rawInput: update.rawInput,
      };
    case "tool_call_update":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: update.toolCallId,
        title: update.title ?? undefined,
        kind: translateKind(update.kind ?? undefined),
        status: translateStatus(update.status ?? undefined),
        content: translateToolContent(update.content ?? undefined),
        locations: translateLocations(update.locations ?? undefined),
        rawOutput: update.rawOutput,
      };
    case "plan":
      return { sessionUpdate: "plan", plan: translatePlan(update) };
    case "current_mode_update":
      return {
        sessionUpdate: "current_mode",
        mode: update.currentModeId,
      };
    case "available_commands_update":
      // Handled separately by the session manager (not a timeline entry).
      return null;
    case "config_option_update":
      // Handled separately by the session manager (prompt-bar selectors).
      return null;
    default:
      return null;
  }
}

export function translateAvailableCommands(
  update: Extract<WireUpdate, { sessionUpdate: "available_commands_update" }>,
): Array<{ name: string; description?: string; input?: { hint?: string } }> {
  return (update.availableCommands ?? []).map((c) => ({
    name: c.name,
    description: c.description ?? undefined,
    input: c.input
      ? { hint: "hint" in c.input ? (c.input as { hint?: string }).hint : undefined }
      : undefined,
  }));
}

/** Loose wire shape — ACP SDK SessionConfigOption is a complex intersection. */
type WireConfigOptionLike = {
  id?: string;
  name?: string;
  description?: string | null;
  category?: string | null;
  type?: string;
  currentValue?: string | boolean;
  options?: Array<
    | { value: string; name: string; description?: string | null }
    | {
        group: string;
        name: string;
        options?: Array<{
          value: string;
          name: string;
          description?: string | null;
        }>;
      }
  > | null;
};

function flattenSelectOptions(
  options: WireConfigOptionLike["options"],
): Array<{ value: string; name: string; description?: string }> {
  if (!options?.length) return [];
  const out: Array<{ value: string; name: string; description?: string }> = [];
  for (const entry of options) {
    if (entry && typeof entry === "object" && "group" in entry) {
      for (const opt of entry.options ?? []) {
        out.push({
          value: opt.value,
          name: opt.name,
          description: opt.description ?? undefined,
        });
      }
    } else if (entry && typeof entry === "object" && "value" in entry) {
      out.push({
        value: entry.value,
        name: entry.name,
        description: entry.description ?? undefined,
      });
    }
  }
  return out;
}

/** Map wire ACP config options into the shared UI type. */
export function translateConfigOptions(
  options: readonly WireConfigOptionLike[] | null | undefined,
): SessionConfigOption[] {
  if (!options?.length) return [];
  const out: SessionConfigOption[] = [];
  for (const opt of options) {
    if (!opt?.id || !opt?.name) continue;
    if (opt.type === "boolean") {
      out.push({
        id: opt.id,
        name: opt.name,
        description: opt.description ?? undefined,
        category: opt.category ?? null,
        type: "boolean",
        currentValue: Boolean(opt.currentValue),
      });
      continue;
    }
    // Default / select — agents may omit type for select historically.
    if (opt.type === "select" || !opt.type || opt.options) {
      out.push({
        id: opt.id,
        name: opt.name,
        description: opt.description ?? undefined,
        category: opt.category ?? null,
        type: "select",
        currentValue: String(opt.currentValue ?? ""),
        options: flattenSelectOptions(opt.options),
      });
    }
  }
  return out;
}
