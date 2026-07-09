import { useEffect, useRef, useState } from "react";

const cache = new Map<string, string>();
let mermaidReady: Promise<typeof import("mermaid")> | null = null;

function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        fontFamily: "Inter, sans-serif",
      });
      return mod;
    });
  }
  return mermaidReady;
}

/**
 * Lazily loads Mermaid and renders a diagram. Results are memoized per source
 * so streaming re-renders don't re-run the layout. Dynamic import keeps the
 * main bundle small (~1MB saved at first paint).
 */
export function MermaidDiagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cache.has(source));

  useEffect(() => {
    let cancelled = false;
    const id = `m-${Math.random().toString(36).slice(2)}`;

    (async () => {
      try {
        let svg = cache.get(source);
        if (!svg) {
          setLoading(true);
          const mermaid = await loadMermaid();
          const { svg: rendered } = await mermaid.default.render(id, source);
          svg = rendered;
          cache.set(source, svg);
        }
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setError(null);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
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
    <div className="my-3 flex min-h-[80px] justify-center overflow-x-auto rounded-xl border border-[#2e2e2e] bg-[#1e1e1e] p-4 [&_svg]:max-w-full">
      {loading && (
        <div className="self-center text-xs text-gray-500">Rendering diagram…</div>
      )}
      <div ref={ref} className={loading ? "hidden" : undefined} />
    </div>
  );
}
