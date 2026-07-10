import { useMemo, useState } from "react";
import type {
  AgentInfo,
  AppSettings,
  ClaudeModelAlias,
  ProviderConfig,
} from "../../shared/rpc";
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

const MODEL_ALIAS_OPTIONS: { value: ClaudeModelAlias; label: string }[] = [
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

type SettingsTab = "general" | "providers" | "alerts";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "alerts", label: "Alerts" },
];

function normalizeEffortValue(raw: string | undefined): string {
  if (!raw) return "high";
  const lower = raw.toLowerCase();
  const known = EFFORT_OPTIONS.find((o) => o.value === lower);
  return known?.value ?? lower;
}

function newProviderLocal(): ProviderConfig {
  return {
    id: `prov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: "New provider",
    baseUrl: "",
    apiKey: "",
    models: { haiku: "", sonnet: "", opus: "" },
  };
}

export function SettingsPanel({ settings, agents, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<AppSettings>(() => ({
    ...settings,
    providers: settings.providers ? [...settings.providers] : [],
  }));
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    () =>
      settings.activeProviderId ??
      settings.providers?.[0]?.id ??
      null,
  );

  const providers = draft.providers ?? [];
  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId) ?? null,
    [providers, selectedProviderId],
  );

  const save = async () => {
    setSaving(true);
    try {
      // Ensure activeProviderId still points at a real provider.
      let activeProviderId = draft.activeProviderId ?? null;
      if (
        activeProviderId &&
        !(draft.providers ?? []).some((p) => p.id === activeProviderId)
      ) {
        activeProviderId = draft.providers?.[0]?.id ?? null;
      }
      await onSave({
        ...draft,
        activeProviderId,
        providers: draft.providers ?? [],
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const updateProvider = (id: string, patch: Partial<ProviderConfig>) => {
    setDraft((d) => ({
      ...d,
      providers: (d.providers ?? []).map((p) =>
        p.id === id
          ? {
              ...p,
              ...patch,
              models: patch.models ? { ...p.models, ...patch.models } : p.models,
            }
          : p,
      ),
    }));
  };

  const addProvider = () => {
    const p = newProviderLocal();
    setDraft((d) => ({
      ...d,
      providers: [...(d.providers ?? []), p],
      activeProviderId: d.activeProviderId ?? p.id,
    }));
    setSelectedProviderId(p.id);
  };

  const removeProvider = (id: string) => {
    setDraft((d) => {
      const next = (d.providers ?? []).filter((p) => p.id !== id);
      const activeProviderId =
        d.activeProviderId === id
          ? next[0]?.id ?? null
          : d.activeProviderId ?? null;
      return { ...d, providers: next, activeProviderId };
    });
    setSelectedProviderId((cur) => {
      if (cur !== id) return cur;
      const remaining = providers.filter((p) => p.id !== id);
      return remaining[0]?.id ?? null;
    });
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
      <div className="flex h-[min(640px,90vh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[#333] bg-[#1a1a1a] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-[#2e2e2e] px-5 py-3">
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

        <div className="flex min-h-0 flex-1">
          {/* Tab rail */}
          <nav
            className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-[#2e2e2e] bg-[#161616] p-2"
            aria-label="Settings sections"
          >
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    active
                      ? "bg-[#2a2a2a] font-medium text-gray-100"
                      : "text-gray-400 hover:bg-[#222] hover:text-gray-200"
                  }`}
                  aria-current={active ? "page" : undefined}
                >
                  {t.label}
                </button>
              );
            })}
          </nav>

          {/* Detail panel */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm">
            {tab === "general" && (
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
                    Applied when a session starts (if the agent exposes a thinking
                    / effort selector). You can still change it per turn in the
                    prompt bar.
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
                  Off by default. When on, the agent may read and write files via
                  ACP fs/* methods.
                </p>
              </div>
            )}

            {tab === "providers" && (
              <ProvidersTab
                providers={providers}
                selectedProvider={selectedProvider}
                selectedProviderId={selectedProviderId}
                activeProviderId={draft.activeProviderId ?? null}
                activeModelAlias={draft.activeModelAlias ?? "sonnet"}
                onSelectProvider={setSelectedProviderId}
                onAdd={addProvider}
                onRemove={removeProvider}
                onUpdate={updateProvider}
                onSetActive={(id) =>
                  setDraft((d) => ({ ...d, activeProviderId: id }))
                }
                onSetAlias={(activeModelAlias) =>
                  setDraft((d) => ({ ...d, activeModelAlias }))
                }
              />
            )}

            {tab === "alerts" && (
              <div className="space-y-3">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
                  Completion alerts
                </span>
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
            )}
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-[#2e2e2e] px-5 py-3">
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

function ProvidersTab({
  providers,
  selectedProvider,
  selectedProviderId,
  activeProviderId,
  activeModelAlias,
  onSelectProvider,
  onAdd,
  onRemove,
  onUpdate,
  onSetActive,
  onSetAlias,
}: {
  providers: ProviderConfig[];
  selectedProvider: ProviderConfig | null;
  selectedProviderId: string | null;
  activeProviderId: string | null;
  activeModelAlias: ClaudeModelAlias;
  onSelectProvider: (id: string | null) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<ProviderConfig>) => void;
  onSetActive: (id: string | null) => void;
  onSetAlias: (alias: ClaudeModelAlias) => void;
}) {
  return (
    <div className="flex h-full min-h-[320px] flex-col gap-3">
      <p className="text-[11px] leading-relaxed text-gray-500">
        Configure Anthropic-compatible endpoints for Claude Code ACP. Credentials
        and model maps are injected as{" "}
        <code className="text-gray-400">ANTHROPIC_*</code> env vars when the agent
        spawns. Select a provider and model in the chat bar to switch.
      </p>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* Provider list */}
        <div className="flex w-44 shrink-0 flex-col rounded-lg border border-[#2e2e2e] bg-[#121212]">
          <div className="flex items-center justify-between border-b border-[#2e2e2e] px-2 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
              Providers
            </span>
            <button
              type="button"
              onClick={onAdd}
              className="rounded px-1.5 py-0.5 text-xs text-gray-300 hover:bg-[#2a2a2a]"
              aria-label="Add provider"
            >
              +
            </button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-1">
            {providers.length === 0 && (
              <li className="px-2 py-3 text-center text-[11px] text-gray-600">
                No providers yet
              </li>
            )}
            {providers.map((p) => {
              const selected = p.id === selectedProviderId;
              const isActive = p.id === activeProviderId;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onSelectProvider(p.id)}
                    className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs ${
                      selected
                        ? "bg-[#2a2a2a] text-gray-100"
                        : "text-gray-400 hover:bg-[#1e1e1e] hover:text-gray-200"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {isActive && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                        title="Active"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Provider detail */}
        <div className="min-w-0 flex-1 space-y-3 overflow-y-auto">
          {!selectedProvider ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[#333] px-4 py-10 text-center">
              <p className="text-sm text-gray-400">No provider selected</p>
              <button
                type="button"
                onClick={onAdd}
                className="rounded-md bg-gray-200 px-3 py-1.5 text-xs font-medium text-gray-900 hover:bg-white"
              >
                Add provider
              </button>
            </div>
          ) : (
            <>
              <Field label="Name">
                <input
                  value={selectedProvider.name}
                  onChange={(e) =>
                    onUpdate(selectedProvider.id, { name: e.target.value })
                  }
                  className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 text-gray-200"
                  placeholder="My gateway"
                />
              </Field>

              <Field label="Base URL">
                <input
                  value={selectedProvider.baseUrl}
                  onChange={(e) =>
                    onUpdate(selectedProvider.id, { baseUrl: e.target.value })
                  }
                  className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 font-mono text-xs text-gray-200"
                  placeholder="https://api.anthropic.com"
                  spellCheck={false}
                />
                <p className="mt-1 text-[11px] text-gray-500">
                  Sets <code className="text-gray-400">ANTHROPIC_BASE_URL</code>
                </p>
              </Field>

              <Field label="API key">
                <input
                  type="password"
                  value={selectedProvider.apiKey}
                  onChange={(e) =>
                    onUpdate(selectedProvider.id, { apiKey: e.target.value })
                  }
                  className="w-full rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 font-mono text-xs text-gray-200"
                  placeholder="sk-…"
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="mt-1 text-[11px] text-gray-500">
                  Sets{" "}
                  <code className="text-gray-400">ANTHROPIC_API_KEY</code> and{" "}
                  <code className="text-gray-400">ANTHROPIC_AUTH_TOKEN</code>
                </p>
              </Field>

              <div>
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-gray-500">
                  Model mapping
                </span>
                <p className="mb-2 text-[11px] text-gray-500">
                  Map Claude Code aliases to your provider’s model IDs. Leave blank
                  to use the alias as-is.
                </p>
                <div className="space-y-2">
                  {MODEL_ALIAS_OPTIONS.map(({ value, label }) => (
                    <div key={value} className="flex items-center gap-2">
                      <span className="w-14 shrink-0 text-xs text-gray-400">
                        {label}
                      </span>
                      <input
                        value={selectedProvider.models[value]}
                        onChange={(e) =>
                          onUpdate(selectedProvider.id, {
                            models: {
                              ...selectedProvider.models,
                              [value]: e.target.value,
                            },
                          })
                        }
                        className="min-w-0 flex-1 rounded-md border border-[#333] bg-[#121212] px-2 py-1 font-mono text-xs text-gray-200"
                        placeholder={`ANTHROPIC_DEFAULT_${value.toUpperCase()}_MODEL`}
                        spellCheck={false}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-[#2e2e2e] pt-3">
                <button
                  type="button"
                  onClick={() => onSetActive(selectedProvider.id)}
                  disabled={activeProviderId === selectedProvider.id}
                  className="rounded-md border border-[#333] px-2.5 py-1 text-xs text-gray-300 hover:bg-[#2a2a2a] disabled:opacity-40"
                >
                  {activeProviderId === selectedProvider.id
                    ? "Active provider"
                    : "Use as active"}
                </button>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-gray-500">Default model</span>
                  <Select
                    value={activeModelAlias}
                    options={MODEL_ALIAS_OPTIONS}
                    onChange={(v) => onSetAlias(v as ClaudeModelAlias)}
                    aria-label="Default model alias"
                    triggerClassName="!py-1 !text-xs"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(selectedProvider.id)}
                  className="ml-auto rounded-md px-2.5 py-1 text-xs text-red-400 hover:bg-red-950/40"
                >
                  Delete
                </button>
              </div>
            </>
          )}
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
