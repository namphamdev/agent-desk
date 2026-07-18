import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const cache = new Map<string, string>();
let rendererReady: Promise<typeof import("beautiful-mermaid")> | null = null;

function loadRenderer() {
  if (!rendererReady) {
    rendererReady = import("beautiful-mermaid");
  }
  return rendererReady;
}

const THEME = {
  bg: "var(--code-bg)",
  fg: "var(--text)",
  muted: "var(--text-muted)",
  border: "var(--border)",
  surface: "var(--bg-elevated)",
  line: "var(--text-faint)",
  accent: "var(--link)",
  transparent: true,
  font: "Inter, system-ui, sans-serif",
} as const;

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
/** Toolbar / double-click zoom factor (gentler than discrete wheel steps). */
const BUTTON_ZOOM_STEP = 1.12;
/** Maps wheel delta (px) → log-scale change. Lower = slower zoom. */
const WHEEL_SENSITIVITY = 0.001;
/** Cap per-event scale change so a single notch never jumps hard. */
const WHEEL_MAX_FACTOR = 1.05;
const BUTTON_ZOOM_MS = 160;

type Transform = { x: number; y: number; scale: number };

function clampScale(scale: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Continuous, delta-proportional zoom factor from a wheel event. */
function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  let dy = deltaY;
  if (deltaMode === 1) dy *= 16; // lines → px
  else if (deltaMode === 2) dy *= 400; // pages → px
  // Ignore extreme spikes from some mice / OS settings.
  dy = Math.max(-100, Math.min(100, dy));
  let factor = Math.exp(-dy * WHEEL_SENSITIVITY);
  return Math.min(WHEEL_MAX_FACTOR, Math.max(1 / WHEEL_MAX_FACTOR, factor));
}

function transformCss(t: Transform): string {
  return `translate(calc(-50% + ${t.x}px), calc(-50% + ${t.y}px)) scale(${t.scale})`;
}

