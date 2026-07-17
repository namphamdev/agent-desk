import {
  RiFileList3Line,
  RiFolderLine,
  RiGitBranchLine,
  RiGlobalLine,
  RiMenuLine,
  RiSettings3Line,
} from "react-icons/ri";
import type { ConnectionStatePayload } from "../../shared/rpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
  /** Toggle the built-in browser panel (right of the chat view). */
  onToggleBrowser?: () => void;
  /** Whether the browser panel is open (styles the header control). */
  browserOpen?: boolean;
  /**
   * When false, the control stays visible but indicates no active chat
   * (click still runs onToggleBrowser — typically opens New task).
   */
  browserEnabled?: boolean;
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
  idle: "bg-muted-foreground/50",
  connecting: "bg-amber-400 animate-pulse",
  ready: "bg-emerald-400",
  prompting: "bg-blue-400 animate-pulse",
  error: "bg-red-400",
  disconnected: "bg-muted-foreground/70",
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
  onToggleBrowser,
  browserOpen = false,
  browserEnabled = true,
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
      className={`electrobun-webkit-app-region-drag flex shrink-0 items-center justify-between gap-2 border-b border-border ${
        compact ? "h-12 px-3" : "h-14 px-4 sm:px-6"
      }`}
      onDoubleClick={(e) => {
        if (!onWindowControl || compact) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest(".electrobun-webkit-app-region-no-drag")) return;
        onWindowControl("maximize");
      }}
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
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onToggleSidebar}
          className={`electrobun-webkit-app-region-no-drag shrink-0 text-muted-foreground ${
            compact ? "" : "md:hidden"
          }`}
          aria-label="Toggle sidebar"
        >
          <RiMenuLine className="size-5" aria-hidden />
        </Button>

        {/* Title + meta: stacked on narrow screens, row on sm+.
            justify-center is vertical only (flex-col); sm:justify-start keeps
            the row left-aligned once it switches to flex-row. */}
        <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5 text-left sm:flex-row sm:items-center sm:justify-start sm:gap-3">
          <h1
            className={`w-full min-w-0 truncate text-left font-semibold text-foreground sm:w-auto ${
              compact ? "text-[13px]" : "text-sm"
            }`}
            title={title}
          >
            {title}
          </h1>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {projectLabel && projectLabel !== "—" && (
              <span
                className="flex min-w-0 max-w-[40vw] items-center truncate rounded bg-muted px-1.5 py-0.5 sm:max-w-[180px] sm:px-2 sm:py-1"
                title={cwd || project}
              >
                <RiFolderLine
                  className="mr-1 hidden h-3 w-3 shrink-0 sm:block"
                  aria-hidden
                />
                <span className="truncate">{projectLabel}</span>
              </span>
            )}
            {branch && (
              <span
                className="hidden max-w-[100px] items-center truncate rounded bg-muted px-2 py-1 sm:flex"
                title={`Git branch: ${branch}`}
              >
                <RiGitBranchLine className="mr-1 h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{branch}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="electrobun-webkit-app-region-no-drag flex shrink-0 items-center gap-1.5 text-muted-foreground sm:gap-3">
        {connection && (
          <Badge
            variant="secondary"
            className="h-auto gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-normal sm:px-2"
            title={
              connection.error ??
              ([agentLabel, memoryTitle].filter(Boolean).join(" · ") || status)
            }
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusColor[status] ?? "bg-muted-foreground/50"}`}
            />
            <span className="hidden max-w-[120px] truncate sm:inline">
              {agentLabel}
            </span>
            {memoryLabel && (
              <span
                className="hidden shrink-0 tabular-nums text-muted-foreground md:inline"
                title={memoryTitle}
              >
                · {memoryLabel}
              </span>
            )}
          </Badge>
        )}
        {canReview && onReviewInNewSession && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="text-[11px] text-muted-foreground"
            onClick={() => onReviewInNewSession()}
            disabled={reviewBusy}
            title="Summarize this session's work and open a new chat to review it"
            aria-label="Review changes in new session"
          >
            <RiFileList3Line className="size-3.5 shrink-0" aria-hidden />
            <span className="hidden sm:inline">
              {reviewBusy ? "Starting…" : "Review"}
            </span>
          </Button>
        )}
        {onToggleBrowser && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={`text-muted-foreground ${
              browserOpen ? "bg-muted text-sky-400" : ""
            } ${!browserEnabled ? "opacity-60" : ""}`}
            onClick={onToggleBrowser}
            aria-label={
              !browserEnabled
                ? "Open a chat to use the browser"
                : browserOpen
                  ? "Close browser panel"
                  : "Open browser panel"
            }
            aria-pressed={browserOpen}
            title={
              !browserEnabled
                ? "Create or select a chat, then open the built-in browser"
                : browserOpen
                  ? "Close browser panel"
                  : "Open built-in browser panel"
            }
          >
            <RiGlobalLine className="size-5" aria-hidden />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <RiSettings3Line className="size-5" aria-hidden />
        </Button>
      </div>
    </header>
  );
}
