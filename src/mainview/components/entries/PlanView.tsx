import type { Plan } from "../../../session/types";

const marker = {
  completed: "✓",
  in_progress: "○",
  pending: "•",
} as const;

const cls = {
  completed: "text-emerald-400",
  in_progress: "text-amber-400",
  pending: "text-gray-600",
} as const;

/** Renders an agent plan as a checklist. */
export function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="rounded-xl border border-[#2e2e2e] bg-[#181818] px-3 py-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
        Plan
      </div>
      <ul className="space-y-1">
        {plan.entries.map((e, i) => (
          <li key={i} className={`flex items-start gap-2 text-sm ${cls[e.state]}`}>
            <span className="mt-0.5 w-4 select-none">{marker[e.state]}</span>
            <span className={e.state === "pending" ? "text-gray-400" : "text-gray-200"}>
              {e.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
