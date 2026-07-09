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
  pending: "text-gray-500",
  in_progress: "text-amber-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
};

const statusLabel: Record<ToolCall["status"], string> = {
  pending: "pending",
  in_progress: "running",
  completed: "done",
  failed: "failed",
};

/**
 * Collapsible card for a tool call: kind icon, title, status indicator, file
 * locations, and rendered body (content blocks + diffs + terminals).
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

  return (
    <div
      className="rounded-xl border border-[#2e2e2e] bg-[#181818]"
      aria-label={`Tool call ${toolCall.title}, ${statusLabel[toolCall.status]}`}
    >
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <span aria-hidden>{kindIcon[kind]}</span>
        <span className="font-medium text-gray-200">{toolCall.title}</span>
        <span
          className={`flex items-center gap-1 text-xs ${statusStyle[toolCall.status]}`}
          aria-live="polite"
        >
          {toolCall.status === "in_progress" && (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-amber-400 border-t-transparent" />
          )}
          {toolCall.status === "completed" && <span>✓</span>}
          {toolCall.status === "failed" && <span>✕</span>}
          {statusLabel[toolCall.status]}
        </span>
        {loc && (
          <button
            type="button"
            onClick={() => onOpenFile?.(loc.path, loc.line)}
            className="ml-auto truncate font-mono text-[11px] text-gray-500 hover:text-blue-400 hover:underline"
            title="Open in editor"
          >
            {loc.path}
            {loc.line ? `:${loc.line}` : ""}
          </button>
        )}
      </div>

      {toolCall.content.length > 0 && (
        <div className="space-y-1 border-t border-[#2e2e2e] px-3 py-2">
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
                  className="rounded border border-[#2e2e2e] bg-black/40 px-2 py-1 font-mono text-xs text-gray-400"
                >
                  terminal {item.terminalId}
                </div>
              );
            }
            return <Content key={i} block={item.content} />;
          })}
        </div>
      )}
    </div>
  );
}
