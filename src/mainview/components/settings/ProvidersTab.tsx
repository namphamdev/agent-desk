import { useRef } from "react";
import type { ClaudeModelAlias, ProviderConfig } from "../../../shared/rpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Select } from "../Select";
import { MODEL_ALIAS_OPTIONS } from "./constants";
import { Field } from "./Field";

type Props = {
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
  onExport: () => void | Promise<void>;
  onImport: (fileText: string) => void;
  importMessage?: string | null;
};

export function ProvidersTab({
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
  onExport,
  onImport,
  importMessage = null,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex h-full min-h-[320px] flex-col gap-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Configure Anthropic-compatible endpoints for Claude Code ACP. Credentials
        and model maps are injected as{" "}
        <code className="text-muted-foreground">ANTHROPIC_*</code> env vars when the agent
        spawns. Select a provider and model in the chat bar to switch.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onExport()}
          disabled={providers.length === 0}
        >
          Export…
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
        >
          Import…
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void file.text().then(onImport);
          }}
        />
        <span className="text-[11px] text-muted-foreground">
          Export includes API keys — keep the file private.
        </span>
      </div>
      {importMessage && (
        <p
          className={cn(
            "text-[11px]",
            importMessage.startsWith("Imported") ||
              importMessage.startsWith("Exported")
              ? "text-emerald-500"
              : "text-destructive",
          )}
          role="status"
        >
          {importMessage}
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex w-44 shrink-0 flex-col rounded-lg border border-border bg-background">
          <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Providers
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onAdd}
              aria-label="Add provider"
            >
              +
            </Button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-1">
            {providers.length === 0 && (
              <li className="px-2 py-3 text-center text-[11px] text-muted-foreground">
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
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs",
                      selected
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
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

        <div className="min-w-0 flex-1 space-y-3 overflow-y-auto">
          {!selectedProvider ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">No provider selected</p>
              <Button type="button" size="sm" onClick={onAdd}>
                Add provider
              </Button>
            </div>
          ) : (
            <>
              <Field label="Name">
                <Input
                  value={selectedProvider.name}
                  onChange={(e) =>
                    onUpdate(selectedProvider.id, { name: e.target.value })
                  }
                  placeholder="My gateway"
                />
              </Field>

              <Field label="Base URL">
                <Input
                  value={selectedProvider.baseUrl}
                  onChange={(e) =>
                    onUpdate(selectedProvider.id, { baseUrl: e.target.value })
                  }
                  className="font-mono text-xs"
                  placeholder="https://api.anthropic.com"
                  spellCheck={false}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Sets <code className="text-muted-foreground">ANTHROPIC_BASE_URL</code>
                </p>
              </Field>

              <Field label="API key">
                <Input
                  type="password"
                  value={selectedProvider.apiKey}
                  onChange={(e) =>
                    onUpdate(selectedProvider.id, { apiKey: e.target.value })
                  }
                  className="font-mono text-xs"
                  placeholder="sk-…"
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Sets{" "}
                  <code className="text-muted-foreground">ANTHROPIC_API_KEY</code> and{" "}
                  <code className="text-muted-foreground">ANTHROPIC_AUTH_TOKEN</code>
                </p>
              </Field>

              <div>
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Model mapping
                </span>
                <p className="mb-2 text-[11px] text-muted-foreground">
                  Map Claude Code aliases to your provider’s model IDs. Leave
                  blank to use the alias as-is.
                </p>
                <div className="space-y-2">
                  {MODEL_ALIAS_OPTIONS.map(({ value, label }) => (
                    <div key={value} className="flex items-center gap-2">
                      <span className="w-14 shrink-0 text-xs text-muted-foreground">
                        {label}
                      </span>
                      <Input
                        value={selectedProvider.models[value]}
                        onChange={(e) =>
                          onUpdate(selectedProvider.id, {
                            models: {
                              ...selectedProvider.models,
                              [value]: e.target.value,
                            },
                          })
                        }
                        className="min-w-0 flex-1 font-mono text-xs"
                        placeholder={`ANTHROPIC_DEFAULT_${value.toUpperCase()}_MODEL`}
                        spellCheck={false}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onSetActive(selectedProvider.id)}
                  disabled={activeProviderId === selectedProvider.id}
                >
                  {activeProviderId === selectedProvider.id
                    ? "Active provider"
                    : "Use as active"}
                </Button>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">Default model</span>
                  <Select
                    value={activeModelAlias}
                    options={MODEL_ALIAS_OPTIONS}
                    onChange={(v) => onSetAlias(v as ClaudeModelAlias)}
                    aria-label="Default model alias"
                    triggerClassName="!py-1 !text-xs"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemove(selectedProvider.id)}
                  className="ml-auto text-destructive hover:bg-destructive/10"
                >
                  Delete
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
