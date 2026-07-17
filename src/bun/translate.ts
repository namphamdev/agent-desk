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
import type { SessionConfigOption, SessionUsage } from "../shared/rpc";

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
    case "usage_update":
      // Handled separately by the session manager (context meter).
      return null;
    default:
      return null;
  }
}

/** Map ACP `usage_update` into shared session usage (context window meter). */
export function translateUsageUpdate(
  update: Extract<WireUpdate, { sessionUpdate: "usage_update" }>,
): SessionUsage | null {
  const used = Number(update.used);
  const size = Number(update.size);
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  const cost =
    update.cost &&
    typeof update.cost.amount === "number" &&
    typeof update.cost.currency === "string"
      ? { amount: update.cost.amount, currency: update.cost.currency }
      : null;
  return {
    used: Math.max(0, Math.floor(used)),
    size: Math.floor(size),
    cost,
  };
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

/** Wire shape for ACP SessionModeState (session/new `modes`). */
export type WireSessionModeState = {
  currentModeId?: string;
  availableModes?: Array<{
    id?: string;
    name?: string;
    description?: string | null;
  }> | null;
} | null;

/**
 * If the agent only advertises permission/session modes via `modes` (not
 * configOptions category `mode`), synthesize a select option so the prompt
 * bar can show Claude Code permission modes (default, acceptEdits, plan, …).
 * No-op when a mode select already exists.
 */
export function mergeSessionModesIntoConfigOptions(
  configOptions: SessionConfigOption[],
  modes: WireSessionModeState | undefined,
): SessionConfigOption[] {
  if (!modes?.availableModes?.length || !modes.currentModeId) {
    return configOptions;
  }
  const hasMode = configOptions.some(
    (o) =>
      o.type === "select" &&
      (o.category === "mode" || o.id === "mode"),
  );
  if (hasMode) return configOptions;

  const options = modes.availableModes
    .filter((m): m is { id: string; name: string; description?: string | null } =>
      !!m?.id && !!m?.name,
    )
    .map((m) => ({
      value: m.id,
      name: m.name,
      description: m.description ?? undefined,
    }));
  if (options.length === 0) return configOptions;

  return [
    ...configOptions,
    {
      id: "mode",
      name: "Permission",
      category: "mode",
      type: "select",
      currentValue: modes.currentModeId,
      options,
    },
  ];
}

/** Update the current value of a mode select option (config or synthesized). */
export function withModeCurrentValue(
  configOptions: SessionConfigOption[],
  modeId: string,
): SessionConfigOption[] {
  let changed = false;
  const next = configOptions.map((o) => {
    if (
      o.type === "select" &&
      (o.category === "mode" || o.id === "mode") &&
      o.currentValue !== modeId
    ) {
      changed = true;
      return { ...o, currentValue: modeId };
    }
    return o;
  });
  return changed ? next : configOptions;
}


/**
 * Grok Build (and similar) often omit `modes` / configOptions for permission.
 * They still honor session/set_mode + spawn --always-approve for YOLO.
 * Synthesize a Permission select so the host UI can show a dropdown.
 */

/** Grok `_meta["x.ai/sessionConfig"].options` entries. */
export type GrokSessionConfigOption = {
  id?: string;
  category?: string;
  label?: string;
  selected?: boolean;
};

export const GROK_EFFORT_VALUES = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type GrokEffortValue = (typeof GROK_EFFORT_VALUES)[number];

export function isGrokEffortValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (GROK_EFFORT_VALUES as readonly string[]).includes(v);
}

/**
 * Map Grok session meta options into host configOptions.
 * Grok mislabels reasoning effort as category `mode` (minimal…xhigh) and
 * models as category `model`. Permission modes are separate synthetic options.
 */
