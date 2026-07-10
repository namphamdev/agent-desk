import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../hooks/useSidebarResize";

type Props = {
  width: number;
  isResizing: boolean;
  onResizeStart: (e: ReactMouseEvent) => void;
  onNudge: (delta: number) => void;
};

export function SidebarResizeHandle({
  width,
  isResizing,
  onResizeStart,
  onNudge,
}: Props) {
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 32 : 16;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onNudge(e.key === "ArrowRight" ? step : -step);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      onMouseDown={onResizeStart}
      onKeyDown={onKeyDown}
      className={`group relative z-10 w-1 flex-shrink-0 cursor-col-resize touch-none outline-none ${
        isResizing ? "bg-blue-500/60" : "bg-transparent hover:bg-blue-500/40"
      }`}
    >
      {/* Wider hit target without shifting layout */}
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}
