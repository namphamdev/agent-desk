import { useState } from "react";
import type { AgentInfo, AppSettings } from "../../shared/rpc";
import { ensureNotificationPermission } from "../completionAlert";
import { Select } from "./Select";

type Props = {
  settings: AppSettings;
  agents: AgentInfo[];
  onClose: () => void;
  onSave: (patch: Partial<AppSettings>) => void | Promise<void>;
};

const THEME_OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
] as const;

/** Common ACP thought_level / effort values (Claude Code and similar agents). */
const EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
] as const;

function normalizeEffortValue(raw: string | undefined): string {
  if (!raw) return "high";
  const lower = raw.toLowerCase();
  const known = EFFORT_OPTIONS.find((o) => o.value === lower);
  return known?.value ?? lower;
}

export function SettingsPanel({ settings, agents, onClose, onSave }: Props) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const agentOptions =
    agents.length === 0
      ? [{ value: "", label: "No agents configured", disabled: true }]
      : agents.map((a) => ({ value: a.id, label: a.name }));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-[#333] bg-[#1a1a1a] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#2e2e2e] px-5 py-3">
          <h2 id="settings-title" className="text-sm font-semibold text-gray-100">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-[#2a2a2a] hover:text-gray-200"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
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
            <input
              value={draft.editorCommand}
              onChange={(e) =>
                setDraft((d) => ({ ...d, editorCommand: e.target.value }))
              }
              placeholder="code"
              className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 font-mono text-gray-200"
            />
            <p className="mt-1 text-[11px] text-gray-500">
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
            <p className="mt-1 text-[11px] text-gray-500">
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
            <p className="mt-1 text-[11px] text-gray-500">
              Applied when a session starts (if the agent exposes a thinking /
              effort selector). You can still change it per turn in the prompt
              bar.
            </p>
          </Field>

          <label className="flex items-center gap-2 text-gray-300">
            <input
              type="checkbox"
              checked={draft.enableFsCapabilities}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  enableFsCapabilities: e.target.checked,
                }))
              }
              className="rounded border-[#444]"
            />
            Enable filesystem capabilities (read/write for the agent)
          </label>
          <p className="text-[11px] text-gray-500">
            Off by default. When on, the agent may read and write files via ACP
            fs/* methods.
          </p>

          <div className="border-t border-[#2e2e2e] pt-4">
            <span className="mb-2 block text-xs font-medium uppercase tracking-wider text-gray-500">
              Completion alerts
            </span>
            <div className="space-y-3">
              <div>
                <label className="flex items-center gap-2 text-gray-300">
                  <input
                    type="checkbox"
                    checked={draft.enableNotifications ?? true}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        enableNotifications: e.target.checked,
                      }))
                    }
                    className="rounded border-[#444]"
                  />
                  System notification when a task completes
                </label>
                <p className="mt-1 text-[11px] text-gray-500">
                  Native OS banner via Electrobun. macOS may ask for permission
                  the first time a notification is shown — allow “terminal-react”
                  under System Settings → Notifications if banners don’t appear.
                </p>
              </div>
              <div>
                <label className="flex items-center gap-2 text-gray-300">
                  <input
                    type="checkbox"
                    checked={draft.enableSound ?? true}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        enableSound: e.target.checked,
                      }))
                    }
                    className="rounded border-[#444]"
                  />
                  Play sound when a task completes
                </label>
                <p className="mt-1 text-[11px] text-gray-500">
                  OS notification sound when banners are on; otherwise a short
                  in-app chime.
                </p>
              </div>
              {draft.enableNotifications && (
                <button
                  type="button"
                  onClick={() => void ensureNotificationPermission()}
                  className="rounded-md border border-[#333] px-2.5 py-1 text-xs text-gray-300 hover:bg-[#2a2a2a] hover:text-gray-100"
                >
                  Send test notification
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-[#2e2e2e] px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-400 hover:bg-[#2a2a2a]"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
        {label}
      </span>
      {children}
    </div>
  );
}
