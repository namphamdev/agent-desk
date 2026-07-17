import { useEffect, useMemo, useState } from "react";
import { RiCloseLine, RiDeleteBinLine } from "react-icons/ri";
import type { AgentInfo, RecentProject } from "../../shared/rpc";
import {
  BUILTIN_WORKFLOWS,
  type WorkflowDefinition,
  type WorkflowId,
  workflowSessionTitle,
} from "../../session/workflows";
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
  /**
   * When set, auto-send a workflow-specific first prompt after the session
   * is created (harness-aware: memory INDEX, architecture, AGENTS.md).
   */
  workflow?: {
    id: WorkflowId;
    task: string;
    prRef?: string;
  };
};

type Props = {
  agents: AgentInfo[];
  defaultAgentId: string | null;
  defaultCwd: string;
  recentProjects: RecentProject[];
  /**
   * When true (e.g. New task from a project menu), hide project folder picker
   * and recent projects — cwd is already fixed.
   */
  lockProject?: boolean;
  /** Resolved workflows for the selected project (project → global → built-in). */
  workflows?: readonly WorkflowDefinition[];
  /** Notify parent when project folder changes so workflows can re-resolve. */
  onProjectCwdChange?: (cwd: string) => void;
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
  lockProject = false,
  workflows: workflowsProp,
  onProjectCwdChange,
  onPickFolder,
  onRemoveRecent,
  onCancel,
  onCreate,
}: Props) {
  const workflows = workflowsProp?.length ? workflowsProp : BUILTIN_WORKFLOWS;
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
  /** null = free chat (no auto-prompt). */
  const [workflowId, setWorkflowId] = useState<WorkflowId | null>(null);
  const [task, setTask] = useState("");
  const [prRef, setPrRef] = useState("");
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
  const selectedWorkflow = useMemo(
    () => (workflowId ? workflows.find((w) => w.id === workflowId) : null),
    [workflowId, workflows],
  );

  useEffect(() => {
    if (workflowId && !workflows.some((w) => w.id === workflowId)) {
      setWorkflowId(null);
    }
  }, [workflows, workflowId]);

  useEffect(() => {
    onProjectCwdChange?.(cwd.trim());
  }, [cwd, onProjectCwdChange]);

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
    if (workflowId) {
      const wf = workflows.find((w) => w.id === workflowId);
      if (wf?.needsPrRef) {
        if (!prRef.trim() && !task.trim()) {
          setError("Enter a PR URL/number or review notes to continue.");
          return;
        }
      } else if (!task.trim()) {
        setError("Describe the task for this workflow.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const workflow =
        workflowId != null
          ? {
              id: workflowId,
              task: task.trim(),
              prRef: prRef.trim() || undefined,
            }
          : undefined;

      const sessionTitle =
        title.trim() ||
        (workflow
          ? workflowSessionTitle(
              workflows.find((w) => w.id === workflow.id) ?? workflow.id,
              workflow.task,
              workflow.prRef,
              workflows,
            )
          : undefined);

      await onCreate({
        cwd: folder,
        project: projectNameFromPath(folder),
        title: sessionTitle,
        agentId: agentId || undefined,
        worktree: useWorktree
          ? {
              branch: worktreeBranch.trim(),
              createBranch,
            }
          : undefined,
        workflow,
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
      <div className="flex max-h-[min(720px,90vh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[#333] bg-[#1a1a1a] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-[#2e2e2e] px-5 py-3">
          <div className="min-w-0">
            <h2 id="new-session-title" className="text-sm font-semibold text-gray-100">
              New task
            </h2>
            {lockProject && cwd.trim() && (
              <p className="mt-0.5 truncate text-xs text-gray-500" title={cwd}>
                {project}
              </p>
            )}
          </div>
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded p-1 text-gray-500 hover:bg-[#2a2a2a] hover:text-gray-200 disabled:opacity-50"
            aria-label="Close"
          >
            <RiCloseLine className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          {!lockProject && (
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
          )}

          {!lockProject && recentProjects.length > 0 && (
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
                        <RiDeleteBinLine
                          className="h-3 w-3"
                          aria-hidden
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-400">
              Workflow
            </div>
            <div
              className="grid grid-cols-2 gap-1.5"
              role="radiogroup"
              aria-label="Workflow"
            >
              <button
                type="button"
                role="radio"
                aria-checked={workflowId === null}
                disabled={busy}
                onClick={() => {
                  setWorkflowId(null);
                  setError(null);
                }}
                className={`rounded-md border px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${
                  workflowId === null
                    ? "border-blue-600/70 bg-blue-950/40 text-gray-100"
                    : "border-[#2a2a2a] bg-[#141414] text-gray-300 hover:border-[#3a3a3a] hover:bg-[#1a1a1a]"
                }`}
              >
                <span className="block text-xs font-medium">Free chat</span>
                <span className="mt-0.5 block text-[10px] leading-snug text-gray-500">
                  Empty session — type your own prompt
                </span>
              </button>
              {workflows.map((w) => {
                const active = workflowId === w.id;
                return (
                  <button
                    key={w.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={busy}
                    onClick={() => {
                      setWorkflowId(w.id);
                      setError(null);
                    }}
                    className={`rounded-md border px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${
                      active
                        ? "border-blue-600/70 bg-blue-950/40 text-gray-100"
                        : "border-[#2a2a2a] bg-[#141414] text-gray-300 hover:border-[#3a3a3a] hover:bg-[#1a1a1a]"
                    }`}
                  >
                    <span className="block text-xs font-medium">{w.label}</span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-gray-500">
                      {w.description}
                    </span>
                  </button>
                );
              })}
            </div>
            {selectedWorkflow && (
              <p className="mt-2 text-[11px] text-gray-500">
                Starts with a harness-aware prompt (memory INDEX, architecture,
                AGENTS.md) tailored to this workflow.
              </p>
            )}
          </div>

          {selectedWorkflow && (
            <div className="space-y-3">
              {selectedWorkflow.needsPrRef && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-400">
                    PR URL or number
                  </label>
                  <input
                    value={prRef}
                    onChange={(e) => {
                      setPrRef(e.target.value);
                      setError(null);
                    }}
                    placeholder="#42 or https://github.com/org/repo/pull/42"
                    spellCheck={false}
                    disabled={busy}
                    className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 font-mono text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:opacity-50"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-400">
                  {selectedWorkflow.needsPrRef
                    ? "Review notes"
                    : "Task"}{" "}
                  {!selectedWorkflow.needsPrRef && (
                    <span className="font-normal text-red-400/80">*</span>
                  )}
                  {selectedWorkflow.needsPrRef && (
                    <span className="font-normal text-gray-600">
                      (optional if PR is set)
                    </span>
                  )}
                </label>
                <textarea
                  value={task}
                  onChange={(e) => {
                    setTask(e.target.value);
                    setError(null);
                  }}
                  placeholder={selectedWorkflow.taskPlaceholder}
                  rows={3}
                  disabled={busy}
                  className="w-full resize-y rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:opacity-50"
                />
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">
              Title{" "}
              <span className="font-normal text-gray-600">
                (optional
                {selectedWorkflow ? "; defaults from workflow" : ""})
              </span>
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                selectedWorkflow
                  ? workflowSessionTitle(
                      selectedWorkflow,
                      task,
                      prRef || undefined,
                      workflows,
                    )
                  : "New session"
              }
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

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[#2e2e2e] px-5 py-3">
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
            {busy
              ? "Starting…"
              : selectedWorkflow
                ? "Start workflow"
                : "Start chat"}
          </button>
        </div>
      </div>
    </div>
  );
}