/**
 * Lazily loads beautiful-mermaid and renders a diagram to SVG. Results are
 * memoized per source so streaming re-renders don't re-run layout. Dynamic
 * import keeps the ELK layout engine out of the main bundle until a diagram
 * appears. Theme colors use app CSS variables so dark/light switches apply
 * without re-rendering.
 *
 * Inline preview has an "Open" control that launches a full-screen modal with
 * drag-to-pan and scroll-to-zoom.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(() => cache.get(source) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cache.has(source));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const cached = cache.get(source);
    if (cached) {
      setSvg(cached);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { renderMermaidSVG } = await loadRenderer();
        if (cancelled) return;
        const rendered = renderMermaidSVG(source, THEME);
        cache.set(source, rendered);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setSvg(null);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-red-900/50 bg-red-950/30 p-3 text-xs text-red-300">
        <div className="mb-1 font-medium">Mermaid render error</div>
        <pre className="whitespace-pre-wrap break-words">{error}</pre>
      </div>
    );
  }

  return (
    <>
      <div className="my-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--code-bg)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-elevated)]/40 px-3 py-1.5">
          <span className="font-mono text-xs text-[var(--text-muted)]">mermaid</span>
          <button
            type="button"
            disabled={!svg}
            onClick={() => setOpen(true)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Open
          </button>
        </div>

        <div className="flex min-h-[80px] justify-center overflow-x-auto p-4 [&_svg]:max-w-full">
          {loading && !svg && (
            <div className="self-center text-xs text-[var(--text-faint)]">
              Rendering diagram…
            </div>
          )}
          {svg && (
            <div
              className={loading ? "hidden" : "contents"}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </div>
      </div>

      {open && svg && (
        <DiagramModal svg={svg} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function DiagramModal({ svg, onClose }: { svg: string; onClose: () => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 1 });
  const [scalePct, setScalePct] = useState(100);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const animRef = useRef<number | null>(null);
  const pctRafRef = useRef<number | null>(null);

  /** Apply transform to the DOM immediately (smooth pan/zoom without React re-renders). */
  const applyTransform = useCallback((t: Transform, syncPct = false) => {
    transformRef.current = t;
    const el = contentRef.current;
    if (el) el.style.transform = transformCss(t);

    if (syncPct) {
      setScalePct(Math.round(t.scale * 100));
      return;
    }
    // Throttle % label updates to animation frames.
    if (pctRafRef.current == null) {
      pctRafRef.current = requestAnimationFrame(() => {
        pctRafRef.current = null;
        setScalePct(Math.round(transformRef.current.scale * 100));
      });
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      if (animRef.current != null) cancelAnimationFrame(animRef.current);
      if (pctRafRef.current != null) cancelAnimationFrame(pctRafRef.current);
    };
  }, [onClose]);

  // Non-passive wheel listener: continuous, delta-proportional zoom toward cursor.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      // Cancel button animations so wheel stays 1:1 with input.
      if (animRef.current != null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }

      const factor = wheelZoomFactor(e.deltaY, e.deltaMode);
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const t = transformRef.current;
      const next = clampScale(t.scale * factor);
      if (next === t.scale) return;
      // Keep the point under the cursor fixed while scaling.
      const worldX = (px - t.x) / t.scale;
      const worldY = (py - t.y) / t.scale;
      applyTransform({
        scale: next,
        x: px - worldX * next,
        y: py - worldY * next,
      });
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, [applyTransform]);

  /** Ease-out zoom animation for toolbar / double-click (not used for wheel). */
  const animateToScaleAt = useCallback(
    (clientX: number, clientY: number, targetScale: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const start = { ...transformRef.current };
      const endScale = clampScale(targetScale);
      if (endScale === start.scale) return;

      const worldX = (px - start.x) / start.scale;
      const worldY = (py - start.y) / start.scale;
      const end: Transform = {
        scale: endScale,
        x: px - worldX * endScale,
        y: py - worldY * endScale,
      };

      if (animRef.current != null) cancelAnimationFrame(animRef.current);
      const t0 = performance.now();

      const tick = (now: number) => {
        const u = Math.min(1, (now - t0) / BUTTON_ZOOM_MS);
        // ease-out cubic
        const e = 1 - (1 - u) ** 3;
        applyTransform({
          scale: start.scale + (end.scale - start.scale) * e,
          x: start.x + (end.x - start.x) * e,
          y: start.y + (end.y - start.y) * e,
        });
        if (u < 1) {
          animRef.current = requestAnimationFrame(tick);
        } else {
          animRef.current = null;
          applyTransform(end, true);
        }
      };
      animRef.current = requestAnimationFrame(tick);
    },
    [applyTransform],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const t = transformRef.current;
      animateToScaleAt(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        t.scale * factor,
      );
    },
    [animateToScaleAt],
  );

  const reset = useCallback(() => {
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    const start = { ...transformRef.current };
    const end: Transform = { x: 0, y: 0, scale: 1 };
    if (start.x === 0 && start.y === 0 && start.scale === 1) return;

    const t0 = performance.now();
    const tick = (now: number) => {
      const u = Math.min(1, (now - t0) / BUTTON_ZOOM_MS);
      const e = 1 - (1 - u) ** 3;
      applyTransform({
        scale: start.scale + (end.scale - start.scale) * e,
        x: start.x + (end.x - start.x) * e,
        y: start.y + (end.y - start.y) * e,
      });
      if (u < 1) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        animRef.current = null;
        applyTransform(end, true);
      }
    };
    animRef.current = requestAnimationFrame(tick);
  }, [applyTransform]);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if (animRef.current != null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = transformRef.current;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: t.x,
      originY: t.y,
    };
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      applyTransform({
        ...transformRef.current,
        x: drag.originX + (e.clientX - drag.startX),
        y: drag.originY + (e.clientY - drag.startY),
      });
    },
    [applyTransform],
  );

  const endDrag = useCallback((e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram viewer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--bg-app)] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-[var(--text)]">Diagram</span>
          <span className="font-mono text-xs text-[var(--text-faint)]">{scalePct}%</span>
        </div>

        <div className="flex items-center gap-1.5">
          <ToolbarButton label="Zoom out" onClick={() => zoomBy(1 / BUTTON_ZOOM_STEP)}>
            −
          </ToolbarButton>
          <ToolbarButton label="Zoom in" onClick={() => zoomBy(BUTTON_ZOOM_STEP)}>
            +
          </ToolbarButton>
          <ToolbarButton label="Reset view" onClick={reset}>
            Reset
          </ToolbarButton>
          <div className="mx-1 h-4 w-px bg-[var(--border)]" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className={`relative min-h-0 flex-1 overflow-hidden bg-[var(--code-bg)] ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => {
          const factor = e.shiftKey ? 1 / BUTTON_ZOOM_STEP : BUTTON_ZOOM_STEP;
          animateToScaleAt(e.clientX, e.clientY, transformRef.current.scale * factor);
        }}
      >
        <div
          ref={contentRef}
          className="absolute left-1/2 top-1/2 origin-center will-change-transform [&_svg]:max-w-none [&_svg]:select-none"
          style={{ transform: transformCss(transformRef.current) }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />

        <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--bg-app)]/90 px-3 py-1 text-[11px] text-[var(--text-faint)]">
          Drag to pan · Scroll to zoom · Esc to close
        </p>
      </div>
    </div>,
    document.body,
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="min-w-[28px] rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
    >
      {children}
    </button>
  );
}
