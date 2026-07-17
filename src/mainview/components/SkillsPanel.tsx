import { useCallback, useMemo, useState } from "react";
import { RiDeleteBinLine } from "react-icons/ri";
import type { SkillInfo } from "../../shared/rpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !installing) onClose();
      }}
    >
      <DialogContent
        showCloseButton={true}
        className="flex h-[min(680px,90vh)] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onInteractOutside={(e) => {
          if (installing) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (installing) e.preventDefault();
        }}
      >
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between space-y-0 border-b border-border px-5 py-3 pr-12">
          <div>
            <DialogTitle id="skills-title">Skills</DialogTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {enabledCount} enabled · {skills.length} installed
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void onRefresh()}
            disabled={loading || installing}
            title="Refresh"
          >
            Refresh
          </Button>
        </DialogHeader>

        <div className="shrink-0 space-y-3 border-b border-border px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Install skill
            </span>
            <div className="flex gap-2">
              <Input
                value={packageSpec}
                onChange={(e) => setPackageSpec(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleInstall();
                }}
                placeholder="owner/repo or owner/repo@skill-name"
                disabled={installing}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                onClick={() => void handleInstall()}
                disabled={installing || !packageSpec.trim()}
                className="shrink-0"
              >
                {installing ? "Installing…" : "Install"}
              </Button>
            </div>
          </label>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Uses the Skills CLI globally (
            <code className="text-muted-foreground">npx skills add … -g</code>
            ). Browse packages at{" "}
            <span className="text-muted-foreground">skills.sh</span>.
          </p>

          {displayError && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {displayError}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
            className="min-w-0 flex-1"
          />
          <div className="flex shrink-0 rounded-md border border-border bg-muted/30 p-0.5 text-xs">
            {(
              [
                ["all", "All"],
                ["enabled", "On"],
                ["disabled", "Off"],
              ] as const
            ).map(([id, label]) => (
              <Button
                key={id}
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setFilter(id)}
                className={cn(
                  filter === id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && skills.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">
              Loading skills…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">
              {skills.length === 0
                ? "No skills installed yet. Add one above."
                : "No skills match your search."}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((skill) => {
                const busy = busyId === skill.id || installing;
                return (
                  <li
                    key={`${skill.scope}:${skill.id}`}
                    className="flex items-start gap-3 px-5 py-3 hover:bg-accent/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {skill.name}
                        </span>
                        {skill.scope === "project" && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            project
                          </span>
                        )}
                        {!skill.enabled && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-500/80">
                            off
                          </span>
                        )}
                      </div>
                      {skill.description && (
                        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {skill.description}
                        </p>
                      )}
                      <p
                        className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                        title={skill.path}
                      >
                        {skill.path}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 pt-0.5">
                      <Switch
                        checked={skill.enabled}
                        disabled={busy || skill.scope === "project"}
                        aria-label={
                          skill.enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`
                        }
                        onCheckedChange={(next) => void onToggle(skill.id, next)}
                      />
                      {skill.scope === "global" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
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
                          className="text-muted-foreground hover:text-destructive"
                          title="Uninstall"
                          aria-label={`Uninstall ${skill.name}`}
                        >
                          <RiDeleteBinLine className="h-4 w-4" aria-hidden />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
