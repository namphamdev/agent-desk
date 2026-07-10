import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AvailableCommand,
  SessionConfigOption,
} from "../../shared/rpc";

type Props = {
  disabled?: boolean;
  prompting?: boolean;
  commands?: AvailableCommand[];
  mode?: string;
  /** ACP session config options (model, thought_level, …). */
  configOptions?: SessionConfigOption[];
  onSubmit: (text: string) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onSetConfigOption?: (
    configId: string,
    value: string | boolean,
  ) => void | Promise<void>;
};

/** Find the first select option matching a category (or id fallback). */
function findSelectOption(
  options: SessionConfigOption[],
  category: string,
  idFallback?: string,
): Extract<SessionConfigOption, { type: "select" }> | null {
  const byCategory = options.find(
    (o) => o.type === "select" && o.category === category,
  );
  if (byCategory && byCategory.type === "select") return byCategory;
  if (idFallback) {
    const byId = options.find(
      (o) => o.type === "select" && o.id === idFallback,
    );
    if (byId && byId.type === "select") return byId;
  }
  return null;
}

/**
 * Bottom input bar. Sends prompts over Electrobun RPC to the ACP agent.
 * Supports Stop while streaming, and a `/commands` picker from
 * available_commands_update. Model / effort selectors come from ACP
 * `configOptions` (categories `model` and `thought_level`).
 */
export function PromptInput({
  disabled,
  prompting,
  commands = [],
  mode,
  configOptions = [],
  onSubmit,
  onCancel,
  onSetConfigOption,
}: Props) {
  const [value, setValue] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const [settingConfig, setSettingConfig] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Prevents Enter+click or repeated keydown from double-submitting. */
  const submittingRef = useRef(false);

  const modelOption = useMemo(
    () => findSelectOption(configOptions, "model", "model"),
    [configOptions],
  );
  const effortOption = useMemo(
    () => findSelectOption(configOptions, "thought_level", "thought_level"),
    [configOptions],
  );

  useEffect(() => {
    if (value.startsWith("/") && commands.length > 0) {
      setShowCommands(true);
    } else {
      setShowCommands(false);
    }
  }, [value, commands.length]);

  const filteredCommands = commands.filter((c) =>
    c.name.toLowerCase().includes(value.slice(1).toLowerCase()),
  );

  const submit = async () => {
    const text = value.trim();
    if (!text || disabled || submittingRef.current) return;
    submittingRef.current = true;
    setValue("");
    setShowCommands(false);
    try {
      await onSubmit(text);
    } finally {
      submittingRef.current = false;
      inputRef.current?.focus();
    }
  };

  const changeConfig = async (configId: string, nextValue: string) => {
    if (!onSetConfigOption || settingConfig) return;
    setSettingConfig(true);
    try {
      await onSetConfigOption(configId, nextValue);
    } finally {
      setSettingConfig(false);
    }
  };

  const modelLabel =
    modelOption?.options.find((o) => o.value === modelOption.currentValue)
      ?.name ?? modelOption?.currentValue;
  const effortLabel =
    effortOption?.options.find((o) => o.value === effortOption.currentValue)
      ?.name ?? effortOption?.currentValue;

  return (
    <div className="pointer-events-none absolute bottom-6 left-0 right-0 px-6">
      <div className="input-bg pointer-events-auto flex w-full flex-col rounded-2xl border shadow-lg">
        <div className="relative px-4 py-3">
          <input
            ref={inputRef}
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
              if (e.key === "Escape" && prompting) {
                void onCancel?.();
              }
            }}
            className="w-full border-none bg-transparent text-[15px] text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-0 disabled:opacity-50"
            placeholder={
              disabled
                ? "Connecting to agent…"
                : prompting
                  ? "Agent is working… (Esc to stop)"
                  : "Ask anything — or / for commands"
            }
            aria-label="Prompt input"
          />
          {showCommands && filteredCommands.length > 0 && (
            <div
              className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-48 overflow-y-auto rounded-xl border border-[#3a3a3a] bg-[#1e1e1e] py-1 shadow-xl"
              role="listbox"
            >
              {filteredCommands.map((c) => (
                <button
                  key={c.name}
                  role="option"
                  onClick={() => {
                    setValue(`/${c.name} `);
                    setShowCommands(false);
                    inputRef.current?.focus();
                  }}
                  className="flex w-full flex-col px-3 py-2 text-left hover:bg-[#2a2a2a]"
                >
                  <span className="text-sm text-gray-200">/{c.name}</span>
                  {c.description && (
                    <span className="text-xs text-gray-500">{c.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[#2e2e2e] px-3 py-2">
          <div className="flex items-center space-x-3">
            {mode && mode !== "default" && (
              <span className="rounded-full bg-[#2a2a2a] px-2 py-0.5 text-[11px] font-medium text-amber-400">
                {mode}
              </span>
            )}
            {modelOption && modelLabel && (
              <>
                {(mode && mode !== "default") && (
                  <div className="h-4 w-px bg-[#333]" />
                )}
                <Selector
                  value={modelOption.currentValue}
                  displayValue={modelLabel}
                  options={modelOption.options.map((o) => ({
                    value: o.value,
                    label: o.name,
                  }))}
                  onChange={(v) => void changeConfig(modelOption.id, v)}
                  accent="text-[#d97706]"
                  disabled={disabled || settingConfig}
                />
              </>
            )}
          </div>
          <div className="flex items-center space-x-3">
            {effortOption && effortLabel && (
              <Selector
                value={effortOption.currentValue}
                displayValue={effortLabel}
                options={effortOption.options.map((o) => ({
                  value: o.value,
                  label: o.name,
                }))}
                onChange={(v) => void changeConfig(effortOption.id, v)}
                disabled={disabled || settingConfig}
              />
            )}
            {prompting ? (
              <button
                onClick={() => void onCancel?.()}
                className="ml-1 flex items-center gap-1 rounded-md bg-red-900/60 px-2.5 py-1.5 text-xs font-medium text-red-200 hover:bg-red-800/60"
                aria-label="Stop generation"
              >
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <rect x="5" y="5" width="10" height="10" rx="1" />
                </svg>
                Stop
              </button>
            ) : (
              <button
                onClick={() => void submit()}
                disabled={disabled || !value.trim()}
                className="ml-1 rounded-md bg-gray-600 p-1.5 text-gray-200 hover:bg-gray-500 disabled:opacity-40"
                aria-label="Send prompt"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Selector({
  value,
  displayValue,
  options,
  onChange,
  accent,
  prefix,
  disabled,
}: {
  value: string;
  displayValue?: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  accent?: string;
  prefix?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center space-x-1.5 rounded px-2 py-1 text-sm font-medium hover:bg-[#3a270a] disabled:opacity-50 ${accent ?? "text-gray-400 hover:text-gray-200"}`}
      >
        {prefix && <span>{prefix}</span>}
        <span>{displayValue ?? value}</span>
        <svg
          className="h-3 w-3 text-gray-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 max-h-64 min-w-[10rem] overflow-y-auto rounded-lg border border-[#3a3a3a] bg-[#1e1e1e] py-1 shadow-xl">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-[#2a2a2a] ${
                o.value === value ? "text-gray-200" : "text-gray-400"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