export function translateGrokSessionConfig(
  options: readonly GrokSessionConfigOption[] | null | undefined,
  preferredEffort?: string,
): SessionConfigOption[] {
  if (!options?.length) return [];

  const models = options.filter((o) => o?.category === "model" && o.id);
  const efforts = options.filter(
    (o) => o?.category === "mode" && o.id && isGrokEffortValue(String(o.id)),
  );

  const out: SessionConfigOption[] = [];

  if (models.length > 0) {
    const selected = models.find((o) => o.selected)?.id;
    out.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: String(selected ?? models[0]!.id),
      options: models.map((o) => ({
        value: String(o.id),
        name: o.label?.trim() || String(o.id),
      })),
    });
  }

  if (efforts.length > 0) {
    const preferred = preferredEffort?.trim().toLowerCase();
    const selected =
      (preferred && efforts.some((o) => String(o.id).toLowerCase() === preferred)
        ? preferred
        : null) ??
      efforts.find((o) => o.selected)?.id ??
      "high";
    out.push({
      id: "thought_level",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: String(selected),
      options: efforts.map((o) => ({
        value: String(o.id),
        name: o.label?.trim() || String(o.id),
        description: grokEffortDescription(String(o.id)),
      })),
    });
  }

  return out;
}

function grokEffortDescription(id: string): string | undefined {
  switch (id.toLowerCase()) {
    case "minimal":
      return "Fastest, least reasoning";
    case "low":
      return "Some reasoning; latency-sensitive agentic work";
    case "medium":
      return "More thinking for complex analysis";
    case "high":
      return "Deeper reasoning (default)";
    case "xhigh":
      return "Maximum reasoning for hard multi-step tasks";
    default:
      return undefined;
  }
}

/**
 * When Grok meta is missing effort options, still expose low/medium/high
 * so the Effort dropdown is available (values apply via set_mode / --effort).
 */
export function withFallbackGrokEffort(
  configOptions: SessionConfigOption[],
  currentEffort = "high",
): SessionConfigOption[] {
  const hasEffort = configOptions.some(
    (o) =>
      o.type === "select" &&
      (o.category === "thought_level" ||
        o.id === "thought_level" ||
        o.id === "effort"),
  );
  if (hasEffort) return configOptions;

  const current = isGrokEffortValue(currentEffort)
    ? currentEffort.trim().toLowerCase()
    : "high";

  return [
    ...configOptions,
    {
      id: "thought_level",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: current,
      options: [
        {
          value: "low",
          name: "Low",
          description: "Some reasoning; latency-sensitive agentic work",
        },
        {
          value: "medium",
          name: "Medium",
          description: "More thinking for complex analysis",
        },
        {
          value: "high",
          name: "High",
          description: "Deeper reasoning (default)",
        },
        {
          value: "xhigh",
          name: "X-High",
          description: "Maximum reasoning for hard multi-step tasks",
        },
      ],
    },
  ];
}

export function withEffortCurrentValue(
  configOptions: SessionConfigOption[],
  effortId: string,
): SessionConfigOption[] {
  let changed = false;
  const next = configOptions.map((o) => {
    if (
      o.type === "select" &&
      (o.category === "thought_level" ||
        o.id === "thought_level" ||
        o.id === "effort") &&
      o.currentValue !== effortId
    ) {
      changed = true;
      return { ...o, currentValue: effortId };
    }
    return o;
  });
  return changed ? next : configOptions;
}

export function withFallbackPermissionMode(
  configOptions: SessionConfigOption[],
  currentModeId = "default",
): SessionConfigOption[] {
  const hasMode = configOptions.some(
    (o) =>
      o.type === "select" &&
      (o.category === "mode" || o.id === "mode"),
  );
  if (hasMode) return configOptions;

  const current = currentModeId.trim() || "default";
  const options = [
    {
      value: "default",
      name: "Default",
      description: "Ask before tools / edits",
    },
    {
      value: "plan",
      name: "Plan",
      description: "Plan mode (write tools blocked until approved)",
    },
    {
      value: "acceptEdits",
      name: "Accept edits",
      description: "Auto-approve file edits when supported",
    },
    {
      value: "bypassPermissions",
      name: "Always approve",
      description: "Auto-approve all tool executions (Grok --always-approve)",
    },
  ];
  // Keep unknown current values visible in the select.
  if (!options.some((o) => o.value === current)) {
    options.unshift({
      value: current,
      name: current,
      description: "Current mode from agent",
    });
  }

  return [
    ...configOptions,
    {
      id: "mode",
      name: "Permission",
      category: "mode",
      type: "select",
      currentValue: current,
      options,
    },
  ];
}

