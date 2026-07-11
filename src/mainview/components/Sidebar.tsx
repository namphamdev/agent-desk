import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../../shared/rpc";

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
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuProject) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = menuRef.current;
      if (el && !el.contains(e.target as Node)) {
        setMenuProject(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuProject(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuProject]);

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
      className={`flex flex-shrink-0 flex-col ${width == null ? "w-64" : ""}`}
      style={width != null ? { width } : undefined}
    >
      <div className="electrobun-webkit-app-region-drag flex h-12 items-center gap-2 px-3 sm:h-14 sm:px-4">
        {onWindowControl && (
          <div className="electrobun-webkit-app-region-no-drag flex shrink-0 space-x-1.5">
            <button
              type="button"
              aria-label="Close"
              title="Close"
              onClick={() => void onWindowControl("close")}
              className="group h-3 w-3 rounded-full bg-[#ff5f56] hover:brightness-110"
            >
              <span className="sr-only">Close</span>
            </button>
            <button
              type="button"
              aria-label="Minimize"
              title="Minimize"
              onClick={() => void onWindowControl("minimize")}
              className="group h-3 w-3 rounded-full bg-[#ffbd2e] hover:brightness-110"
            >
              <span className="sr-only">Minimize</span>
            </button>
            <button
              type="button"
              aria-label="Maximize"
              title="Maximize"
              onClick={() => void onWindowControl("maximize")}
              className="group h-3 w-3 rounded-full bg-[#27c93f] hover:brightness-110"
            >
              <span className="sr-only">Maximize</span>
            </button>
          </div>
        )}
        <div className="flex flex-1 items-center justify-between gap-2 text-gray-500">
          <span className="flex min-w-0 items-center gap-2">
            <img
              src="./logo.png"
              alt="AgentDesk"
              width={18}
              height={18}
              className="h-[18px] w-[18px] shrink-0 rounded-[4px] object-cover"
              draggable={false}
            />
            <span className="text-[11px] uppercase tracking-wider">
              sessions
            </span>
          </span>
        </div>
      </div>

      <div className="electrobun-webkit-app-region-no-drag space-y-1 p-3">
        <QuickAction
          icon={<PlusIcon />}
          label="New task"
          shortcut="⌘ N"
          onClick={onNew}
          title="Choose a project folder and start a chat"
        />
        <QuickAction
          icon={<SearchIcon />}
          label="Search"
          shortcut="⌘ K"
          onClick={() => setSearchOpen((o) => !o)}
        />
        {onOpenSkills && (
          <QuickAction
            icon={<SkillsIcon />}
            label="Skills"
            onClick={onOpenSkills}
            title="Install and manage agent skills"
          />
        )}
        {onOpenCommands && (
          <QuickAction
            icon={<CommandsIcon />}
            label="Commands"
            onClick={onOpenCommands}
            title="Save and run shell commands, view logs"
          />
        )}
      </div>

      {searchOpen && (
        <div className="px-3 pb-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            className="w-full rounded-md border border-[#333] bg-[#161616] px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-500"
          />
        </div>
      )}

      <div className="mt-2 flex-1 overflow-y-auto">
        {grouped.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-gray-600">
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
            <div className="group flex items-center justify-between px-4 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
              <button
                type="button"
                onClick={toggleCollapse}
                className="flex min-w-0 flex-1 items-center overflow-hidden"
                aria-expanded={!isCollapsed}
                title={isCollapsed ? "Expand" : "Collapse"}
              >
                <ChevronIcon
                  className={`mr-1 h-3 w-3 shrink-0 transition-transform ${
                    isCollapsed ? "-rotate-90" : ""
                  }`}
                />
                <FolderIcon />
                <span className="truncate">{project}</span>
              </button>
              <div
                className={`relative shrink-0 ${
                  menuOpen
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                }`}
                ref={menuOpen ? menuRef : undefined}
              >
                <button
                  type="button"
                  aria-label="Project menu"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  title="Project options"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuProject((cur) => (cur === project ? null : project));
                  }}
                  className={`rounded p-0.5 text-gray-500 hover:bg-[#2a2a2a] hover:text-gray-200 ${
                    menuOpen ? "bg-[#2a2a2a] text-gray-200" : ""
                  }`}
                >
                  <MoreMiniIcon />
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    aria-label={`${project} options`}
                    className="absolute right-0 top-full z-40 mt-1 min-w-[10.5rem] overflow-hidden rounded-lg border border-[#333] bg-[#1c1c1c] py-1 shadow-xl"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium normal-case tracking-normal text-gray-200 hover:bg-[#2a2a2a]"
                      onClick={() => {
                        setMenuProject(null);
                        onOpenHarness?.(project);
                      }}
                    >
                      <HarnessMiniIcon />
                      AI harness
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium normal-case tracking-normal text-gray-200 hover:bg-[#2a2a2a]"
                      onClick={() => {
                        setMenuProject(null);
                        onNewInProject?.(project);
                      }}
                    >
                      <PlusMiniIcon />
                      New task
                    </button>
                    <div className="my-1 border-t border-[#2e2e2e]" />
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!canMoveUp}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium normal-case tracking-normal text-gray-200 hover:bg-[#2a2a2a] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
                      onClick={() => {
                        moveProject(project, -1);
                        // Keep menu open so you can move multiple steps.
                      }}
                    >
                      <ChevronUpMiniIcon />
                      Move up
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!canMoveDown}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium normal-case tracking-normal text-gray-200 hover:bg-[#2a2a2a] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
                      onClick={() => {
                        moveProject(project, 1);
                      }}
                    >
                      <ChevronDownMiniIcon />
                      Move down
                    </button>
                    <div className="my-1 border-t border-[#2e2e2e]" />
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium normal-case tracking-normal text-red-400 hover:bg-[#2a2a2a]"
                      onClick={() => {
                        setMenuProject(null);
                        onDeleteProject?.(project);
                      }}
                    >
                      <TrashIcon />
                      Delete
                    </button>
                  </div>
                )}
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
                        ? "mr-2 bg-[#3a3a3a] text-gray-200"
                        : "text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200"
                    }`}
                  >
                    <span className="truncate">{t.title}</span>
                    <span className="relative ml-2 flex shrink-0 items-center gap-1.5">
                      {/* Idle: show relative time (hidden on hover when actions appear). */}
                      {!activity && (
                        <span className="text-xs text-gray-500 group-hover:opacity-0">
                          {timeAgo(t.updatedAt)}
                        </span>
                      )}
                      {/* Activity badge — also hide on hover so offload/delete stay visible. */}
                      {activity === "processing" && (
                        <span
                          role="status"
                          aria-label="Agent processing"
                          title="Agent processing"
                          className="inline-block h-3 w-3 animate-spin rounded-full border border-gray-400 border-t-transparent group-hover:opacity-0"
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
                          <button
                            type="button"
                            aria-label="Offload agent"
                            title="Offload agent (free memory)"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOffloadSession?.(t.id);
                            }}
                            className="text-gray-500 hover:text-amber-400"
                          >
                            <OffloadMiniIcon />
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label="Delete session"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSession?.(t.id);
                          }}
                          className="text-gray-500 hover:text-red-400"
                        >
                          <TrashMiniIcon />
                        </button>
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(project)) next.delete(project);
                    else next.add(project);
                    return next;
                  })
                }
                className="ml-6 mt-0.5 text-xs text-gray-500 hover:text-gray-300"
              >
                {isExpanded ? "Show less" : `Show more (${hiddenCount})`}
              </button>
            )}
            </>
            );
            })()}
          </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between border-t border-[#2e2e2e] p-4">
        <div className="flex items-center space-x-2">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-blue-600 text-sm font-bold text-white">
            TR
          </div>
          <div className="flex items-center space-x-2 text-sm font-medium">
            <span>terminal-react</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onOpenRemoteAccess && (
            <button
              type="button"
              className="text-gray-500 hover:text-gray-300"
              onClick={onOpenRemoteAccess}
              aria-label="Remote access"
              title="Remote access — open on phone"
            >
              <PhoneIcon />
            </button>
          )}
          <button
            type="button"
            className="text-gray-500 hover:text-gray-300"
            onClick={onOpenSettings}
            aria-label="Settings"
            title="Settings"
          >
            <CogIcon />
          </button>
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
    <button
      onClick={onClick}
      title={title}
      className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm text-gray-300 hover:bg-[#2a2a2a]"
    >
      <span className="flex items-center space-x-2">
        {icon}
        <span>{label}</span>
      </span>
      {shortcut && <span className="text-xs text-gray-500">{shortcut}</span>}
    </button>
  );
}

const s = {
  className: "h-4 w-4",
  fill: "none",
  stroke: "currentColor",
  viewBox: "0 0 24 24",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const PlusIcon = () => (
  <svg {...s}>
    <path d="M12 4v16m8-8H4" />
  </svg>
);
const PlusMiniIcon = () => (
  <svg {...s} className="h-3.5 w-3.5 shrink-0">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const ChevronUpMiniIcon = () => (
  <svg {...s} className="h-3.5 w-3.5 shrink-0">
    <path d="M18 15l-6-6-6 6" />
  </svg>
);
const ChevronDownMiniIcon = () => (
  <svg {...s} className="h-3.5 w-3.5 shrink-0">
    <path d="M6 9l6 6 6-6" />
  </svg>
);
/** Three-dot overflow menu for project actions. */
const MoreMiniIcon = () => (
  <svg {...s} className="h-3.5 w-3.5">
    <circle cx="12" cy="5" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.25" fill="currentColor" stroke="none" />
  </svg>
);
const TrashMiniIcon = () => (
  <svg {...s} className="h-3.5 w-3.5">
    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </svg>
);
/** Arrow-into-tray: unload agent process without deleting the chat. */
const OffloadMiniIcon = () => (
  <svg {...s} className="h-3.5 w-3.5">
    <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" />
  </svg>
);
/** Circuit / spark — project AI harness. */
const HarnessMiniIcon = () => (
  <svg {...s} className="h-3.5 w-3.5 shrink-0">
    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const ChevronIcon = ({ className }: { className?: string }) => (
  <svg
    {...s}
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);
const TrashIcon = () => (
  <svg {...s} className="h-3.5 w-3.5 shrink-0">
    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </svg>
);
const SearchIcon = () => (
  <svg {...s}>
    <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
);
const FolderIcon = () => (
  <svg {...s} className="mr-1 h-3 w-3">
    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
  </svg>
);
const CogIcon = () => (
  <svg {...s} className="h-5 w-5">
    <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);
/** Phone / remote access — outline smartphone. */
const PhoneIcon = () => (
  <svg {...s} className="h-5 w-5">
    <rect x="7" y="2" width="10" height="20" rx="2" />
    <path d="M11 18h2" />
  </svg>
);
/** Sparkles — agent skills. */
const SkillsIcon = () => (
  <svg {...s}>
    <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
    <path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z" />
    <path d="M5 14l.5 1.5L7 16l-1.5.5L5 18l-.5-1.5L3 16l1.5-.5L5 14z" />
  </svg>
);
/** Terminal prompt — user command panel. */
const CommandsIcon = () => (
  <svg {...s}>
    <path d="M4 17l6-5-6-5" />
    <path d="M12 19h8" />
  </svg>
);
