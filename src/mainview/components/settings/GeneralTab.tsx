import type { Dispatch, SetStateAction } from "react";
import type { AgentInfo, AppSettings } from "../../../shared/rpc";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "../Select";
import {
  EFFORT_OPTIONS,
  PERMISSION_MODE_OPTIONS,
  THEME_OPTIONS,
  normalizeEffortValue,
  normalizePermissionModeValue,
} from "./constants";
import { Field } from "./Field";

type Props = {
  draft: AppSettings;
  setDraft: Dispatch<SetStateAction<AppSettings>>;
  agents: AgentInfo[];
  worktreePathsText: string;
  setWorktreePathsText: (value: string) => void;
};

export function GeneralTab({
  draft,
  setDraft,
  agents,
  worktreePathsText,
  setWorktreePathsText,
}: Props) {
  const agentOptions =
    agents.length === 0
      ? [{ value: "", label: "No agents configured", disabled: true }]
      : agents.map((a) => ({ value: a.id, label: a.name }));

  return (
    <div className="space-y-4">
      <Field label="Theme">
        <Select
          value={draft.theme}
          options={[...THEME_OPTIONS]}
          onChange={(theme) =>
            setDraft((d) => ({
              ...d,
              theme: theme as AppSettings["theme"],
            }))
          }
          aria-label="Theme"
        />
      </Field>

      <Field label="Editor command">
        <Input
          value={draft.editorCommand}
          onChange={(e) =>
            setDraft((d) => ({ ...d, editorCommand: e.target.value }))
          }
          placeholder="code"
          className="font-mono"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Used when opening files from tool-call locations ($EDITOR).
        </p>
      </Field>

      <Field label="Default agent">
        <Select
          value={draft.defaultAgentId ?? agents[0]?.id ?? ""}
          options={agentOptions}
          onChange={(defaultAgentId) =>
            setDraft((d) => ({ ...d, defaultAgentId }))
          }
          placeholder="No agents configured"
          disabled={agents.length === 0}
          aria-label="Default agent"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Configure agents in ~/.terminal-react/agents.json
        </p>
      </Field>

      <Field label="Default thinking level">
        <Select
          value={normalizeEffortValue(draft.defaultEffort)}
          options={[...EFFORT_OPTIONS]}
          onChange={(defaultEffort) =>
            setDraft((d) => ({ ...d, defaultEffort }))
          }
          aria-label="Default thinking level"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Applied when a session starts (if the agent exposes a thinking /
          effort selector). You can still change it per turn in the prompt bar.
        </p>
      </Field>

      <Field label="Default permission mode">
        <Select
          value={normalizePermissionModeValue(draft.defaultPermissionMode)}
          options={[...PERMISSION_MODE_OPTIONS]}
          onChange={(defaultPermissionMode) =>
            setDraft((d) => ({ ...d, defaultPermissionMode }))
          }
          aria-label="Default permission mode"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Applied when a session starts (if the agent exposes a permission /
          mode selector). You can still change it per turn in the prompt bar.
        </p>
      </Field>

      <label className="flex items-center gap-2 text-foreground/90">
        <Checkbox
          checked={draft.enableFsCapabilities}
          onCheckedChange={(checked) =>
            setDraft((d) => ({
              ...d,
              enableFsCapabilities: checked === true,
            }))
          }
        />
        Enable filesystem capabilities (read/write for the agent)
      </label>
      <p className="text-[11px] text-muted-foreground">
        Off by default. When on, the agent may read and write files via ACP
        fs/* methods.
      </p>

      <label className="flex items-center gap-2 text-foreground/90">
        <Checkbox
          checked={draft.enableBrowserMcp !== false}
          onCheckedChange={(checked) =>
            setDraft((d) => ({
              ...d,
              enableBrowserMcp: checked === true,
            }))
          }
        />
        Built-in browser (agent can control the panel)
      </label>
      <p className="text-[11px] text-muted-foreground">
        On by default. When a session starts, Claude Code gets MCP tools that
        drive the in-app browser panel (globe icon) — navigate, snapshot, click,
        type — not a separate Chrome window. Applies to new sessions.
      </p>

      <Field label="Worktree shared paths">
        <Textarea
          value={worktreePathsText}
          onChange={(e) => setWorktreePathsText(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={"node_modules\n.venv"}
          className="resize-y font-mono text-xs"
          aria-label="Worktree shared paths"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Relative paths (one per line or comma-separated) symlinked from the
          main project into new git worktrees. Avoids reinstalling large folders
          like <span className="font-mono">node_modules</span>. Absolute paths
          and <span className="font-mono">..</span> are ignored.
        </p>
      </Field>
    </div>
  );
}
