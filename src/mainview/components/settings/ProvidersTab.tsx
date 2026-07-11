import type { ClaudeModelAlias, ProviderConfig } from "../../../shared/rpc";
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
}: Props) {
  return (
    <div className="flex h-full min-h-[320px] flex-col gap-3">
      <p className="text-[11px] leading-relaxed text-gray-500">
        Configure Anthropic-compatible endpoints for Claude Code ACP. Credentials
        and model maps are injected as{" "}
        <code className="text-gray-400">ANTHROPIC_*</code> env vars when the agent
        spawns. Select a provider and model in the chat bar to switch.
      </p>

      <div className="flex min-h-0 flex-1 gap-3">
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
                  Map Claude Code aliases to your provider’s model IDs. Leave
                  blank to use the alias as-is.
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
