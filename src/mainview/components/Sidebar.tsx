import { useMemo, useState } from "react";
import type { SessionSummary } from "../../shared/rpc";

type Props = {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
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
  onSelect,
  onNew,
  onOpenSettings,
}: Props) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

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
    return [...map.entries()];
  }, [sessions, query]);

  return (
    <aside className="sidebar-bg flex w-64 flex-shrink-0 flex-col border-r border-[#2e2e2e]">
      <div className="flex h-14 items-center border-b border-[#2e2e2e] px-4">
        <div className="flex space-x-1.5">
          <div className="h-3 w-3 rounded-full bg-[#ff5f56]" />
          <div className="h-3 w-3 rounded-full bg-[#ffbd2e]" />
          <div className="h-3 w-3 rounded-full bg-[#27c93f]" />
        </div>
        <div className="flex flex-1 justify-end space-x-1 text-gray-500">
          <span className="text-[11px] uppercase tracking-wider">sessions</span>
        </div>
      </div>

      <div className="space-y-1 p-3">
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
        {grouped.map(([project, tasks]) => (
          <div key={project} className="mb-4">
            <div className="flex items-center px-4 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
              <FolderIcon />
              {project}
            </div>
            <div className="space-y-0.5">
              {tasks.map((t) => {
                const isActive = t.id === activeSessionId;
                return (
                  <button
                    key={t.id}
                    onClick={() => onSelect(t.id)}
                    className={`flex w-full justify-between rounded-r-full px-6 py-1.5 text-left text-sm ${
                      isActive
                        ? "mr-2 bg-[#3a3a3a] text-gray-200"
                        : "text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200"
                    }`}
                  >
                    <span className="truncate">{t.title}</span>
                    <span className="ml-2 shrink-0 text-xs text-gray-500">
                      {timeAgo(t.updatedAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
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
        <button
          className="text-gray-500 hover:text-gray-300"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <CogIcon />
        </button>
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
