import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import type { AgentInfo, RecentProject } from "../../shared/rpc";
import {
  BUILTIN_WORKFLOWS,
  type WorkflowDefinition,
  type WorkflowId,
  workflowSessionTitle,
} from "../../session/workflows";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={true}
        className="flex max-h-[min(720px,90vh)] w-full max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        onInteractOutside={(e) => {
          if (busy) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 space-y-0 border-b border-border px-5 py-3 pr-12">
          <div className="min-w-0">
            <DialogTitle id="new-session-title">New task</DialogTitle>
            {lockProject && cwd.trim() && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground" title={cwd}>
                {project}
              </p>
            )}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          {!lockProject && (
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Project folder
            </label>
            <div className="flex gap-2">
              <Input
                value={cwd}
                onChange={(e) => {
                  setCwd(e.target.value);
                  setError(null);
                }}
                placeholder="/path/to/your/project"
                spellCheck={false}
                className="min-w-0 flex-1 font-mono text-xs"
                autoFocus
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void browse()}
                disabled={picking || busy}
                className="shrink-0"
              >
                {picking ? "…" : "Browse…"}
              </Button>
            </div>
            {cwd.trim() && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Project name:{" "}
                <span className="text-foreground">{project}</span>
              </p>
            )}
          </div>
          )}

          {!lockProject && recentProjects.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                Recent projects
              </div>
              <div className="max-h-36 space-y-0.5 overflow-x-hidden overflow-y-auto rounded-md border border-border bg-muted/30 p-1">
                {recentProjects.map((p) => {
                  const active = p.cwd === cwd.trim();
                  return (
                    <div
                      key={p.cwd}
                      className={cn(
                        "group flex min-w-0 items-start gap-1 rounded",
                        active
                          ? "bg-accent text-foreground"
                          : "text-foreground/80 hover:bg-accent/50",
                      )}
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
                        <span className="break-all font-mono text-[10px] text-muted-foreground">
                          {p.cwd}
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
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
                        className="mt-1.5 mr-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                      >
                        <Trash2
                          className="h-3 w-3"
                          aria-hidden
                        />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">
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
                className={cn(
                  "rounded-md border px-2.5 py-2 text-left transition-colors disabled:opacity-50",
                  workflowId === null
                    ? "border-primary/70 bg-primary/10 text-foreground"
                    : "border-border bg-card text-foreground/80 hover:border-border hover:bg-accent/50",
                )}
              >
                <span className="block text-xs font-medium">Free chat</span>
                <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
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
                    className={cn(
                      "rounded-md border px-2.5 py-2 text-left transition-colors disabled:opacity-50",
                      active
                        ? "border-primary/70 bg-primary/10 text-foreground"
                        : "border-border bg-card text-foreground/80 hover:border-border hover:bg-accent/50",
                    )}
                  >
                    <span className="block text-xs font-medium">{w.label}</span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                      {w.description}
                    </span>
                  </button>
                );
              })}
            </div>
            {selectedWorkflow && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Starts with a harness-aware prompt (memory INDEX, architecture,
                AGENTS.md) tailored to this workflow.
              </p>
            )}
          </div>

          {selectedWorkflow && (
            <div className="space-y-3">
              {selectedWorkflow.needsPrRef && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    PR URL or number
                  </label>
                  <Input
                    value={prRef}
                    onChange={(e) => {
                      setPrRef(e.target.value);
                      setError(null);
                    }}
                    placeholder="#42 or https://github.com/org/repo/pull/42"
                    spellCheck={false}
                    disabled={busy}
                    className="font-mono text-xs"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {selectedWorkflow.needsPrRef
                    ? "Review notes"
                    : "Task"}{" "}
                  {!selectedWorkflow.needsPrRef && (
                    <span className="font-normal text-destructive/80">*</span>
                  )}
                  {selectedWorkflow.needsPrRef && (
                    <span className="font-normal text-muted-foreground/70">
                      (optional if PR is set)
                    </span>
                  )}
                </label>
                <Textarea
                  value={task}
                  onChange={(e) => {
                    setTask(e.target.value);
                    setError(null);
                  }}
                  placeholder={selectedWorkflow.taskPlaceholder}
                  rows={3}
                  disabled={busy}
                  className="resize-y text-xs"
                />
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Title{" "}
              <span className="font-normal text-muted-foreground/70">
                (optional
                {selectedWorkflow ? "; defaults from workflow" : ""})
              </span>
            </label>
            <Input
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
            />
          </div>

          {agents.length > 0 && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
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

          <div className="rounded-md border border-border bg-card px-3 py-2.5">
            <label className="flex items-start gap-2 text-foreground/90">
              <Checkbox
                checked={useWorktree}
                onCheckedChange={(checked) => {
                  setUseWorktree(checked === true);
                  setError(null);
                }}
                disabled={busy}
                className="mt-0.5"
              />
              <span>
                <span className="block text-xs font-medium">
                  Open in git worktree
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  Isolated checkout for the branch. Shared paths (e.g.{" "}
                  <span className="font-mono text-muted-foreground">node_modules</span>
                  ) are symlinked from the main project — configure them in
                  Settings.
                </span>
              </span>
            </label>
            {useWorktree && (
              <div className="mt-3 space-y-2 border-t border-border pt-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Branch
                  </label>
                  <Input
                    value={worktreeBranch}
                    onChange={(e) => {
                      setWorktreeBranch(e.target.value);
                      setError(null);
                    }}
                    placeholder="feature/my-task"
                    spellCheck={false}
                    disabled={busy}
                    className="font-mono text-xs"
                  />
                </div>
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Checkbox
                    checked={createBranch}
                    onCheckedChange={(checked) =>
                      setCreateBranch(checked === true)
                    }
                    disabled={busy}
                  />
                  Create branch if it does not exist
                </label>
              </div>
            )}
          </div>

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="mx-0 mb-0 shrink-0 sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={busy || !cwd.trim()}
          >
            {busy
              ? "Starting…"
              : selectedWorkflow
                ? "Start workflow"
                : "Start chat"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
