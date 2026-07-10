import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

const SIDEBAR_WIDTH_KEY = "terminal-react.sidebarWidth";
export const SIDEBAR_DEFAULT_WIDTH = 256; // w-64
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw == null) return SIDEBAR_DEFAULT_WIDTH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(n)));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function persistSidebarWidth(width: number): number {
  const clamped = clampSidebarWidth(width);
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
  } catch {
    /* ignore quota / private mode */
  }
  return clamped;
}

export function useSidebarResize() {
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const sidebarResizeRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  const handleSidebarResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      sidebarResizeRef.current = {
        startX: e.clientX,
        startWidth: sidebarWidth,
      };
      setIsResizingSidebar(true);
    },
    [sidebarWidth],
  );

  const nudgeSidebarWidth = useCallback((delta: number) => {
    setSidebarWidth((w) => persistSidebarWidth(w + delta));
  }, []);

  useEffect(() => {
    if (!isResizingSidebar) return;

    const onMove = (e: MouseEvent) => {
      const start = sidebarResizeRef.current;
      if (!start) return;
      const next = clampSidebarWidth(start.startWidth + (e.clientX - start.startX));
      setSidebarWidth(next);
    };

    const onUp = () => {
      sidebarResizeRef.current = null;
      setIsResizingSidebar(false);
      setSidebarWidth((w) => persistSidebarWidth(w));
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isResizingSidebar]);

  return {
    sidebarWidth,
    isResizingSidebar,
    handleSidebarResizeStart,
    nudgeSidebarWidth,
  };
}
