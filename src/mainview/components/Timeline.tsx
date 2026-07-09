import type { TimelineEntry as Entry } from "../../session/types";
import { Content } from "./content/Content";
import { ToolCallCard } from "./entries/ToolCallCard";
import { PlanView } from "./entries/PlanView";

/**
 * Renders the ordered session timeline. Each entry becomes either a message
 * bubble (user/agent/thought), a tool-call card, or a plan checklist.
 */
export function Timeline({ entries }: { entries: Entry[] }) {
  return (
    <div className="space-y-6">
      {entries.map((entry) => {
        if (entry.type === "tool_call") {
          return <ToolCallCard key={entry.id} toolCall={entry.toolCall} />;
        }
        if (entry.type === "plan") {
          return <PlanView key={entry.id} plan={entry.plan} />;
        }
        // message
        if (entry.role === "user") {
          return (
            <div key={entry.id} className="flex justify-end">
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
            <div
              key={entry.id}
              className="rounded-lg border border-dashed border-[#333] bg-[#181818] px-4 py-3 text-sm text-gray-500"
            >
              {entry.content.map((b, i) => (
                <Content key={i} block={b} />
              ))}
            </div>
          );
        }
        // agent message — styled like the system response in ui.html
        return (
          <div key={entry.id} className="flex flex-col space-y-3 text-gray-300">
            {entry.content.map((b, i) => (
              <Content key={i} block={b} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
