import { Check, Circle, type LucideIcon, Minus } from "lucide-react";
import type { Plan, PlanEntry } from "../../../session/types";

const marker: Record<PlanEntry["state"], LucideIcon> = {
  completed: Check,
  in_progress: Circle,
  pending: Minus,
};

const cls = {
  completed: "text-emerald-600",
  in_progress: "text-amber-500",
  pending: "text-[var(--text-faint)]",
} as const;

/** Renders an agent plan as a checklist. */
export function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
        Plan
      </div>
      <ul className="space-y-1">
        {plan.entries.map((e, i) => {
          const Marker = marker[e.state];
          return (
            <li key={i} className={`flex items-start gap-2 text-sm ${cls[e.state]}`}>
              <Marker className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span
                className={
                  e.state === "pending"
                    ? "text-[var(--text-muted)]"
                    : "text-[var(--text)]"
                }
              >
                {e.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
