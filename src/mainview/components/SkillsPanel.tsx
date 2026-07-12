import { useCallback, useEffect, useMemo, useState } from "react";
import { RiCloseLine, RiDeleteBinLine } from "react-icons/ri";
import type { SkillInfo } from "../../shared/rpc";

type Props = {
  skills: SkillInfo[];
  loading?: boolean;
  error?: string | null;
  busyId?: string | null;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
  onInstall: (packageSpec: string) => Promise<void>;
  onToggle: (skillId: string, enabled: boolean) => Promise<void>;
  onUninstall: (skillId: string) => Promise<void>;
};

export function SkillsPanel({
  skills,
  loading,
  error,
  busyId,
  onClose,
  onRefresh,
  onInstall,
  onToggle,
  onUninstall,
}: Props) {
  const [query, setQuery] = useState("");
  const [packageSpec, setPackageSpec] = useState("");
  const [installing, setInstalling] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !installing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [installing, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (filter === "enabled" && !s.enabled) return false;
      if (filter === "disabled" && s.enabled) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    });
  }, [skills, query, filter]);

  const enabledCount = skills.filter((s) => s.enabled).length;

  const handleInstall = useCallback(async () => {
    const spec = packageSpec.trim();
    if (!spec || installing) return;
    setInstalling(true);
    setLocalError(null);
    try {
      await onInstall(spec);
      setPackageSpec("");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }, [packageSpec, installing, onInstall]);

  const displayError = localError || error;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skills-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !installing) onClose();
      }}
    >
      <div className="flex h-[min(680px,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[#333] bg-[#1a1a1a] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-[#2e2e2e] px-5 py-3">
          <div>
            <h2
              id="skills-title"
              className="text-sm font-semibold text-gray-100"
            >
              Skills
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {enabledCount} enabled · {skills.length} installed
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onRefresh()}
              disabled={loading || installing}
              className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200 disabled:opacity-40"
              title="Refresh"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-gray-500 hover:bg-[#2a2a2a] hover:text-gray-200"
              aria-label="Close skills"
            >
              <RiCloseLine className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>

        <div className="shrink-0 space-y-3 border-b border-[#2e2e2e] px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-gray-500">
              Install skill
            </span>
            <div className="flex gap-2">
              <input
                value={packageSpec}
                onChange={(e) => setPackageSpec(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleInstall();
                }}
                placeholder="owner/repo or owner/repo@skill-name"
                disabled={installing}
                className="min-w-0 flex-1 rounded-md border border-[#333] bg-[#161616] px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void handleInstall()}
                disabled={installing || !packageSpec.trim()}
                className="shrink-0 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {installing ? "Installing…" : "Install"}
              </button>
            </div>
          </label>
          <p className="text-[11px] leading-relaxed text-gray-600">
            Uses the Skills CLI globally (
            <code className="text-gray-500">npx skills add … -g</code>
            ). Browse packages at{" "}
            <span className="text-gray-500">skills.sh</span>.
          </p>

          {displayError && (
            <div
              role="alert"
              className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300"
            >
              {displayError}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-b border-[#2e2e2e] px-5 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
            className="min-w-0 flex-1 rounded-md border border-[#333] bg-[#161616] px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-500"
          />
          <div className="flex shrink-0 rounded-md border border-[#333] bg-[#161616] p-0.5 text-xs">
            {(
              [
                ["all", "All"],
                ["enabled", "On"],
                ["disabled", "Off"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={`rounded px-2 py-1 ${
                  filter === id
                    ? "bg-[#2a2a2a] text-gray-100"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && skills.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-gray-500">
              Loading skills…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-gray-500">
              {skills.length === 0
                ? "No skills installed yet. Add one above."
                : "No skills match your search."}
            </div>
          ) : (
            <ul className="divide-y divide-[#2a2a2a]">
              {filtered.map((skill) => {
                const busy = busyId === skill.id || installing;
                return (
                  <li
                    key={`${skill.scope}:${skill.id}`}
                    className="flex items-start gap-3 px-5 py-3 hover:bg-[#1e1e1e]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-gray-100">
                          {skill.name}
                        </span>
                        {skill.scope === "project" && (
                          <span className="rounded bg-[#2a2a2a] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
                            project
                          </span>
                        )}
                        {!skill.enabled && (
                          <span className="rounded bg-[#2a2a2a] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-500/80">
                            off
                          </span>
                        )}
                      </div>
                      {skill.description && (
                        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-gray-500">
                          {skill.description}
                        </p>
                      )}
                      <p
                        className="mt-1 truncate font-mono text-[10px] text-gray-600"
                        title={skill.path}
                      >
                        {skill.path}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 pt-0.5">
                      <Toggle
                        checked={skill.enabled}
                        disabled={busy || skill.scope === "project"}
                        label={
                          skill.enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`
                        }
                        onChange={(next) => void onToggle(skill.id, next)}
                      />
                      {skill.scope === "global" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Uninstall “${skill.name}”? This deletes the skill folder.`,
                              )
                            ) {
                              return;
                            }
                            void onUninstall(skill.id);
                          }}
                          className="rounded p-1.5 text-gray-600 hover:bg-[#2a2a2a] hover:text-red-400 disabled:opacity-40"
                          title="Uninstall"
                          aria-label={`Uninstall ${skill.name}`}
                        >
                          <RiDeleteBinLine className="h-4 w-4" aria-hidden />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-blue-600" : "bg-[#3a3a3a]"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}
