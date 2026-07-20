import type { RecentProject } from "../../shared/rpc";
import { Button } from "@/components/ui/button";
import { MatrixTitle } from "./MatrixTitle";

type Props = {
  sessionLoading: boolean;
  /** True when a chat is selected (agent may still be connecting). */
  hasActiveSession: boolean;
  recentProjects: RecentProject[];
  onNewSession: () => void;
  onOpenProject: (cwd: string) => void;
};

/**
 * Center empty state when the timeline has no messages.
 * Default launch (no session): logo + matrix title + project picker.
 * Active session with empty timeline: short “type below” hint.
 */
export function ChatEmptyState({
  sessionLoading,
  hasActiveSession,
  recentProjects,
  onNewSession,
  onOpenProject,
}: Props) {
  if (sessionLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm text-muted-foreground">
        <div
          className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground/60"
          aria-hidden
        />
        <p className="text-muted-foreground">Loading chat…</p>
      </div>
    );
  }

  if (hasActiveSession) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
        <p className="mb-2 text-base text-muted-foreground">Ready</p>
        <p>Type a prompt below to start.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-6 px-6 py-12 text-center">
      <div className="flex flex-col items-center gap-3">
        <img
          src="./logo.png"
          alt=""
          width={64}
          height={64}
          className="h-16 w-16 rounded-2xl object-cover shadow-md ring-1 ring-border/60"
          draggable={false}
        />
        <MatrixTitle className="font-mono text-base uppercase tracking-[0.22em] text-emerald-500 dark:text-emerald-400" />
      </div>

      <p className="max-w-sm text-sm text-muted-foreground">
        Choose a project to work in, or add a new one. Sending a message opens a
        new chat session.
      </p>

      {recentProjects.length > 0 && (
        <ul className="flex w-full max-w-md flex-col gap-1.5">
          {recentProjects.slice(0, 6).map((p) => (
            <li key={p.cwd}>
              <button
                type="button"
                onClick={() => onOpenProject(p.cwd)}
                className="flex w-full flex-col items-start rounded-xl border border-border/80 bg-card/40 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/60"
              >
                <span className="text-sm font-medium text-foreground">
                  {p.project}
                </span>
                <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                  {p.cwd}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Button type="button" onClick={() => void onNewSession()}>
        {recentProjects.length > 0 ? "Add project…" : "Open project…"}
      </Button>
    </div>
  );
}
