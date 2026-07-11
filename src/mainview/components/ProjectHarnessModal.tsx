import { useCallback, useEffect, useState } from "react";
import type { ProjectHarness } from "../../shared/rpc";

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyId) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busyId, onClose]);

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="harness-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busyId) onClose();
      }}
    >
      <div className="flex h-[min(640px,90vh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[#333] bg-[#1a1a1a] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-[#2e2e2e] px-5 py-3">
          <div className="min-w-0">
            <h2
              id="harness-title"
              className="truncate text-sm font-semibold text-gray-100"
            >
              {title}
            </h2>
            <p className="mt-0.5 truncate text-xs text-gray-500">
              {harness?.cwd ? (
                <span title={harness.cwd}>{harness.cwd}</span>
              ) : (
                "Optimize how coding agents behave in this project"
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void onRefresh()}
              disabled={loading || !!busyId}
              className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200 disabled:opacity-40"
              title="Refresh"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-gray-500 hover:bg-[#2a2a2a] hover:text-gray-200"
              aria-label="Close harness"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="shrink-0 border-b border-[#2e2e2e] px-5 py-3">
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 ${
                applied > 0
                  ? "bg-emerald-950/60 text-emerald-400"
                  : "bg-[#252525] text-gray-500"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  applied > 0 ? "bg-emerald-400" : "bg-gray-600"
                }`}
              />
              {applied}/{total} applied
            </span>
            {harness?.hasAgentsMd && (
              <span className="text-gray-600">AGENTS.md present</span>
            )}
            {harness?.hasClaudeMd && (
              <span className="text-gray-600">CLAUDE.md present</span>
            )}
            {harness?.optimizations.some(
              (o) => o.id === "project-memory" && o.applied,
            ) && <span className="text-gray-600">docs/memory</span>}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-gray-500">
            The harness installs project-level agent setup: coding guidelines,
            sharded team memory + arc42 docs, Claude commands, and skills so
            agents (and teammates via git) share the same project knowledge.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && !harness && (
            <div className="py-10 text-center text-sm text-gray-500">
              Loading harness…
            </div>
          )}

          {displayError && (
            <div className="mb-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
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
                  className="rounded-xl border border-[#2e2e2e] bg-[#141414] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium text-gray-100">
                          {opt.name}
                        </h3>
                        {opt.applied ? (
                          <span className="rounded bg-emerald-950/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400">
                            Applied
                          </span>
                        ) : (
                          <span className="rounded bg-[#2a2a2a] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                            Not applied
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-gray-400">
                        {opt.description}
                      </p>
                      {opt.details && (
                        <p className="mt-2 font-mono text-[11px] text-gray-600">
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
                    <button
                      type="button"
                      disabled={!!busyId || !harness?.ok}
                      onClick={() => void handleApply(opt.id)}
                      className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        opt.applied
                          ? "border border-[#333] bg-transparent text-gray-300 hover:bg-[#252525]"
                          : "bg-blue-600 text-white hover:bg-blue-500"
                      }`}
                    >
                      {busy
                        ? "Applying…"
                        : opt.applied
                          ? "Re-apply"
                          : "Apply"}
                    </button>
                  </div>

                  {opt.id === "karpathy-guidelines" && (
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[#2a2a2a] pt-3">
                      {[
                        ["Think first", "Surface assumptions & tradeoffs"],
                        ["Simplicity", "Minimum code, no speculation"],
                        ["Surgical", "Touch only what you must"],
                        ["Goal-driven", "Verify with success criteria"],
                      ].map(([label, hint]) => (
                        <div
                          key={label}
                          className="rounded-md bg-[#1a1a1a] px-2.5 py-2"
                        >
                          <div className="text-[11px] font-medium text-gray-300">
                            {label}
                          </div>
                          <div className="mt-0.5 text-[10px] text-gray-600">
                            {hint}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {opt.id === "project-memory" && (
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[#2a2a2a] pt-3">
                      {[
                        ["INDEX.md", "Always-on catalog (keep small)"],
                        ["topics/", "Sharded durable team facts"],
                        ["journal/", "Raw capture → promote later"],
                        ["arc42", "docs/architecture + ADRs"],
                      ].map(([label, hint]) => (
                        <div
                          key={label}
                          className="rounded-md bg-[#1a1a1a] px-2.5 py-2"
                        >
                          <div className="text-[11px] font-medium text-gray-300">
                            {label}
                          </div>
                          <div className="mt-0.5 text-[10px] text-gray-600">
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

        <div className="shrink-0 border-t border-[#2e2e2e] px-5 py-3 text-[11px] text-gray-600">
          Applies to new agent sessions in this folder. Existing open sessions
          keep their current system context until restarted.
        </div>
      </div>
    </div>
  );
}
