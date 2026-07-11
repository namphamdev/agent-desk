import { useEffect, useMemo, useState } from "react";
import type { AgentInfo, RecentProject } from "../../shared/rpc";
import { Select } from "./Select";

export type NewSessionOptions = {
  cwd: string;
  project?: string;
  title?: string;
  agentId?: string;
  /**
   * When set, create/reuse a git worktree for this branch and open the session there.
   * Shared dependency dirs are symlinked from the main project (see Settings).
   */
  worktree?: {
    branch: string;
    createBranch?: boolean;
  };
};

type Props = {
  agents: AgentInfo[];
  defaultAgentId: string | null;
  defaultCwd: string;
  recentProjects: RecentProject[];
  onPickFolder: (startingFolder?: string) => Promise<string | null>;
  onRemoveRecent: (cwd: string) => void | Promise<void>;
  onCancel: () => void;
  onCreate: (opts: NewSessionOptions) => void | Promise<void>;
};

function projectNameFromPath(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned || "project";
}

export function NewSessionDialog({
  agents,
  defaultAgentId,
  defaultCwd,
  recentProjects,
  onPickFolder,
  onRemoveRecent,
  onCancel,
  onCreate,
}: Props) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState(
    defaultAgentId && agents.some((a) => a.id === defaultAgentId)
      ? defaultAgentId
      : agents[0]?.id ?? "",
  );
  const [useWorktree, setUseWorktree] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [createBranch, setCreateBranch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const project = useMemo(() => projectNameFromPath(cwd.trim()), [cwd]);

  const browse = async () => {
    setPicking(true);
    setError(null);
    try {
      const path = await onPickFolder(cwd.trim() || undefined);
      if (path?.trim()) {
        setCwd(path.trim());
        setError(null);
      }
      // cancelled → leave cwd unchanged, no error
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        /timed out/i.test(message)
          ? "Folder picker timed out. Try again, or paste the path above."
          : message,
      );
    } finally {
      setPicking(false);
    }
  };

  const submit = async () => {
    const folder = cwd.trim();
    if (!folder) {
      setError("Choose a project folder to continue.");
      return;
    }
    if (useWorktree && !worktreeBranch.trim()) {
      setError("Enter a branch name for the worktree.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        cwd: folder,
        project: projectNameFromPath(folder),
        title: title.trim() || undefined,
        agentId: agentId || undefined,
        worktree: useWorktree
          ? {
              branch: worktreeBranch.trim(),
              createBranch,
            }
          : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-session-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-[#333] bg-[#1a1a1a] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#2e2e2e] px-5 py-3">
          <h2 id="new-session-title" className="text-sm font-semibold text-gray-100">
            New session
          </h2>
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded p-1 text-gray-500 hover:bg-[#2a2a2a] hover:text-gray-200 disabled:opacity-50"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">
              Project folder
            </label>
            <div className="flex gap-2">
              <input
                value={cwd}
                onChange={(e) => {
                  setCwd(e.target.value);
                  setError(null);
                }}
                placeholder="/path/to/your/project"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 font-mono text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-500"
                autoFocus
              />
              <button
                type="button"
                onClick={() => void browse()}
                disabled={picking || busy}
                className="shrink-0 rounded-md border border-[#333] bg-[#222] px-3 py-1.5 text-xs text-gray-200 hover:bg-[#2a2a2a] disabled:opacity-50"
              >
                {picking ? "…" : "Browse…"}
              </button>
            </div>
            {cwd.trim() && (
              <p className="mt-1.5 text-[11px] text-gray-500">
                Project name:{" "}
                <span className="text-gray-300">{project}</span>
              </p>
            )}
          </div>

          {recentProjects.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-gray-400">
                Recent projects
              </div>
              <div className="max-h-36 space-y-0.5 overflow-x-hidden overflow-y-auto rounded-md border border-[#2a2a2a] bg-[#121212] p-1">
                {recentProjects.map((p) => {
                  const active = p.cwd === cwd.trim();
                  return (
                    <div
                      key={p.cwd}
                      className={`group flex min-w-0 items-start gap-1 rounded ${
                        active
                          ? "bg-[#2e2e2e] text-gray-100"
                          : "text-gray-300 hover:bg-[#1e1e1e]"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setCwd(p.cwd);
                          setError(null);
                        }}
                        className="min-w-0 flex-1 flex flex-col px-2 py-1.5 text-left"
                      >
                        <span className="break-words text-xs font-medium">
                          {p.project}
                        </span>
                        <span className="break-all font-mono text-[10px] text-gray-500">
                          {p.cwd}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${p.project} from recent projects`}
                        title="Remove from recents"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onRemoveRecent(p.cwd);
                          if (cwd.trim() === p.cwd) {
                            setCwd("");
                          }
                        }}
                        className="mt-1.5 mr-1 shrink-0 rounded p-1 text-gray-600 opacity-0 transition-opacity hover:bg-[#2a2a2a] hover:text-gray-200 group-hover:opacity-100 focus:opacity-100 disabled:opacity-40"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">
              Title <span className="font-normal text-gray-600">(optional)</span>
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="New session"
              className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-500"
            />
          </div>

          {agents.length > 0 && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-400">
                Agent
              </label>
              <Select
                value={agentId}
                options={agents.map((a) => ({ value: a.id, label: a.name }))}
                onChange={setAgentId}
                aria-label="Agent"
              />
            </div>
          )}

          <div className="rounded-md border border-[#2a2a2a] bg-[#141414] px-3 py-2.5">
            <label className="flex items-start gap-2 text-gray-300">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={(e) => {
                  setUseWorktree(e.target.checked);
                  setError(null);
                }}
                disabled={busy}
                className="mt-0.5 rounded border-[#444]"
              />
              <span>
                <span className="block text-xs font-medium">
                  Open in git worktree
                </span>
                <span className="mt-0.5 block text-[11px] text-gray-500">
                  Isolated checkout for the branch. Shared paths (e.g.{" "}
                  <span className="font-mono text-gray-400">node_modules</span>
                  ) are symlinked from the main project — configure them in
                  Settings.
                </span>
              </span>
            </label>
            {useWorktree && (
              <div className="mt-3 space-y-2 border-t border-[#2a2a2a] pt-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-400">
                    Branch
                  </label>
                  <input
                    value={worktreeBranch}
                    onChange={(e) => {
                      setWorktreeBranch(e.target.value);
                      setError(null);
                    }}
                    placeholder="feature/my-task"
                    spellCheck={false}
                    disabled={busy}
                    className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 font-mono text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:opacity-50"
                  />
                </div>
                <label className="flex items-center gap-2 text-[11px] text-gray-400">
                  <input
                    type="checkbox"
                    checked={createBranch}
                    onChange={(e) => setCreateBranch(e.target.checked)}
                    disabled={busy}
                    className="rounded border-[#444]"
                  />
                  Create branch if it does not exist
                </label>
              </div>
            )}
          </div>

          {error && (
            <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[#2e2e2e] px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-xs text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !cwd.trim()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? "Starting…" : "Start chat"}
          </button>
        </div>
      </div>
    </div>
  );
}
