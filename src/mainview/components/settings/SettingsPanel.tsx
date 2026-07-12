import { useEffect, useMemo, useState } from "react";
import { RiCloseLine } from "react-icons/ri";
import type { AppSettings, ProviderConfig } from "../../../shared/rpc";
import {
  formatSymlinkPathsText,
  parseSymlinkPathsText,
} from "../../../shared/worktree-paths";
import { RemoteAccessControls } from "../RemoteAccessPanel";
import { AlertsTab } from "./AlertsTab";
import { BASE_TABS, newProviderLocal } from "./constants";
import { ClaudeCodeTab } from "./ClaudeCodeTab";
import { GeneralTab } from "./GeneralTab";
import { ProvidersTab } from "./ProvidersTab";
import type { SettingsPanelProps, SettingsTab } from "./types";

export type { SettingsPanelProps } from "./types";

export function SettingsPanel({
  settings,
  agents,
  onClose,
  onSave,
  showRemoteControl = true,
  remoteAccess = null,
  remoteAccessLoading,
  remoteAccessError,
  onRemoteStart,
  onRemoteStop,
  onRemoteRegenerate,
  onRemoteRefresh,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<AppSettings>(() => ({
    ...settings,
    providers: settings.providers ? [...settings.providers] : [],
  }));
  const [worktreePathsText, setWorktreePathsText] = useState(() =>
    formatSymlinkPathsText(settings.worktreeSymlinkPaths ?? ["node_modules"]),
  );
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    () =>
      settings.activeProviderId ?? settings.providers?.[0]?.id ?? null,
  );

  const tabs = useMemo(
    () =>
      showRemoteControl
        ? BASE_TABS
        : BASE_TABS.filter((t) => t.id !== "remote"),
    [showRemoteControl],
  );

  useEffect(() => {
    if (tab === "remote" && !showRemoteControl) setTab("general");
  }, [tab, showRemoteControl]);

  useEffect(() => {
    if (tab === "remote" && onRemoteRefresh) {
      void onRemoteRefresh();
    }
  }, [tab, onRemoteRefresh]);

  const providers = draft.providers ?? [];
  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId) ?? null,
    [providers, selectedProviderId],
  );

  const save = async () => {
    setSaving(true);
    try {
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
        worktreeSymlinkPaths: parseSymlinkPathsText(worktreePathsText),
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
          <h2
            id="settings-title"
            className="text-sm font-semibold text-gray-100"
          >
            Settings
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-[#2a2a2a] hover:text-gray-200"
            aria-label="Close settings"
          >
            <RiCloseLine className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav
            className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-[#2e2e2e] bg-[#161616] p-2"
            aria-label="Settings sections"
          >
            {tabs.map((t) => {
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

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm">
            {tab === "general" && (
              <GeneralTab
                draft={draft}
                setDraft={setDraft}
                agents={agents}
                worktreePathsText={worktreePathsText}
                setWorktreePathsText={setWorktreePathsText}
              />
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

            {tab === "claude" && <ClaudeCodeTab />}

            {tab === "remote" && showRemoteControl && (
              <RemoteAccessControls
                status={remoteAccess}
                loading={remoteAccessLoading}
                error={remoteAccessError}
                onStart={onRemoteStart ?? (async () => {})}
                onStop={onRemoteStop ?? (async () => {})}
                onRegenerate={onRemoteRegenerate ?? (async () => {})}
              />
            )}

            {tab === "alerts" && (
              <AlertsTab draft={draft} setDraft={setDraft} />
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
