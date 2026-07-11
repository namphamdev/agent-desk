import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandRunSummary, SavedCommand } from "../../shared/rpc";

type Props = {
  commands: SavedCommand[];
  runs: CommandRunSummary[];
  loading?: boolean;
  error?: string | null;
  busyId?: string | null;
  /** Project folder these commands belong to (run cwd). */
  projectCwd?: string | null;
  projectName?: string | null;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
  onAdd: (input: { name: string; command: string }) => Promise<void>;
  onRemove: (commandId: string) => Promise<void>;
  onRun: (commandId: string) => Promise<CommandRunSummary | null>;
  onStop: (runId: string) => Promise<void>;
  onLoadLog: (
    runId: string,
  ) => Promise<{ log: string; truncated: boolean; run: CommandRunSummary } | null>;
};

function statusLabel(run: CommandRunSummary): string {
  if (run.status === "running") return "running";
  if (run.status === "killed") return "killed";
  if (run.status === "error") return "error";
  if (run.exitCode === 0) return "ok";
  if (run.exitCode != null) return `exit ${run.exitCode}`;
  return run.status;
}

function statusClass(run: CommandRunSummary): string {
  if (run.status === "running") return "text-blue-400";
  if (run.status === "killed") return "text-amber-400";
  if (run.status === "error") return "text-red-400";
  if (run.exitCode === 0) return "text-emerald-400";
  if (run.exitCode != null) return "text-red-400";
  return "text-gray-400";
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function CommandPanel({
  commands,
  runs,
  loading,
  error,
  busyId,
  projectCwd,
  projectName,
  onClose,
  onRefresh,
  onAdd,
  onRemove,
  onRun,
  onStop,
  onLoadLog,
}: Props) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [adding, setAdding] = useState(false);
  const hasProject = Boolean(projectCwd?.trim());
  const [localError, setLocalError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [logText, setLogText] = useState("");
  const [logTruncated, setLogTruncated] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const logEndRef = useRef<HTMLPreElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !adding) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adding, onClose]);

  const refreshLog = useCallback(
    async (runId: string, silent = false) => {
      if (!silent) setLogLoading(true);
      try {
        const res = await onLoadLog(runId);
        if (!res) return;
        setLogText(res.log);
        setLogTruncated(res.truncated);
      } finally {
        if (!silent) setLogLoading(false);
      }
    },
    [onLoadLog],
  );

  // Poll selected run while it is running.
  useEffect(() => {
    if (!selectedRunId) return;
    void refreshLog(selectedRunId);
    const run = runs.find((r) => r.id === selectedRunId);
    if (run?.status !== "running") return;
    const t = setInterval(() => {
      void onRefresh();
      void refreshLog(selectedRunId, true);
    }, 500);
    return () => clearInterval(t);
  }, [selectedRunId, runs, onRefresh, refreshLog]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const el = logEndRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logText]);

  const handleAdd = useCallback(async () => {
    if (adding || !hasProject) return;
    setAdding(true);
    setLocalError(null);
    try {
      await onAdd({
        name: name.trim(),
        command: command.trim(),
      });
      setName("");
      setCommand("");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }, [adding, hasProject, name, command, onAdd]);

  const handleRun = useCallback(
    async (commandId: string) => {
      setLocalError(null);
      try {
        const run = await onRun(commandId);
        if (run) {
          setSelectedRunId(run.id);
          setLogText("");
        }
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : String(err));
      }
    },
    [onRun],
  );

  const displayError = localError || error;
  const selectedRun = selectedRunId
    ? runs.find((r) => r.id === selectedRunId) ?? null
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="commands-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !adding) onClose();
      }}
    >
      <div className="flex h-[min(720px,92vh)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[#333] bg-[#1a1a1a] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-[#2e2e2e] px-5 py-3">
          <div>
            <h2
              id="commands-title"
              className="text-sm font-semibold text-gray-100"
            >
              Project commands
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {hasProject ? (
                <>
                  {projectName ? (
                    <span className="text-gray-300">{projectName}</span>
                  ) : null}
                  {projectName ? " · " : null}
                  <code className="text-gray-500">{projectCwd}</code>
                  {" · "}
                  {commands.length} saved ·{" "}
                  {runs.filter((r) => r.status === "running").length} running
                </>
              ) : (
                "No project selected"
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onRefresh()}
              disabled={loading || adding}
              className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200 disabled:opacity-40"
              title="Refresh"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-gray-500 hover:bg-[#2a2a2a] hover:text-gray-200"
              aria-label="Close commands"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
          {/* Left: add + list */}
          <div className="flex min-h-0 flex-col border-b border-[#2e2e2e] md:border-b-0 md:border-r">
            <div className="shrink-0 space-y-2 border-b border-[#2e2e2e] px-4 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
                Add command for this project
              </div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name (e.g. Run tests)"
                disabled={adding || !hasProject}
                className="w-full rounded-md border border-[#333] bg-[#161616] px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:opacity-50"
              />
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    void handleAdd();
                  }
                }}
                placeholder="Shell command (e.g. bun test)"
                disabled={adding || !hasProject}
                className="w-full rounded-md border border-[#333] bg-[#161616] px-3 py-1.5 font-mono text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:opacity-50"
              />
              <p className="text-[10px] leading-relaxed text-gray-600">
                Runs in the project folder. Commands are not shared across
                projects.
              </p>
              <button
                type="button"
                onClick={() => void handleAdd()}
                disabled={
                  adding || !hasProject || !name.trim() || !command.trim()
                }
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {adding ? "Adding…" : "Add"}
              </button>
            </div>

            {displayError && (
              <div className="mx-4 mt-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                {displayError}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {!hasProject ? (
                <div className="px-3 py-8 text-center text-xs text-gray-500">
                  Open a session in a project folder to add and run commands for
                  that project.
                </div>
              ) : loading && commands.length === 0 ? (
                <div className="py-8 text-center text-xs text-gray-500">
                  Loading…
                </div>
              ) : commands.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-gray-500">
                  No commands for this project yet. Add one above, then Run.
                </div>
              ) : (
                <ul className="space-y-1">
                  {commands.map((c) => (
                    <li
                      key={c.id}
                      className="group rounded-lg border border-transparent px-3 py-2 hover:border-[#333] hover:bg-[#222]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-gray-100">
                            {c.name}
                          </div>
                          <code className="mt-0.5 block truncate font-mono text-[11px] text-gray-500">
                            {c.command}
                          </code>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            disabled={busyId === c.id}
                            onClick={() => void handleRun(c.id)}
                            className="rounded bg-emerald-700/80 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
                          >
                            Run
                          </button>
                          <button
                            type="button"
                            disabled={busyId === c.id}
                            onClick={() => void onRemove(c.id)}
                            className="rounded px-2 py-1 text-[11px] text-gray-500 hover:bg-[#2a2a2a] hover:text-red-400 disabled:opacity-40"
                            title="Remove"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="shrink-0 border-t border-[#2e2e2e] px-3 py-2">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                Recent runs
              </div>
              {runs.length === 0 ? (
                <div className="py-2 text-[11px] text-gray-600">
                  No runs yet.
                </div>
              ) : (
                <ul className="max-h-36 space-y-0.5 overflow-y-auto">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedRunId(r.id)}
                        className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-[#2a2a2a] ${
                          selectedRunId === r.id ? "bg-[#252525]" : ""
                        }`}
                      >
                        <span className="min-w-0 truncate text-gray-300">
                          {r.commandName}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className={statusClass(r)}>
                            {statusLabel(r)}
                          </span>
                          <span className="text-gray-600">
                            {timeAgo(r.startedAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Right: log viewer */}
          <div className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-[#2e2e2e] px-4 py-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-gray-200">
                  {selectedRun ? selectedRun.commandName : "Log"}
                </div>
                {selectedRun && (
                  <div className="truncate font-mono text-[10px] text-gray-600">
                    {selectedRun.command}
                    {" · "}
                    <span className={statusClass(selectedRun)}>
                      {statusLabel(selectedRun)}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {selectedRun?.status === "running" && (
                  <button
                    type="button"
                    onClick={() => void onStop(selectedRun.id)}
                    className="rounded border border-red-900/50 bg-red-950/40 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/70"
                  >
                    Stop
                  </button>
                )}
                {selectedRun && (
                  <button
                    type="button"
                    onClick={() => void refreshLog(selectedRun.id)}
                    className="rounded px-2 py-1 text-[11px] text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200"
                  >
                    Reload
                  </button>
                )}
              </div>
            </div>
            {!selectedRun ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-gray-600">
                Run a command or select a recent run to view its log.
              </div>
            ) : (
              <>
                {logTruncated && (
                  <div className="shrink-0 bg-amber-950/30 px-3 py-1 text-[10px] text-amber-400/90">
                    Log truncated (kept most recent output)
                  </div>
                )}
                <pre
                  ref={logEndRef}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    const dist =
                      el.scrollHeight - el.scrollTop - el.clientHeight;
                    stickToBottom.current = dist < 40;
                  }}
                  className="min-h-0 flex-1 overflow-auto bg-[#0e0e0e] px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-300 whitespace-pre-wrap break-words"
                >
                  {logLoading && !logText
                    ? "Loading log…"
                    : logText ||
                      (selectedRun.status === "running"
                        ? "Waiting for output…"
                        : "(no output)")}
                </pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
