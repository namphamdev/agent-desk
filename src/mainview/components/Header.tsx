import type { ConnectionStatePayload } from "../../shared/rpc";

type WindowControlAction = "close" | "minimize" | "maximize";

interface HeaderProps {
  title: string;
  project: string;
  /** Full project path shown on hover when available. */
  cwd?: string;
  /** Current git branch for the project folder, if any. */
  branch?: string | null;
  connection?: ConnectionStatePayload;
  onToggleSidebar?: () => void;
  onOpenSettings?: () => void;
  /**
   * Summarize this session's work and open a new chat to review it.
   * Only shown when `canReview` is true.
   */
  onReviewInNewSession?: () => void;
  /**
   * Enable the Review control when the loaded timeline has anything to review
   * (user goals, tools, agent replies — not only structured file diffs).
   */
  canReview?: boolean;
  /** True while creating the review session / sending the first prompt. */
  reviewBusy?: boolean;
  /**
   * When the sidebar is hidden, show traffic lights here.
   * Never used on remote/phone clients (pass false).
   */
  showWindowControls?: boolean;
  onWindowControl?: (action: WindowControlAction) => void;
  /** Compact mobile / remote layout (no window chrome, tighter chips). */
  compact?: boolean;
}

const statusColor: Record<string, string> = {
  idle: "bg-gray-500",
  connecting: "bg-amber-400 animate-pulse",
  ready: "bg-emerald-400",
  prompting: "bg-blue-400 animate-pulse",
  error: "bg-red-400",
  disconnected: "bg-gray-600",
};

/** Format agent RSS for the header chip (e.g. 142 MB, 1.2 GB). */
function formatRss(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    // Show one decimal under 100 MB for more signal while loading.
    return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  }
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function Header({
  title,
  project,
  cwd,
  branch,
  connection,
  onToggleSidebar,
  onOpenSettings,
  onReviewInNewSession,
  canReview = false,
  reviewBusy = false,
  showWindowControls,
  onWindowControl,
  compact = false,
}: HeaderProps) {
  const status = connection?.status ?? "idle";
  const folderName = cwd ? cwd.split("/").filter(Boolean).pop() : undefined;
  const memoryLabel = formatRss(connection?.memoryRssBytes);
  const agentLabel = connection?.agentName ?? status;
  const memoryTitle =
    memoryLabel && connection?.memorySampledAt
      ? `Agent RAM (process tree): ${memoryLabel}`
      : memoryLabel
        ? `Agent RAM: ${memoryLabel}`
        : undefined;
  const projectLabel = folderName ?? project;
  const showLights = Boolean(showWindowControls && onWindowControl && !compact);

  return (
    <header
      className={`electrobun-webkit-app-region-drag flex shrink-0 items-center justify-between gap-2 border-b border-[#2e2e2e] ${
        compact ? "h-12 px-3" : "h-14 px-4 sm:px-6"
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        {showLights && (
          <div className="electrobun-webkit-app-region-no-drag hidden shrink-0 space-x-1.5 sm:flex">
            <button
              type="button"
              aria-label="Close"
              title="Close"
              onClick={() => onWindowControl?.("close")}
              className="h-3 w-3 rounded-full bg-[#ff5f56] hover:brightness-110"
            />
            <button
              type="button"
              aria-label="Minimize"
              title="Minimize"
              onClick={() => onWindowControl?.("minimize")}
              className="h-3 w-3 rounded-full bg-[#ffbd2e] hover:brightness-110"
            />
            <button
              type="button"
              aria-label="Maximize"
              title="Maximize"
              onClick={() => onWindowControl?.("maximize")}
              className="h-3 w-3 rounded-full bg-[#27c93f] hover:brightness-110"
            />
          </div>
        )}
        <button
          type="button"
          onClick={onToggleSidebar}
          className={`electrobun-webkit-app-region-no-drag shrink-0 rounded p-1.5 text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200 ${
            compact ? "" : "md:hidden"
          }`}
          aria-label="Toggle sidebar"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>

        {/* Title + meta: stacked on narrow screens, row on sm+.
            justify-center is vertical only (flex-col); sm:justify-start keeps
            the row left-aligned once it switches to flex-row. */}
        <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5 text-left sm:flex-row sm:items-center sm:justify-start sm:gap-3">
          <h1
            className={`w-full min-w-0 truncate text-left font-semibold text-gray-100 sm:w-auto ${
              compact ? "text-[13px]" : "text-sm"
            }`}
            title={title}
          >
            {title}
          </h1>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-gray-400">
            {projectLabel && projectLabel !== "—" && (
              <span
                className="flex min-w-0 max-w-[40vw] items-center truncate rounded bg-[#2a2a2a] px-1.5 py-0.5 sm:max-w-[180px] sm:px-2 sm:py-1"
                title={cwd || project}
              >
                <svg
                  className="mr-1 hidden h-3 w-3 shrink-0 sm:block"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span className="truncate">{projectLabel}</span>
              </span>
            )}
            {branch && (
              <span
                className="hidden max-w-[100px] items-center truncate rounded bg-[#2a2a2a] px-2 py-1 sm:flex"
                title={`Git branch: ${branch}`}
              >
                <svg
                  className="mr-1 h-3 w-3 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                <span className="truncate">{branch}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="electrobun-webkit-app-region-no-drag flex shrink-0 items-center gap-1.5 text-gray-400 sm:gap-3">
        {connection && (
          <div
            className="flex items-center gap-1.5 rounded bg-[#2a2a2a] px-1.5 py-1 text-[11px] sm:px-2"
            title={
              connection.error ??
              ([agentLabel, memoryTitle].filter(Boolean).join(" · ") || status)
            }
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusColor[status] ?? "bg-gray-500"}`}
            />
            <span className="hidden max-w-[120px] truncate sm:inline">
              {agentLabel}
            </span>
            {memoryLabel && (
              <span
                className="hidden shrink-0 tabular-nums text-gray-500 md:inline"
                title={memoryTitle}
              >
                · {memoryLabel}
              </span>
            )}
          </div>
        )}
        {canReview && onReviewInNewSession && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-[#333] bg-[#222] px-2 py-1 text-[11px] text-gray-300 hover:border-gray-500 hover:bg-[#2a2a2a] hover:text-gray-100 disabled:opacity-50"
            onClick={() => onReviewInNewSession()}
            disabled={reviewBusy}
            title="Summarize this session's work and open a new chat to review it"
            aria-label="Review changes in new session"
          >
            <svg
              className="h-3.5 w-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
              <path d="M9 5a2 2 0 012-2h2a2 2 0 012 2v0a2 2 0 01-2 2h-2a2 2 0 01-2-2v0z" />
              <path d="M9 12h6M9 16h4" />
            </svg>
            <span className="hidden sm:inline">
              {reviewBusy ? "Starting…" : "Review"}
            </span>
          </button>
        )}
        <button
          type="button"
          className="rounded p-1.5 hover:bg-[#2a2a2a] hover:text-gray-200"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
