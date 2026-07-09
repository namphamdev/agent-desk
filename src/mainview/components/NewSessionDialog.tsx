import { useEffect, useMemo, useState } from "react";
import type { AgentInfo, RecentProject } from "../../shared/rpc";

export type NewSessionOptions = {
  cwd: string;
  project?: string;
  title?: string;
  agentId?: string;
};

type Props = {
  agents: AgentInfo[];
  defaultAgentId: string | null;
  defaultCwd: string;
  recentProjects: RecentProject[];
  onPickFolder: (startingFolder?: string) => Promise<string | null>;
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
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        cwd: folder,
        project: projectNameFromPath(folder),
        title: title.trim() || undefined,
        agentId: agentId || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6"
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
              <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-[#2a2a2a] bg-[#121212] p-1">
                {recentProjects.map((p) => {
                  const active = p.cwd === cwd.trim();
                  return (
                    <button
                      key={p.cwd}
                      type="button"
                      onClick={() => {
                        setCwd(p.cwd);
                        setError(null);
                      }}
                      className={`flex w-full flex-col rounded px-2 py-1.5 text-left ${
                        active
                          ? "bg-[#2e2e2e] text-gray-100"
                          : "text-gray-300 hover:bg-[#1e1e1e]"
                      }`}
                    >
                      <span className="truncate text-xs font-medium">
                        {p.project}
                      </span>
                      <span className="truncate font-mono text-[10px] text-gray-500">
                        {p.cwd}
                      </span>
                    </button>
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
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 text-gray-200"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}

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
