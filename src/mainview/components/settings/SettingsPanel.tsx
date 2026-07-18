import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  parseProvidersImportText,
  serializeProvidersExport,
} from "../../../bun/providers";
import type { AppSettings, ProviderConfig } from "../../../shared/rpc";
import {
  formatSymlinkPathsText,
  parseSymlinkPathsText,
} from "../../../shared/worktree-paths";
import { getRpc } from "../../rpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { RemoteAccessControls } from "../RemoteAccessPanel";
import { AlertsTab } from "./AlertsTab";
import { WorkflowsTab } from "./WorkflowsTab";
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
  projectCwd = null,
  projectName = null,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<AppSettings>(() => ({
    ...settings,
    providers: settings.providers ? [...settings.providers] : [],
    workflows: settings.workflows ? settings.workflows.map((w) => ({ ...w })) : [],
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
  const [providersImportMessage, setProvidersImportMessage] = useState<
    string | null
  >(null);

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
        workflows: draft.workflows ?? [],
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

  const exportProviders = async () => {
    const json = serializeProvidersExport({
      providers: draft.providers ?? [],
      activeProviderId: draft.activeProviderId ?? null,
      activeModelAlias: draft.activeModelAlias ?? "sonnet",
    });
    setProvidersImportMessage(null);
    try {
      const res = await getRpc().request.saveTextFile({
        content: json,
        defaultName: "terminal-react-providers.json",
        prompt: "Export providers",
      });
      if (res.ok) {
        setProvidersImportMessage(`Exported to ${res.path}`);
        return;
      }
      if (res.cancelled) {
        setProvidersImportMessage(null);
        return;
      }
      setProvidersImportMessage(res.error ?? "Export failed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProvidersImportMessage(message || "Export failed");
    }
  };

  const importProviders = (fileText: string) => {
    const result = parseProvidersImportText(fileText);
    if (!result.ok) {
      setProvidersImportMessage(result.error);
      return;
    }
    const existing = draft.providers ?? [];
    if (existing.length > 0) {
      const ok = window.confirm(
        `Replace ${existing.length} provider(s) with ${result.providers.length} from the file? Unsaved draft changes will be overwritten. Click Save afterward to persist.`,
      );
      if (!ok) {
        setProvidersImportMessage(null);
        return;
      }
    }
    setDraft((d) => ({
      ...d,
      providers: result.providers,
      activeProviderId: result.activeProviderId,
      activeModelAlias: result.activeModelAlias,
    }));
    setSelectedProviderId(
      result.activeProviderId ?? result.providers[0]?.id ?? null,
    );
    setProvidersImportMessage(
      `Imported ${result.providers.length} provider(s). Click Save to persist.`,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(640px,90vh)] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between space-y-0 border-b border-border px-5 py-3">
          <DialogTitle id="settings-title">Settings</DialogTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <nav
            className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-border bg-muted/50 p-2"
            aria-label="Settings sections"
          >
            {tabs.map((t) => {
              const active = tab === t.id;
              return (
                <Button
                  key={t.id}
                  type="button"
                  variant="ghost"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "h-auto justify-start rounded-lg px-3 py-2 text-left text-sm font-normal",
                    active
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  {t.label}
                </Button>
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
                onExport={exportProviders}
                onImport={importProviders}
                importMessage={providersImportMessage}
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

            {tab === "workflows" && (
              <WorkflowsTab
                draft={draft}
                setDraft={setDraft}
                projectCwd={projectCwd}
                projectName={projectName}
              />
            )}

            {tab === "alerts" && (
              <AlertsTab draft={draft} setDraft={setDraft} />
            )}
          </div>
        </div>

        <DialogFooter className="mx-0 mb-0 shrink-0 sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
