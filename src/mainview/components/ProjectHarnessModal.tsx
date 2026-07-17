import { useCallback, useState } from "react";
import type { ProjectHarness } from "../../shared/rpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Props = {
  harness: ProjectHarness | null;
  loading?: boolean;
  error?: string | null;
  busyId?: string | null;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
  onApply: (optimizationId: string) => Promise<void>;
};

export function ProjectHarnessModal({
  harness,
  loading,
  error,
  busyId,
  onClose,
  onRefresh,
  onApply,
}: Props) {
  const [localError, setLocalError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const handleApply = useCallback(
    async (id: string) => {
      setLocalError(null);
      setFlash(null);
      try {
        await onApply(id);
        setFlash(
          "Applied — new sessions pick up project files (restart open agents to reload CLAUDE.md).",
        );
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : String(err));
      }
    },
    [onApply],
  );

  const displayError = localError || error;
  const title = harness?.project ? `AI Harness · ${harness.project}` : "AI Harness";
  const applied = harness?.appliedCount ?? 0;
  const total = harness?.optimizations.length ?? 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busyId) onClose();
      }}
    >
      <DialogContent
        showCloseButton={true}
        className="flex h-[min(640px,90vh)] w-full max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        onInteractOutside={(e) => {
          if (busyId) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (busyId) e.preventDefault();
        }}
      >
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between space-y-0 border-b border-border px-5 py-3 pr-12">
          <div className="min-w-0">
            <DialogTitle id="harness-title" className="truncate">
              {title}
            </DialogTitle>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {harness?.cwd ? (
                <span title={harness.cwd}>{harness.cwd}</span>
              ) : (
                "Optimize how coding agents behave in this project"
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void onRefresh()}
            disabled={loading || !!busyId}
            title="Refresh"
          >
            Refresh
          </Button>
        </DialogHeader>

        <div className="shrink-0 border-b border-border px-5 py-3">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
                applied > 0
                  ? "bg-emerald-950/60 text-emerald-400"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  applied > 0 ? "bg-emerald-400" : "bg-muted-foreground",
                )}
              />
              {applied}/{total} applied
            </span>
            {harness?.hasAgentsMd && (
              <span className="text-muted-foreground">AGENTS.md present</span>
            )}
            {harness?.hasClaudeMd && (
              <span className="text-muted-foreground">CLAUDE.md present</span>
            )}
            {harness?.optimizations.some(
              (o) => o.id === "project-memory" && o.applied,
            ) && <span className="text-muted-foreground">docs/memory</span>}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            The harness installs project-level agent setup: coding guidelines,
            sharded team memory + arc42 docs, Claude commands, and skills so
            agents (and teammates via git) share the same project knowledge.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && !harness && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Loading harness…
            </div>
          )}

          {displayError && (
            <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {displayError}
            </div>
          )}

          {flash && (
            <div className="mb-3 rounded-lg border border-emerald-900/40 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
              {flash}
            </div>
          )}

          {harness && !harness.ok && (
            <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-3 text-sm text-amber-200/90">
              {harness.error || "Cannot open harness for this project."}
            </div>
          )}

          <ul className="space-y-3">
            {(harness?.optimizations ?? []).map((opt) => {
              const busy = busyId === opt.id;
              return (
                <li
                  key={opt.id}
                  className="rounded-xl border border-border bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium text-foreground">
                          {opt.name}
                        </h3>
                        {opt.applied ? (
                          <span className="rounded bg-emerald-950/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400">
                            Applied
                          </span>
                        ) : (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            Not applied
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                        {opt.description}
                      </p>
                      {opt.details && (
                        <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                          {opt.details}
                        </p>
                      )}
                      <a
                        href={opt.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block text-[11px] text-blue-400/80 hover:text-blue-300"
                      >
                        {opt.sourceLabel} ↗
                      </a>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!!busyId || !harness?.ok}
                      onClick={() => void handleApply(opt.id)}
                      variant={opt.applied ? "outline" : "default"}
                      className="shrink-0"
                    >
                      {busy
                        ? "Applying…"
                        : opt.applied
                          ? "Re-apply"
                          : "Apply"}
                    </Button>
                  </div>

                  {opt.id === "karpathy-guidelines" && (
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3">
                      {[
                        ["Think first", "Surface assumptions & tradeoffs"],
                        ["Simplicity", "Minimum code, no speculation"],
                        ["Surgical", "Touch only what you must"],
                        ["Goal-driven", "Verify with success criteria"],
                      ].map(([label, hint]) => (
                        <div
                          key={label}
                          className="rounded-md bg-background px-2.5 py-2"
                        >
                          <div className="text-[11px] font-medium text-foreground/80">
                            {label}
                          </div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {hint}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {opt.id === "project-memory" && (
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3">
                      {[
                        ["INDEX.md", "Always-on catalog (keep small)"],
                        ["topics/", "Sharded durable team facts"],
                        ["journal/", "Raw capture → promote later"],
                        ["arc42", "docs/architecture + ADRs"],
                      ].map(([label, hint]) => (
                        <div
                          key={label}
                          className="rounded-md bg-background px-2.5 py-2"
                        >
                          <div className="text-[11px] font-medium text-foreground/80">
                            {label}
                          </div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {hint}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="shrink-0 border-t border-border px-5 py-3 text-[11px] text-muted-foreground">
          Applies to new agent sessions in this folder. Existing open sessions
          keep their current system context until restarted.
        </div>
      </DialogContent>
    </Dialog>
  );
}
