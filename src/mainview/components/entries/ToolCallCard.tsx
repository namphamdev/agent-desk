import { useState } from "react";
import type { ToolCall, ToolKind } from "../../../session/types";
import { Content } from "../content/Content";
import { DiffView } from "../content/DiffView";

const kindIcon: Record<ToolKind, string> = {
  read: "📖",
  edit: "✏️",
  delete: "🗑️",
  move: "📦",
  search: "🔍",
  execute: "▶",
  think: "💭",
  fetch: "🌐",
  other: "•",
};

const statusStyle: Record<ToolCall["status"], string> = {
  pending: "text-[var(--text-faint)]",
  in_progress: "text-amber-500",
  completed: "text-emerald-600",
  failed: "text-red-500",
};

const statusLabel: Record<ToolCall["status"], string> = {
  pending: "pending",
  in_progress: "running",
  completed: "done",
  failed: "failed",
};

function formatRaw(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasBody(toolCall: ToolCall): boolean {
  return (
    toolCall.content.length > 0 ||
    toolCall.rawInput !== undefined ||
    toolCall.rawOutput !== undefined
  );
}

/**
 * Collapsible card for a tool call: kind icon, title, status indicator, file
 * locations, and rendered body (content blocks + diffs + terminals + raw I/O).
 *
 * Starts collapsed by default. Header is clickable when there is a body.
 */
export function ToolCallCard({
  toolCall,
  onOpenFile,
}: {
  toolCall: ToolCall;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const kind = toolCall.kind ?? "other";
  const loc = toolCall.locations?.[0];
  const body = hasBody(toolCall);
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-input)]"
      aria-label={`Tool call ${toolCall.title}, ${statusLabel[toolCall.status]}`}
    >
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <button
          type="button"
          onClick={() => body && setExpanded((e) => !e)}
          disabled={!body}
          className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
            body
              ? "cursor-pointer hover:opacity-90"
              : "cursor-default"
          }`}
          aria-expanded={body ? expanded : undefined}
        >
          {body && (
            <span className="shrink-0 text-[var(--text-faint)]" aria-hidden>
              {expanded ? "▾" : "▸"}
            </span>
          )}
          <span aria-hidden>{kindIcon[kind]}</span>
          <span className="truncate font-medium text-[var(--text)]">
            {toolCall.title}
          </span>
          <span
            className={`flex shrink-0 items-center gap-1 text-xs ${statusStyle[toolCall.status]}`}
            aria-live="polite"
          >
            {toolCall.status === "in_progress" && (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border border-amber-500 border-t-transparent" />
            )}
            {toolCall.status === "completed" && <span>✓</span>}
            {toolCall.status === "failed" && <span>✕</span>}
            {statusLabel[toolCall.status]}
          </span>
        </button>
        {loc && (
          <button
            type="button"
            onClick={() => onOpenFile?.(loc.path, loc.line)}
            className="ml-1 max-w-[40%] shrink-0 truncate font-mono text-[11px] text-[var(--text-faint)] hover:text-[var(--link)] hover:underline"
            title="Open in editor"
          >
            {loc.path}
            {loc.line ? `:${loc.line}` : ""}
          </button>
        )}
      </div>

      {body && expanded && (
        <div className="space-y-2 border-t border-[var(--border)] px-3 py-2">
          {toolCall.content.map((item, i) => {
            if (item.type === "diff") {
              return (
                <DiffView
                  key={i}
                  path={item.path}
                  oldText={item.oldText}
                  newText={item.newText}
                />
              );
            }
            if (item.type === "terminal") {
              return (
                <div
                  key={i}
                  className="rounded border border-[var(--border)] bg-[var(--code-bg)] px-2 py-1 font-mono text-xs text-[var(--text-muted)]"
                >
                  terminal {item.terminalId}
                </div>
              );
            }
            return <Content key={i} block={item.content} />;
          })}

          {toolCall.rawInput !== undefined && (
            <RawBlock label="Input" value={toolCall.rawInput} />
          )}
          {toolCall.rawOutput !== undefined && (
            <RawBlock label="Output" value={toolCall.rawOutput} />
          )}
        </div>
      )}
    </div>
  );
}

function RawBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--code-bg)]">
      <div className="border-b border-[var(--border)] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
        {label}
      </div>
      <pre className="max-h-64 overflow-auto px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--text-muted)]">
        <code>{formatRaw(value)}</code>
      </pre>
    </div>
  );
}
