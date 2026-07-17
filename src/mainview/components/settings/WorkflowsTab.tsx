import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  cloneBuiltinWorkflows,
  createEmptyWorkflow,
  type WorkflowDefinition,
} from "../../../session/workflows";
import type { AppSettings } from "../../../shared/rpc";
import { getRpc } from "../../rpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Field } from "./Field";

type Scope = "global" | "project";

type Props = {
  draft: AppSettings;
  setDraft: Dispatch<SetStateAction<AppSettings>>;
  /** Active / last project folder for project workflow editing. */
  projectCwd?: string | null;
  projectName?: string | null;
};

function workflowSummary(w: WorkflowDefinition): string {
  return w.description?.trim() || w.taskPlaceholder || w.id;
}

export function WorkflowsTab({
  draft,
  setDraft,
  projectCwd,
  projectName,
}: Props) {
  const [scope, setScope] = useState<Scope>("global");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [projectWorkflows, setProjectWorkflows] = useState<
    WorkflowDefinition[]
  >([]);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectExists, setProjectExists] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectMessage, setProjectMessage] = useState<string | null>(null);
  const [projectDirty, setProjectDirty] = useState(false);

  const globalWorkflows = draft.workflows ?? [];
  const hasProject = Boolean(projectCwd?.trim());

  const loadProject = useCallback(async () => {
    const cwd = projectCwd?.trim();
    if (!cwd) {
      setProjectWorkflows([]);
      setProjectPath(null);
      setProjectExists(false);
      setProjectDirty(false);
      setProjectMessage(null);
      return;
    }
    setProjectLoading(true);
    setProjectMessage(null);
    try {
      const res = await getRpc().request.getProjectWorkflows({ cwd });
      setProjectPath(res.path);
      setProjectExists(res.exists);
      setProjectWorkflows(res.workflows ? res.workflows.map((w) => ({ ...w })) : []);
      setProjectDirty(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProjectMessage(message || "Failed to load project workflows");
    } finally {
      setProjectLoading(false);
    }
  }, [projectCwd]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => {
    if (scope === "project" && !hasProject) setScope("global");
  }, [scope, hasProject]);

  const list = scope === "global" ? globalWorkflows : projectWorkflows;

  useEffect(() => {
    if (list.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !list.some((w) => w.id === selectedId)) {
      setSelectedId(list[0]?.id ?? null);
    }
  }, [list, selectedId]);

  const selected = useMemo(
    () => list.find((w) => w.id === selectedId) ?? null,
    [list, selectedId],
  );

  const updateGlobal = (next: WorkflowDefinition[]) => {
    setDraft((d) => ({ ...d, workflows: next }));
  };

  const updateProject = (next: WorkflowDefinition[]) => {
    setProjectWorkflows(next);
    setProjectDirty(true);
    setProjectMessage(null);
  };

  const updateList = (next: WorkflowDefinition[]) => {
    if (scope === "global") updateGlobal(next);
    else updateProject(next);
  };

  const patchSelected = (patch: Partial<WorkflowDefinition>) => {
    if (!selected) return;
    updateList(
      list.map((w) => (w.id === selected.id ? { ...w, ...patch } : w)),
    );
  };

  const addWorkflow = () => {
    const w = createEmptyWorkflow();
    updateList([...list, w]);
    setSelectedId(w.id);
  };

  const removeSelected = () => {
    if (!selected) return;
    const next = list.filter((w) => w.id !== selected.id);
    updateList(next);
    setSelectedId(next[0]?.id ?? null);
  };

  const resetGlobalToBuiltins = () => {
    updateGlobal(cloneBuiltinWorkflows());
    setSelectedId(cloneBuiltinWorkflows()[0]?.id ?? null);
  };

  const clearGlobalOverrides = () => {
    updateGlobal([]);
    setSelectedId(null);
  };

  const seedProjectFromEffective = () => {
    const seed =
      globalWorkflows.length > 0
        ? globalWorkflows.map((w) => ({ ...w }))
        : cloneBuiltinWorkflows();
    updateProject(seed);
    setSelectedId(seed[0]?.id ?? null);
  };

  const saveProject = async () => {
    const cwd = projectCwd?.trim();
    if (!cwd) return;
    setProjectSaving(true);
    setProjectMessage(null);
    try {
      const res = await getRpc().request.saveProjectWorkflows({
        cwd,
        workflows: projectWorkflows,
      });
      if (!res.ok) {
        setProjectMessage(res.error || "Failed to save");
        return;
      }
      setProjectPath(res.path);
      setProjectExists(res.workflows != null);
      setProjectWorkflows(res.workflows ? res.workflows.map((w) => ({ ...w })) : []);
      setProjectDirty(false);
      setProjectMessage(
        res.workflows
          ? `Saved ${res.workflows.length} project workflow(s).`
          : "Cleared project workflows (using global/built-ins).",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProjectMessage(message || "Failed to save");
    } finally {
      setProjectSaving(false);
    }
  };

  const clearProjectFile = async () => {
    const cwd = projectCwd?.trim();
    if (!cwd) return;
    setProjectWorkflows([]);
    setProjectDirty(true);
    setProjectSaving(true);
    setProjectMessage(null);
    try {
      const res = await getRpc().request.saveProjectWorkflows({
        cwd,
        workflows: [],
      });
      if (!res.ok) {
        setProjectMessage(res.error || "Failed to clear");
        return;
      }
      setProjectPath(res.path);
      setProjectExists(false);
      setProjectDirty(false);
      setProjectMessage("Project workflows removed — using global/built-ins.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProjectMessage(message || "Failed to clear");
    } finally {
      setProjectSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Workflows
        </span>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Customize New-task modes and their first prompts. Placeholders:{" "}
          <code className="text-muted-foreground">{"{{task}}"}</code>,{" "}
          <code className="text-muted-foreground">{"{{prRef}}"}</code>. Project file
          fully replaces global/built-ins when non-empty.
        </p>
      </div>

      <div
        className="flex gap-1 rounded-lg border border-border bg-background p-0.5"
        role="tablist"
        aria-label="Workflow scope"
      >
        <Button
          type="button"
          role="tab"
          variant="ghost"
          size="sm"
          aria-selected={scope === "global"}
          onClick={() => setScope("global")}
          className={cn(
            "flex-1",
            scope === "global"
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Global defaults
        </Button>
        <Button
          type="button"
          role="tab"
          variant="ghost"
          size="sm"
          aria-selected={scope === "project"}
          disabled={!hasProject}
          onClick={() => hasProject && setScope("project")}
          title={
            hasProject
              ? projectName || projectCwd || "Project"
              : "Open or pick a project first"
          }
          className={cn(
            "flex-1",
            scope === "project"
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          This project
        </Button>
      </div>

      {scope === "global" && (
        <p className="text-[11px] text-muted-foreground">
          {globalWorkflows.length === 0
            ? "Using built-in workflows (no global overrides). Edit below and Save settings, or reset to built-ins as an explicit override list."
            : `${globalWorkflows.length} global override(s). Empty the list to restore built-ins.`}
        </p>
      )}

      {scope === "project" && (
        <div className="space-y-1.5">
          <p className="truncate text-[11px] text-muted-foreground" title={projectCwd ?? undefined}>
            {projectName ? (
              <>
                Project: <span className="text-foreground/80">{projectName}</span>
              </>
            ) : (
              "Project"
            )}{" "}
            ·{" "}
            <span className="font-mono text-[10px] text-muted-foreground">
              {projectPath ?? ".terminal-react/workflows.json"}
            </span>
          </p>
          {projectLoading && (
            <p className="text-[11px] text-muted-foreground">Loading…</p>
          )}
          {!projectLoading && projectWorkflows.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              {projectExists
                ? "Project file is empty or invalid — New task uses global/built-ins."
                : "No project workflows file — New task uses global/built-ins."}
            </p>
          )}
          {projectMessage && (
            <p className="text-[11px] text-amber-400/90">{projectMessage}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addWorkflow}
        >
          Add workflow
        </Button>
        {scope === "global" && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetGlobalToBuiltins}
            >
              Load built-ins
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearGlobalOverrides}
              disabled={globalWorkflows.length === 0}
            >
              Use built-ins (clear)
            </Button>
          </>
        )}
        {scope === "project" && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={seedProjectFromEffective}
            >
              Copy from global/built-ins
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void saveProject()}
              disabled={projectSaving || !projectDirty}
            >
              {projectSaving ? "Saving…" : "Save project file"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void clearProjectFile()}
              disabled={projectSaving || (!projectExists && projectWorkflows.length === 0)}
            >
              Remove project file
            </Button>
          </>
        )}
      </div>

      <div className="grid min-h-[280px] grid-cols-[140px_1fr] gap-3">
        <div className="max-h-[360px] space-y-0.5 overflow-y-auto rounded-md border border-border bg-background p-1">
          {list.length === 0 && (
            <p className="px-2 py-3 text-[11px] text-muted-foreground">No workflows</p>
          )}
          {list.map((w) => {
            const active = w.id === selectedId;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => setSelectedId(w.id)}
                className={cn(
                  "w-full rounded px-2 py-1.5 text-left transition-colors",
                  active
                    ? "bg-accent text-foreground"
                    : "text-foreground/80 hover:bg-accent/50",
                )}
              >
                <span className="block truncate text-xs font-medium">
                  {w.label}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                  {workflowSummary(w)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="min-w-0 space-y-3">
          {!selected && (
            <p className="text-xs text-muted-foreground">
              Select a workflow or add one to edit its prompt template.
            </p>
          )}
          {selected && (
            <>
              <Field label="Label">
                <Input
                  value={selected.label}
                  onChange={(e) => patchSelected({ label: e.target.value })}
                  className="text-xs"
                />
              </Field>
              <Field label="Description">
                <Input
                  value={selected.description}
                  onChange={(e) =>
                    patchSelected({ description: e.target.value })
                  }
                  className="text-xs"
                />
              </Field>
              <Field label="Task placeholder">
                <Input
                  value={selected.taskPlaceholder}
                  onChange={(e) =>
                    patchSelected({ taskPlaceholder: e.target.value })
                  }
                  className="text-xs"
                />
              </Field>
              <Field label="Id">
                <Input
                  value={selected.id}
                  onChange={(e) =>
                    patchSelected({
                      id: e.target.value
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9_]+/g, "_")
                        .slice(0, 48),
                    })
                  }
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </Field>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-xs text-foreground/90">
                  <Checkbox
                    checked={selected.needsPrRef === true}
                    onCheckedChange={(checked) =>
                      patchSelected({
                        needsPrRef: checked === true ? true : undefined,
                      })
                    }
                  />
                  Needs PR URL / number
                </label>
                <label className="flex items-center gap-2 text-xs text-foreground/90">
                  <Checkbox
                    checked={selected.includeHarnessPreamble !== false}
                    onCheckedChange={(checked) =>
                      patchSelected({
                        includeHarnessPreamble: checked === true,
                      })
                    }
                  />
                  Include harness preamble
                </label>
              </div>
              <Field label="Prompt template">
                <Textarea
                  value={selected.promptTemplate}
                  onChange={(e) =>
                    patchSelected({ promptTemplate: e.target.value })
                  }
                  rows={12}
                  spellCheck={false}
                  className="resize-y font-mono text-[11px] leading-relaxed"
                />
              </Field>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={removeSelected}
                className="border-destructive/50 text-destructive hover:bg-destructive/10"
              >
                Delete workflow
              </Button>
            </>
          )}
        </div>
      </div>

      {scope === "global" && (
        <p className="text-[11px] text-muted-foreground">
          Global changes apply when you click Save at the bottom of Settings.
        </p>
      )}
      {scope === "project" && projectDirty && (
        <p className="text-[11px] text-amber-400/80">
          Unsaved project workflow changes — click “Save project file”.
        </p>
      )}
    </div>
  );
}
