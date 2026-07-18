import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Download,
  Folder,
  Maximize2,
  Minus,
  MoreVertical,
  Plus,
  Search,
  Settings,
  Smartphone,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { SessionSummary } from "../../shared/rpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { reconcileProjectOrder } from "../projectOrder";

const MATRIX_TITLE = "Agent Desk";
const MATRIX_GLYPHS =
  "01ABCDEFGHIJKLMNOPQRSTUVWXYZアカサタナハマヤラワ#$%&@*+";

/** Matrix-style glyph scramble that settles into "Agent Desk". */
function MatrixTitle() {
  const [chars, setChars] = useState(() =>
    MATRIX_TITLE.split("").map((c) => (c === " " ? " " : "·")),
  );

  useEffect(() => {
    let frame = 0;
    let settleAt = 0;
    let holdUntil = 0;
    let phase: "scramble" | "hold" = "scramble";
    let raf = 0;
    let last = 0;

    const tick = (now: number) => {
      if (now - last < 40) {
        raf = requestAnimationFrame(tick);
        return;
      }
      last = now;

      if (phase === "hold") {
        if (now >= holdUntil) {
          phase = "scramble";
          frame = 0;
          settleAt = 0;
        }
        raf = requestAnimationFrame(tick);
        return;
      }

      frame += 1;
      // Cascade settle left → right, matrix-style.
      if (frame % 3 === 0) settleAt = Math.min(MATRIX_TITLE.length, settleAt + 1);

      setChars(
        MATRIX_TITLE.split("").map((target, i) => {
          if (target === " ") return " ";
          if (i < settleAt) return target;
          return MATRIX_GLYPHS[(Math.random() * MATRIX_GLYPHS.length) | 0]!;
        }),
      );

      if (settleAt >= MATRIX_TITLE.length) {
        phase = "hold";
        holdUntil = now + 2800;
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <span
      aria-label="Agent Desk"
      className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-500 dark:text-emerald-400"
      style={{
        textShadow: "0 0 8px color-mix(in oklab, var(--color-emerald-400) 55%, transparent)",
      }}
    >
      {chars.map((c, i) => (
        <span
          key={i}
          className={
            MATRIX_TITLE[i] === c || MATRIX_TITLE[i] === " "
              ? "opacity-100"
              : "opacity-55"
          }
        >
          {c === " " ? "\u00a0" : c}
        </span>
      ))}
    </span>
  );
}

type WindowControlAction = "close" | "minimize" | "maximize";

/** Sidebar status for a chat while/after an agent turn. */
export type SessionActivity = "processing" | "done";

type Props = {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /** Per-session activity for loading spinner / blue completion indicator. */
  sessionActivity?: Record<string, SessionActivity>;
  /** Pixel width; controlled by App when the sidebar is resizable. */
  width?: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewInProject?: (project: string) => void;
  /** Open the AI harness modal for a project. */
  onOpenHarness?: (project: string) => void;
  onDeleteProject?: (project: string) => void;
  onDeleteSession?: (id: string) => void;
  /** Kill ACP agent for this session to free memory (keeps history). */
  onOffloadSession?: (id: string) => void;
  onOpenSettings: () => void;
  /** Open skills management panel (install / enable / disable). */
  onOpenSkills?: () => void;
  /** Open user command panel (save / run shell commands + logs). */
  onOpenCommands?: () => void;
  /** Open remote-access panel (QR + LAN URL for phone browsers). */
  onOpenRemoteAccess?: () => void;
  onWindowControl?: (action: WindowControlAction) => void;
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function Sidebar({
  sessions,
  activeSessionId,
  sessionActivity = {},
  width,
  onSelect,
  onNew,
  onNewInProject,
  onOpenHarness,
  onDeleteProject,
  onDeleteSession,
  onOffloadSession,
  onOpenSettings,
  onOpenSkills,
  onOpenCommands,
  onOpenRemoteAccess,
  onWindowControl,
}: Props) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  /** Which project's ⋮ menu is open (null = closed). */
  const [menuProject, setMenuProject] = useState<string | null>(null);

  // Sticky project order: seed from session recency once, then keep relative
  // order so deleting a chat does not reshuffle project groups.
  useEffect(() => {
    setProjectOrder((prev) => {
      const next = reconcileProjectOrder(prev, sessions);
      if (
        next.length === prev.length &&
        next.every((p, i) => p === prev[i])
      ) {
        return prev;
      }
      return next;
    });
  }, [sessions]);

  const grouped = useMemo(() => {
    const filtered = query
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(query.toLowerCase()) ||
            s.project.toLowerCase().includes(query.toLowerCase()),
        )
      : sessions;
    const map = new Map<string, SessionSummary[]>();
    for (const s of filtered) {
      const key = s.project || "other";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    const entries = [...map.entries()];
    const indexed = new Map(entries);
    const ordered: [string, SessionSummary[]][] = [];
    for (const p of projectOrder) {
      const v = indexed.get(p);
      if (v) {
        ordered.push([p, v]);
        indexed.delete(p);
      }
    }
    for (const [p, v] of indexed) ordered.push([p, v]);
    return ordered;
  }, [sessions, query, projectOrder]);

  const moveProject = (project: string, dir: -1 | 1) => {
    const names = grouped.map(([p]) => p);
    const i = names.indexOf(project);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= names.length) return;
    const next = [...names];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setProjectOrder(next);
  };

  return (
    <aside
      className={`flex h-full min-h-0 flex-shrink-0 flex-col ${width == null ? "w-64" : ""}`}
      style={width != null ? { width } : undefined}
    >
      <div
        className="electrobun-webkit-app-region-drag flex h-12 items-center gap-2 px-3 sm:h-14 sm:px-4"
        onDoubleClick={(e) => {
          if (!onWindowControl) return;
          const target = e.target as HTMLElement | null;
          if (target?.closest(".electrobun-webkit-app-region-no-drag")) return;
          onWindowControl("maximize");
        }}
      >
        {onWindowControl && (
          <div className="electrobun-webkit-app-region-no-drag flex shrink-0 space-x-1.5">
            <button
              type="button"
              aria-label="Close"
              title="Close"
              onClick={() => void onWindowControl("close")}
              className="group flex h-3 w-3 items-center justify-center rounded-full bg-[#ff5f56] hover:brightness-110"
            >
              <X
                className="size-1.5 stroke-[3] text-black/55 opacity-0 group-hover:opacity-100"
                aria-hidden
              />
              <span className="sr-only">Close</span>
            </button>
            <button
              type="button"
              aria-label="Minimize"
              title="Minimize"
              onClick={() => void onWindowControl("minimize")}
              className="group flex h-3 w-3 items-center justify-center rounded-full bg-[#ffbd2e] hover:brightness-110"
            >
              <Minus
                className="size-1.5 stroke-[3] text-black/55 opacity-0 group-hover:opacity-100"
                aria-hidden
              />
              <span className="sr-only">Minimize</span>
            </button>
            <button
              type="button"
              aria-label="Maximize"
              title="Maximize"
              onClick={() => void onWindowControl("maximize")}
              className="group flex h-3 w-3 items-center justify-center rounded-full bg-[#27c93f] hover:brightness-110"
            >
              <Maximize2
                className="size-1.5 stroke-[3] text-black/55 opacity-0 group-hover:opacity-100"
                aria-hidden
              />
              <span className="sr-only">Maximize</span>
            </button>
          </div>
        )}
        <div className="flex flex-1 items-center justify-between gap-2 text-muted-foreground">
          <span className="flex min-w-0 items-center gap-2">
            <img
              src="./logo.png"
              alt="AgentDesk"
              width={18}
              height={18}
              className="h-[18px] w-[18px] shrink-0 rounded-[4px] object-cover"
              draggable={false}
            />
            <MatrixTitle />
          </span>
        </div>
      </div>

      <div className="electrobun-webkit-app-region-no-drag space-y-1 p-3">
        <QuickAction
          icon={<Plus className="h-4 w-4" aria-hidden />}
          label="New task"
          shortcut="⌘ N"
          onClick={onNew}
          title="Choose a project folder, workflow, and start a chat"
        />
        <QuickAction
          icon={<Search className="h-4 w-4" aria-hidden />}
          label="Search"
          shortcut="⌘ K"
          onClick={() => setSearchOpen((o) => !o)}
        />
        {onOpenSkills && (
          <QuickAction
            icon={<Sparkles className="h-4 w-4" aria-hidden />}
            label="Skills"
            onClick={onOpenSkills}
            title="Install and manage agent skills"
          />
        )}
        {onOpenCommands && (
          <QuickAction
            icon={<Terminal className="h-4 w-4" aria-hidden />}
            label="Commands"
            onClick={onOpenCommands}
            title="Save and run shell commands, view logs"
          />
        )}
      </div>

      {searchOpen && (
        <div className="px-3 pb-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            className="h-8 text-sm"
          />
        </div>
      )}

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {grouped.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            No sessions yet. New task → choose a project folder.
          </div>
        )}
        {grouped.map(([project, tasks], idx) => {
          const isCollapsed = collapsed.has(project);
          const menuOpen = menuProject === project;
          const canMoveUp = idx > 0;
          const canMoveDown = idx < grouped.length - 1;
          const toggleCollapse = () =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(project)) next.delete(project);
              else next.add(project);
              return next;
            });
          return (
          <div key={project} className="mb-4">
            <div className="group flex items-center justify-between px-4 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <button
                type="button"
                onClick={toggleCollapse}
                className="flex min-w-0 flex-1 items-center overflow-hidden"
                aria-expanded={!isCollapsed}
                title={isCollapsed ? "Expand" : "Collapse"}
              >
                <ChevronDown
                  className={`mr-1 h-3 w-3 shrink-0 transition-transform ${
                    isCollapsed ? "-rotate-90" : ""
                  }`}
                  aria-hidden
                />
                <Folder className="mr-1 h-3 w-3" aria-hidden />
                <span className="truncate">{project}</span>
              </button>
              <div
                className={`relative shrink-0 ${
                  menuOpen
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                }`}
              >
                <DropdownMenu
                  open={menuOpen}
                  onOpenChange={(open) =>
                    setMenuProject(open ? project : null)
                  }
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className={`text-muted-foreground ${
                        menuOpen ? "bg-muted text-foreground" : ""
                      }`}
                      aria-label="Project menu"
                      title="Project options"
                    >
                      <MoreVertical className="size-3.5" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[10.5rem]">
                    <DropdownMenuItem
                      onClick={() => onOpenHarness?.(project)}
                      className="text-xs"
                    >
                      <Sparkles className="size-3.5" aria-hidden />
                      AI harness
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => onNewInProject?.(project)}
                      className="text-xs"
                    >
                      <Plus className="size-3.5" aria-hidden />
                      New task
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={!canMoveUp}
                      onSelect={(e) => {
                        // Keep menu open so you can move multiple steps.
                        e.preventDefault();
                        moveProject(project, -1);
                      }}
                      className="text-xs"
                    >
                      <ChevronUp className="size-3.5" aria-hidden />
                      Move up
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canMoveDown}
                      onSelect={(e) => {
                        e.preventDefault();
                        moveProject(project, 1);
                      }}
                      className="text-xs"
                    >
                      <ChevronDown className="size-3.5" aria-hidden />
                      Move down
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onDeleteProject?.(project)}
                      className="text-xs"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            {!isCollapsed && (() => {
              const LIMIT = 5;
              const isExpanded = expanded.has(project);
              const visible = isExpanded ? tasks : tasks.slice(0, LIMIT);
              const hiddenCount = tasks.length - LIMIT;
              return (
            <>
            <div className="space-y-0.5">
              {visible.map((t) => {
                const isActive = t.id === activeSessionId;
                const activity = sessionActivity[t.id];
                return (
                  <div
                    key={t.id}
                    onClick={() => onSelect(t.id)}
                    className={`group flex w-full cursor-pointer items-center justify-between rounded-r-full px-6 py-1.5 pr-[8px] text-left text-sm ${
                      isActive
                        ? "mr-2 bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    <span className="truncate">{t.title}</span>
                    <span className="relative ml-2 flex shrink-0 items-center gap-1.5">
                      {/* Idle: show relative time (hidden on hover when actions appear). */}
                      {!activity && (
                        <span className="text-xs text-muted-foreground group-hover:opacity-0">
                          {timeAgo(t.updatedAt)}
                        </span>
                      )}
                      {/* Activity badge — also hide on hover so offload/delete stay visible. */}
                      {activity === "processing" && (
                        <span
                          role="status"
                          aria-label="Agent processing"
                          title="Agent processing"
                          className="inline-block h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent group-hover:opacity-0"
                        />
                      )}
                      {activity === "done" && (
                        <span
                          role="status"
                          aria-label="Turn complete"
                          title="Turn complete"
                          className="inline-block h-2 w-2 rounded-full bg-blue-500 group-hover:opacity-0"
                        />
                      )}
                      {/* Hover actions always available (offload only when agent is live). */}
                      <span className="absolute right-0 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        {t.agentRunning && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Offload agent"
                            title="Offload agent (free memory)"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOffloadSession?.(t.id);
                            }}
                            className="text-muted-foreground hover:text-amber-400"
                          >
                            <Download className="size-3.5" aria-hidden />
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Delete session"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSession?.(t.id);
                          }}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
            {hiddenCount > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(project)) next.delete(project);
                    else next.add(project);
                    return next;
                  })
                }
                className="ml-6 mt-0.5 h-auto px-1 text-xs text-muted-foreground"
              >
                {isExpanded ? "Show less" : `Show more (${hiddenCount})`}
              </Button>
            )}
            </>
            );
            })()}
          </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-border px-4 pb-[calc(1rem+8px)] pt-4">
        <div className="flex h-8 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary text-sm font-bold leading-none text-primary-foreground">
            AD
          </div>
          <span className="text-sm font-medium leading-none text-foreground">
            AgentDesk
          </span>
        </div>
        <div className="flex h-8 items-center gap-1">
          {onOpenRemoteAccess && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onOpenRemoteAccess}
              aria-label="Remote access"
              title="Remote access — open on phone"
            >
              <Smartphone className="size-5" aria-hidden />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={onOpenSettings}
            aria-label="Settings"
            title="Settings"
          >
            <Settings className="size-5" aria-hidden />
          </Button>
        </div>
      </div>
    </aside>
  );
}

function QuickAction({
  icon,
  label,
  shortcut,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      title={title}
      className="h-auto w-full justify-between px-2 py-1.5 text-sm font-normal text-foreground/80"
    >
      <span className="flex items-center space-x-2">
        {icon}
        <span>{label}</span>
      </span>
      {shortcut && (
        <span className="text-xs text-muted-foreground">{shortcut}</span>
      )}
    </Button>
  );
}
