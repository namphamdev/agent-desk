import type { ConnectionStatePayload } from "../../shared/rpc";

interface HeaderProps {
  title: string;
  project: string;
  /** Full project path shown on hover when available. */
  cwd?: string;
  branch: string;
  connection?: ConnectionStatePayload;
  onToggleSidebar?: () => void;
  onOpenSettings?: () => void;
}

const statusColor: Record<string, string> = {
  idle: "bg-gray-500",
  connecting: "bg-amber-400 animate-pulse",
  ready: "bg-emerald-400",
  prompting: "bg-blue-400 animate-pulse",
  error: "bg-red-400",
  disconnected: "bg-gray-600",
};

export function Header({
  title,
  project,
  cwd,
  branch,
  connection,
  onToggleSidebar,
  onOpenSettings,
}: HeaderProps) {
  const status = connection?.status ?? "idle";
  const folderName = cwd ? cwd.split("/").filter(Boolean).pop() : undefined;
  return (
    <header className="header-bg flex h-14 shrink-0 items-center justify-between border-b border-[#2e2e2e] px-6">
      <div className="flex items-center space-x-4">
        <button
          onClick={onToggleSidebar}
          className="rounded p-1 text-gray-500 hover:bg-[#2a2a2a] hover:text-gray-300 md:hidden"
          aria-label="Toggle sidebar"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <h1 className="max-w-md truncate text-sm font-semibold">{title}</h1>
        <div className="flex items-center space-x-2 text-xs text-gray-400">
          <span
            className="flex max-w-[220px] items-center truncate rounded bg-[#2a2a2a] px-2 py-1"
            title={cwd || project}
          >
            <svg className="mr-1 h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <span className="truncate">{folderName ?? project}</span>
          </span>
          <span className="flex items-center rounded bg-[#2a2a2a] px-2 py-1">
            <svg className="mr-1 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            {branch}
          </span>
        </div>
      </div>
      <div className="flex items-center space-x-3 text-gray-400">
        {connection && (
          <div
            className="flex items-center gap-1.5 rounded bg-[#2a2a2a] px-2 py-1 text-[11px]"
            title={connection.error ?? connection.agentName ?? status}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${statusColor[status] ?? "bg-gray-500"}`} />
            <span className="max-w-[120px] truncate">
              {connection.agentName ?? status}
            </span>
          </div>
        )}
        <button
          className="hover:text-gray-200"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
