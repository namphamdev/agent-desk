import { useState } from "react";

interface SidebarProject {
  name: string;
  tasks: { title: string; ago: string; active?: boolean }[];
}

const projects: SidebarProject[] = [
  {
    name: "sonilo-web",
    tasks: [
      { title: "Backend supported video formats", ago: "13h" },
      { title: "Share to TikTok Flow", ago: "15h" },
    ],
  },
  {
    name: "frontend",
    tasks: [
      { title: "Music Variant Generation Progress UI", ago: "6m", active: true },
      { title: "Implement Add Phone Number Modal", ago: "2d" },
    ],
  },
  {
    name: "sonilo-app",
    tasks: [
      { title: "Fix SoniloDev iOS xcodebuild error", ago: "1d" },
      { title: "SSE audio streaming UI freeze", ago: "1d" },
      { title: "Sonilo Frontend Audio Wave Streaming", ago: "1d" },
      { title: "Read build.md Build Dev Debug Apps", ago: "1d" },
      { title: "Sonilo Web Audio Streaming Visualizati…", ago: "1d" },
    ],
  },
  { name: "aibg", tasks: [{ title: "check github.com/frieser/openc…", ago: "2d" }] },
  {
    name: "sonilo-mobile",
    tasks: [{ title: "Live Activity not showing on lockscree…", ago: "15d" }],
  },
];

export function Sidebar() {
  const [active, setActive] = useState("Music Variant Generation Progress UI");

  return (
    <aside className="sidebar-bg flex w-64 flex-shrink-0 flex-col border-r border-[#2e2e2e]">
      {/* Top action bar */}
      <div className="flex h-14 items-center border-b border-[#2e2e2e] px-4">
        <div className="flex space-x-1.5">
          <div className="h-3 w-3 rounded-full bg-[#ff5f56]" />
          <div className="h-3 w-3 rounded-full bg-[#ffbd2e]" />
          <div className="h-3 w-3 rounded-full bg-[#27c93f]" />
        </div>
        <div className="flex flex-1 justify-end space-x-1 text-gray-500">
          <button className="rounded p-1 hover:text-gray-300">
            <ChevronLeft />
          </button>
          <button className="rounded p-1 hover:text-gray-300">
            <ChevronRight />
          </button>
        </div>
      </div>

      {/* Quick actions */}
      <div className="space-y-1 p-3">
        <QuickAction icon={<PlusIcon />} label="New task" shortcut="⌘ N" />
        <QuickAction icon={<SearchIcon />} label="Search" shortcut="⌘ K" />
        <QuickAction icon={<BoltIcon />} label="Skills" />
      </div>

      {/* Project list */}
      <div className="mt-2 flex-1 overflow-y-auto">
        {projects.map((p) => (
          <div key={p.name} className="mb-4">
            <div className="flex items-center px-4 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
              <FolderIcon />
              {p.name}
            </div>
            <div className="space-y-0.5">
              {p.tasks.map((t) => {
                const isActive = t.title === active || t.active;
                return (
                  <button
                    key={t.title}
                    onClick={() => setActive(t.title)}
                    className={`flex w-full justify-between rounded-r-full px-6 py-1.5 text-left text-sm ${
                      isActive
                        ? "mr-2 bg-[#3a3a3a] text-gray-200"
                        : "text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200"
                    }`}
                  >
                    <span className="truncate">{t.title}</span>
                    <span className="ml-2 shrink-0 text-xs text-gray-500">{t.ago}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* User profile */}
      <div className="flex items-center justify-between border-t border-[#2e2e2e] p-4">
        <div className="flex items-center space-x-2">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-blue-600 text-sm font-bold text-white">
            N
          </div>
          <div className="flex items-center space-x-2 text-sm font-medium">
            <span>Nam Hoài</span>
            <span className="rounded border border-gray-600 bg-gray-700 px-1.5 py-0.5 text-[10px] text-gray-300">
              Max
            </span>
          </div>
        </div>
        <div className="flex space-x-2 text-gray-500">
          <button className="hover:text-gray-300">
            <PhoneIcon />
          </button>
          <button className="hover:text-gray-300">
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
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
}) {
  return (
    <button className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm text-gray-300 hover:bg-[#2a2a2a]">
      <span className="flex items-center space-x-2">
        {icon}
        <span>{label}</span>
      </span>
      {shortcut && <span className="text-xs text-gray-500">{shortcut}</span>}
    </button>
  );
}

/* Inline icons (kept tiny to match the original mockup's stroke style). */
const s = {
  className: "h-4 w-4",
  fill: "none",
  stroke: "currentColor",
  viewBox: "0 0 24 24",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const ChevronLeft = () => (
  <svg {...s}>
    <path d="M15 19l-7-7 7-7" />
  </svg>
);
const ChevronRight = () => (
  <svg {...s}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);
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
const BoltIcon = () => (
  <svg {...s}>
    <path d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
);
const FolderIcon = () => (
  <svg {...s} className="mr-1 h-3 w-3">
    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
  </svg>
);
const PhoneIcon = () => (
  <svg {...s} className="h-5 w-5">
    <path d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
  </svg>
);
const CogIcon = () => (
  <svg {...s} className="h-5 w-5">
    <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);
