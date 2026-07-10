import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AvailableCommand,
  SessionConfigOption,
  SessionUsage,
} from "../../shared/rpc";
import type { QueuedPrompt } from "../promptQueue";

type Props = {
  disabled?: boolean;
  prompting?: boolean;
  commands?: AvailableCommand[];
  mode?: string;
  /** ACP session config options (model, thought_level, …). */
  configOptions?: SessionConfigOption[];
  /** Latest context window usage for this session (ACP usage_update). */
  usage?: SessionUsage | null;
  /** Follow-ups waiting for the current agent turn to finish. */
  queue?: QueuedPrompt[];
  onSubmit: (text: string) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onRemoveQueued?: (id: string) => void;
  onClearQueue?: () => void;
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
 * Supports Stop while streaming, a follow-up queue while the agent is busy,
 * and a `/commands` picker from available_commands_update. Model / effort
 * selectors come from ACP `configOptions` (categories `model` and
 * `thought_level`).
 */
export function PromptInput({
  disabled,
  prompting,
  commands = [],
  mode,
  configOptions = [],
  usage = null,
  queue = [],
  onSubmit,
  onCancel,
  onRemoveQueued,
  onClearQueue,
  onSetConfigOption,
}: Props) {
  const [value, setValue] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
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

  const filteredCommands = useMemo(() => {
    if (!value.startsWith("/")) return [];
    const query = value.slice(1).toLowerCase();
    // After a space (e.g. `/compact now`) the command is already chosen.
    if (query.includes(" ")) return [];
    return commands.filter((c) => c.name.toLowerCase().includes(query));
  }, [value, commands]);

  useEffect(() => {
    if (value.startsWith("/") && !value.slice(1).includes(" ") && commands.length > 0) {
      setShowCommands(true);
      setSelectedCommandIndex(0);
    } else {
      setShowCommands(false);
    }
  }, [value, commands.length]);

  useEffect(() => {
    setSelectedCommandIndex((i) =>
      filteredCommands.length === 0
        ? 0
        : Math.min(i, filteredCommands.length - 1),
    );
  }, [filteredCommands.length]);

  const applyCommand = (name: string) => {
    setValue(`/${name} `);
    setShowCommands(false);
    inputRef.current?.focus();
  };

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

  const canSend = !disabled && !!value.trim();

  return (
    <div className="pointer-events-none absolute bottom-6 left-0 right-0 px-6">
      <div className="input-bg pointer-events-auto flex w-full flex-col rounded-2xl border shadow-lg">
        {queue.length > 0 && (
          <div
            className="border-b border-[#2e2e2e] px-3 py-2"
            role="list"
            aria-label="Queued prompts"
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                Queued · {queue.length}
                {prompting ? " · sends when agent finishes" : ""}
              </span>
              {queue.length > 1 && onClearQueue && (
                <button
                  type="button"
                  onClick={onClearQueue}
                  className="text-[11px] text-gray-500 hover:text-gray-300"
                >
                  Clear all
                </button>
              )}
            </div>
            <ul className="max-h-28 space-y-1 overflow-y-auto">
              {queue.map((item, index) => (
                <li
                  key={item.id}
                  role="listitem"
                  className="flex items-start gap-2 rounded-lg bg-[#252525] px-2 py-1.5"
                >
                  <span className="mt-0.5 w-4 shrink-0 text-center text-[10px] tabular-nums text-gray-600">
                    {index + 1}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-xs text-gray-300"
                    title={item.text}
                  >
                    {item.text}
                  </span>
                  {onRemoveQueued && (
                    <button
                      type="button"
                      onClick={() => onRemoveQueued(item.id)}
                      className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-[#333] hover:text-gray-200"
                      aria-label={`Remove queued prompt ${index + 1}`}
                    >
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="relative px-4 py-3">
          <input
            ref={inputRef}
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (showCommands && filteredCommands.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSelectedCommandIndex(
                    (i) => (i + 1) % filteredCommands.length,
                  );
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSelectedCommandIndex(
                    (i) =>
                      (i - 1 + filteredCommands.length) %
                      filteredCommands.length,
                  );
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  const pick =
                    filteredCommands[
                      Math.min(selectedCommandIndex, filteredCommands.length - 1)
                    ];
                  if (pick) applyCommand(pick.name);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setShowCommands(false);
                  return;
                }
              }
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
                  ? "Queue a follow-up… (Enter to queue, Esc to stop)"
                  : "Ask anything — or / for commands"
            }
            aria-label="Prompt input"
            aria-autocomplete="list"
            aria-expanded={showCommands && filteredCommands.length > 0}
          />
          {showCommands && filteredCommands.length > 0 && (
            <div
              className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-48 overflow-y-auto rounded-xl border border-[#3a3a3a] bg-[#1e1e1e] py-1 shadow-xl"
              role="listbox"
              aria-label="Available commands"
            >
              {filteredCommands.map((c, index) => (
                <button
                  key={c.name}
                  type="button"
                  role="option"
                  aria-selected={index === selectedCommandIndex}
                  onMouseEnter={() => setSelectedCommandIndex(index)}
                  onClick={() => applyCommand(c.name)}
                  className={`flex w-full flex-col px-3 py-2 text-left ${
                    index === selectedCommandIndex
                      ? "bg-[#2a2a2a]"
                      : "hover:bg-[#2a2a2a]"
                  }`}
                >
                  <span className="text-sm text-gray-200">/{c.name}</span>
                  {c.description && (
                    <span className="text-xs text-gray-500">{c.description}</span>
                  )}
                  {c.input?.hint && (
                    <span className="text-[11px] text-gray-600">
                      {c.input.hint}
                    </span>
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
          <div className="flex items-center space-x-2">
            {usage && usage.size > 0 && <ContextUsageRing usage={usage} />}
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
            {prompting && (
              <button
                type="button"
                onClick={() => void onCancel?.()}
                className="flex items-center gap-1 rounded-md bg-red-900/60 px-2.5 py-1.5 text-xs font-medium text-red-200 hover:bg-red-800/60"
                aria-label="Stop generation"
              >
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <rect x="5" y="5" width="10" height="10" rx="1" />
                </svg>
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              className="rounded-md bg-gray-600 p-1.5 text-gray-200 hover:bg-gray-500 disabled:opacity-40"
              aria-label={prompting ? "Queue prompt" : "Send prompt"}
              title={prompting ? "Queue follow-up (sends when agent finishes)" : "Send"}
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
          </div>
        </div>
      </div>
    </div>
  );
}

/** Format token counts compactly: 1234 → 1.2k, 1_200_000 → 1.2M. */
function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    const s = (k >= 100 ? Math.round(k).toString() : k.toFixed(1)).replace(
      /\.0$/,
      "",
    );
    return `${s}k`;
  }
  const m = n / 1_000_000;
  return `${m.toFixed(m >= 10 ? 1 : 2).replace(/\.?0+$/, "")}M`;
}

function formatCost(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(amount);
  } catch {
    return `${amount.toFixed(4)} ${currency}`;
  }
}

/** Ring color shifts as the context window fills. */
function usageRingColor(pct: number): string {
  if (pct >= 90) return "#ef4444"; // red
  if (pct >= 70) return "#f59e0b"; // amber
  return "#22c55e"; // green
}

/**
 * Circular context-window meter (left of effort selector).
 * Shows used/size fill; hover for token + cost details.
 */
function ContextUsageRing({ usage }: { usage: SessionUsage }) {
  const [open, setOpen] = useState(false);
  const pct = Math.min(100, Math.max(0, (usage.used / usage.size) * 100));
  const r = 7;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  const color = usageRingColor(pct);
  const label = `${formatTokens(usage.used)} / ${formatTokens(usage.size)} (${pct < 1 && usage.used > 0 ? "<1" : Math.round(pct)}%)`;

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[#2a2a2a]"
        aria-label={`Context usage: ${label}`}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0">
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            stroke="#3a3a3a"
            strokeWidth="2.5"
          />
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c - dash}`}
            transform="rotate(-90 9 9)"
            style={{ transition: "stroke-dasharray 0.3s ease, stroke 0.3s ease" }}
          />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full left-1/2 z-50 mb-2 w-52 -translate-x-1/2 rounded-lg border border-[#3a3a3a] bg-[#1e1e1e] px-3 py-2.5 shadow-xl">
          <div className="mb-2 flex items-center gap-2">
            <svg width="22" height="22" viewBox="0 0 18 18" className="shrink-0">
              <circle
                cx="9"
                cy="9"
                r={r}
                fill="none"
                stroke="#3a3a3a"
                strokeWidth="2.5"
              />
              <circle
                cx="9"
                cy="9"
                r={r}
                fill="none"
                stroke={color}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={`${dash} ${c - dash}`}
                transform="rotate(-90 9 9)"
              />
            </svg>
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-200">
                {Math.round(pct)}% context used
              </div>
              <div className="text-xs text-gray-500">
                {formatTokens(usage.used)} / {formatTokens(usage.size)} tokens
              </div>
            </div>
          </div>
          <div className="space-y-1 border-t border-[#2e2e2e] pt-2 text-xs text-gray-400">
            <div className="flex justify-between gap-3">
              <span>In context</span>
              <span className="tabular-nums text-gray-300">
                {usage.used.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Window size</span>
              <span className="tabular-nums text-gray-300">
                {usage.size.toLocaleString()}
              </span>
            </div>
            {usage.cost && (
              <div className="flex justify-between gap-3">
                <span>Session cost</span>
                <span className="tabular-nums text-gray-300">
                  {formatCost(usage.cost.amount, usage.cost.currency)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
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
