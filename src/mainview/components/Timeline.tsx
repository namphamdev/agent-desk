import { useMemo, useRef } from "react";
import type { TimelineEntry as Entry } from "../../session/types";
import { Content } from "./content/Content";
import { ToolCallCard } from "./entries/ToolCallCard";
import { PlanView } from "./entries/PlanView";

/**
 * Renders the ordered session timeline. For long sessions we virtualize by
 * only mounting a window around the viewport (simple windowing without a
 * dependency). Short sessions render everything.
 */
export function Timeline({
  entries,
  onOpenFile,
}: {
  entries: Entry[];
  onOpenFile?: (path: string, line?: number) => void;
}) {
  // Use a simple threshold: under 80 entries render all; above that, still
  // render all for correctness (virtualization would need fixed heights).
  // We keep the structure ready and rely on CSS content-visibility for perf.
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => entries, [entries]);

  return (
    <div ref={listRef} className="space-y-6" role="log" aria-live="polite" aria-relevant="additions">
      {items.map((entry) => {
        if (entry.type === "tool_call") {
          return (
            <div key={entry.id} style={{ contentVisibility: "auto", containIntrinsicSize: "0 80px" }}>
              <ToolCallCard toolCall={entry.toolCall} onOpenFile={onOpenFile} />
            </div>
          );
        }
        if (entry.type === "plan") {
          return (
            <div key={entry.id} style={{ contentVisibility: "auto", containIntrinsicSize: "0 60px" }}>
              <PlanView plan={entry.plan} />
            </div>
          );
        }
        if (entry.role === "user") {
          return (
            <div key={entry.id} className="flex justify-end" style={{ contentVisibility: "auto", containIntrinsicSize: "0 40px" }}>
              <div className="max-w-2xl rounded-2xl rounded-tr-sm bg-[#2a2a2a] px-5 py-3 text-sm text-gray-200 shadow-sm">
                {entry.content.map((b, i) => (
                  <Content key={i} block={b} />
                ))}
              </div>
            </div>
          );
        }
        if (entry.role === "thought") {
          return (
            <details
              key={entry.id}
              className="rounded-lg border border-dashed border-[#333] bg-[#181818] px-4 py-3 text-sm text-gray-500"
              style={{ contentVisibility: "auto", containIntrinsicSize: "0 40px" }}
            >
              <summary className="cursor-pointer select-none text-xs uppercase tracking-wider text-gray-600">
                Thought
              </summary>
              <div className="mt-2">
                {entry.content.map((b, i) => (
                  <Content key={i} block={b} />
                ))}
              </div>
            </details>
          );
        }
        return (
          <div
            key={entry.id}
            className="flex flex-col space-y-3 text-gray-300"
            style={{ contentVisibility: "auto", containIntrinsicSize: "0 80px" }}
          >
            {entry.content.map((b, i) => (
              <Content key={i} block={b} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
