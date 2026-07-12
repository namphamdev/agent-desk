import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

const BROWSER_WIDTH_KEY = "terminal-react.browserPanelWidth";
export const BROWSER_DEFAULT_WIDTH = 420;
export const BROWSER_MIN_WIDTH = 280;
export const BROWSER_MAX_WIDTH = 900;

function readBrowserWidth(): number {
  try {
    const raw = localStorage.getItem(BROWSER_WIDTH_KEY);
    if (raw == null) return BROWSER_DEFAULT_WIDTH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return BROWSER_DEFAULT_WIDTH;
    return Math.min(BROWSER_MAX_WIDTH, Math.max(BROWSER_MIN_WIDTH, Math.round(n)));
  } catch {
    return BROWSER_DEFAULT_WIDTH;
  }
}

export function clampBrowserWidth(width: number): number {
  return Math.min(BROWSER_MAX_WIDTH, Math.max(BROWSER_MIN_WIDTH, Math.round(width)));
}

function persistBrowserWidth(width: number): number {
  const clamped = clampBrowserWidth(width);
  try {
    localStorage.setItem(BROWSER_WIDTH_KEY, String(clamped));
  } catch {
    /* ignore */
  }
  return clamped;
}

/** Resize the right-side browser panel (drag left = wider). */
export function useBrowserPanelResize() {
  const [browserWidth, setBrowserWidth] = useState(readBrowserWidth);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [isResizingBrowser, setIsResizingBrowser] = useState(false);

  const handleBrowserResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      resizeRef.current = {
        startX: e.clientX,
        startWidth: browserWidth,
      };
      setIsResizingBrowser(true);
    },
    [browserWidth],
  );

  const nudgeBrowserWidth = useCallback((delta: number) => {
    setBrowserWidth((w) => persistBrowserWidth(w + delta));
  }, []);

  useEffect(() => {
    if (!isResizingBrowser) return;

    const onMove = (e: MouseEvent) => {
      const start = resizeRef.current;
      if (!start) return;
      // Handle is on the left edge of a right panel: drag left → wider.
      const next = clampBrowserWidth(
        start.startWidth + (start.startX - e.clientX),
      );
      setBrowserWidth(next);
    };

    const onUp = () => {
      resizeRef.current = null;
      setIsResizingBrowser(false);
      setBrowserWidth((w) => persistBrowserWidth(w));
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
  }, [isResizingBrowser]);

  return {
    browserWidth,
    isResizingBrowser,
    handleBrowserResizeStart,
    nudgeBrowserWidth,
  };
}
