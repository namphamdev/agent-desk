import { useState } from "react";
import type { AgentInfo, AppSettings } from "../../shared/rpc";

type Props = {
  settings: AppSettings;
  agents: AgentInfo[];
  onClose: () => void;
  onSave: (patch: Partial<AppSettings>) => void | Promise<void>;
};

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

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6"
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
            <select
              value={draft.theme}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  theme: e.target.value as AppSettings["theme"],
                }))
              }
              className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 text-gray-200"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
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
            <select
              value={draft.defaultAgentId ?? agents[0]?.id ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, defaultAgentId: e.target.value }))
              }
              className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 text-gray-200"
            >
              {agents.length === 0 ? (
                <option value="">No agents configured</option>
              ) : null}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-gray-500">
              Configure agents in ~/.terminal-react/agents.json
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
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
        {label}
      </span>
      {children}
    </label>
  );
}
