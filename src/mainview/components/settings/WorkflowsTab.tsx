import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  cloneBuiltinWorkflows,
  createEmptyWorkflow,
  type WorkflowDefinition,
} from "../../../session/workflows";
import type { AppSettings } from "../../../shared/rpc";
import { getRpc } from "../../rpc";
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
        <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
          Workflows
        </span>
        <p className="text-[11px] leading-snug text-gray-500">
          Customize New-task modes and their first prompts. Placeholders:{" "}
          <code className="text-gray-400">{"{{task}}"}</code>,{" "}
          <code className="text-gray-400">{"{{prRef}}"}</code>. Project file
          fully replaces global/built-ins when non-empty.
        </p>
      </div>

      <div
        className="flex gap-1 rounded-lg border border-[#2a2a2a] bg-[#121212] p-0.5"
        role="tablist"
        aria-label="Workflow scope"
      >
        <button
          type="button"
          role="tab"
          aria-selected={scope === "global"}
          onClick={() => setScope("global")}
          className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
            scope === "global"
              ? "bg-[#2a2a2a] font-medium text-gray-100"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          Global defaults
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === "project"}
          disabled={!hasProject}
          onClick={() => hasProject && setScope("project")}
          title={
            hasProject
              ? projectName || projectCwd || "Project"
              : "Open or pick a project first"
          }
          className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            scope === "project"
              ? "bg-[#2a2a2a] font-medium text-gray-100"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          This project
        </button>
      </div>

      {scope === "global" && (
        <p className="text-[11px] text-gray-500">
          {globalWorkflows.length === 0
            ? "Using built-in workflows (no global overrides). Edit below and Save settings, or reset to built-ins as an explicit override list."
            : `${globalWorkflows.length} global override(s). Empty the list to restore built-ins.`}
        </p>
      )}

      {scope === "project" && (
        <div className="space-y-1.5">
          <p className="truncate text-[11px] text-gray-500" title={projectCwd ?? undefined}>
            {projectName ? (
              <>
                Project: <span className="text-gray-300">{projectName}</span>
              </>
            ) : (
              "Project"
            )}{" "}
            ·{" "}
            <span className="font-mono text-[10px] text-gray-600">
              {projectPath ?? ".terminal-react/workflows.json"}
            </span>
          </p>
          {projectLoading && (
            <p className="text-[11px] text-gray-500">Loading…</p>
          )}
          {!projectLoading && projectWorkflows.length === 0 && (
            <p className="text-[11px] text-gray-500">
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
        <button
          type="button"
          onClick={addWorkflow}
          className="rounded-md border border-[#333] bg-[#222] px-2.5 py-1 text-xs text-gray-200 hover:bg-[#2a2a2a]"
        >
          Add workflow
        </button>
        {scope === "global" && (
          <>
            <button
              type="button"
              onClick={resetGlobalToBuiltins}
              className="rounded-md border border-[#333] px-2.5 py-1 text-xs text-gray-300 hover:bg-[#2a2a2a]"
            >
              Load built-ins
            </button>
            <button
              type="button"
              onClick={clearGlobalOverrides}
              disabled={globalWorkflows.length === 0}
              className="rounded-md border border-[#333] px-2.5 py-1 text-xs text-gray-300 hover:bg-[#2a2a2a] disabled:opacity-40"
            >
              Use built-ins (clear)
            </button>
          </>
        )}
        {scope === "project" && (
          <>
            <button
              type="button"
              onClick={seedProjectFromEffective}
              className="rounded-md border border-[#333] px-2.5 py-1 text-xs text-gray-300 hover:bg-[#2a2a2a]"
            >
              Copy from global/built-ins
            </button>
            <button
              type="button"
              onClick={() => void saveProject()}
              disabled={projectSaving || !projectDirty}
              className="rounded-md bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-900 hover:bg-white disabled:opacity-40"
            >
              {projectSaving ? "Saving…" : "Save project file"}
            </button>
            <button
              type="button"
              onClick={() => void clearProjectFile()}
              disabled={projectSaving || (!projectExists && projectWorkflows.length === 0)}
              className="rounded-md border border-[#333] px-2.5 py-1 text-xs text-gray-300 hover:bg-[#2a2a2a] disabled:opacity-40"
            >
              Remove project file
            </button>
          </>
        )}
      </div>

      <div className="grid min-h-[280px] grid-cols-[140px_1fr] gap-3">
        <div className="max-h-[360px] space-y-0.5 overflow-y-auto rounded-md border border-[#2a2a2a] bg-[#121212] p-1">
          {list.length === 0 && (
            <p className="px-2 py-3 text-[11px] text-gray-600">No workflows</p>
          )}
          {list.map((w) => {
            const active = w.id === selectedId;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => setSelectedId(w.id)}
                className={`w-full rounded px-2 py-1.5 text-left transition-colors ${
                  active
                    ? "bg-[#2e2e2e] text-gray-100"
                    : "text-gray-300 hover:bg-[#1e1e1e]"
                }`}
              >
                <span className="block truncate text-xs font-medium">
                  {w.label}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-gray-500">
                  {workflowSummary(w)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="min-w-0 space-y-3">
          {!selected && (
            <p className="text-xs text-gray-500">
              Select a workflow or add one to edit its prompt template.
            </p>
          )}
          {selected && (
            <>
              <Field label="Label">
                <input
                  value={selected.label}
                  onChange={(e) => patchSelected({ label: e.target.value })}
                  className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-gray-500"
                />
              </Field>
              <Field label="Description">
                <input
                  value={selected.description}
                  onChange={(e) =>
                    patchSelected({ description: e.target.value })
                  }
                  className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-gray-500"
                />
              </Field>
              <Field label="Task placeholder">
                <input
                  value={selected.taskPlaceholder}
                  onChange={(e) =>
                    patchSelected({ taskPlaceholder: e.target.value })
                  }
                  className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-gray-500"
                />
              </Field>
              <Field label="Id">
                <input
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
                  className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 font-mono text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-gray-500"
                />
              </Field>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-xs text-gray-300">
                  <input
                    type="checkbox"
                    checked={selected.needsPrRef === true}
                    onChange={(e) =>
                      patchSelected({
                        needsPrRef: e.target.checked ? true : undefined,
                      })
                    }
                    className="rounded border-[#444]"
                  />
                  Needs PR URL / number
                </label>
                <label className="flex items-center gap-2 text-xs text-gray-300">
                  <input
                    type="checkbox"
                    checked={selected.includeHarnessPreamble !== false}
                    onChange={(e) =>
                      patchSelected({
                        includeHarnessPreamble: e.target.checked,
                      })
                    }
                    className="rounded border-[#444]"
                  />
                  Include harness preamble
                </label>
              </div>
              <Field label="Prompt template">
                <textarea
                  value={selected.promptTemplate}
                  onChange={(e) =>
                    patchSelected({ promptTemplate: e.target.value })
                  }
                  rows={12}
                  spellCheck={false}
                  className="w-full resize-y rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-gray-200 focus:outline-none focus:ring-1 focus:ring-gray-500"
                />
              </Field>
              <button
                type="button"
                onClick={removeSelected}
                className="rounded-md border border-red-900/50 px-2.5 py-1 text-xs text-red-300/90 hover:bg-red-950/40"
              >
                Delete workflow
              </button>
            </>
          )}
        </div>
      </div>

      {scope === "global" && (
        <p className="text-[11px] text-gray-600">
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
