import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "strict",
  fontFamily: "Inter, sans-serif",
});

const cache = new Map<string, string>();

/**
 * Renders a Mermaid diagram source string to SVG. Results are memoized per
 * source so streaming re-renders don't re-run the layout.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `m-${Math.random().toString(36).slice(2)}`;

    (async () => {
      try {
        let svg = cache.get(source);
        if (!svg) {
          const { svg: rendered } = await mermaid.render(id, source);
          svg = rendered;
          cache.set(source, svg);
        }
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
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
    <div className="my-3 flex justify-center overflow-x-auto rounded-xl border border-[#2e2e2e] bg-[#1e1e1e] p-4 [&_svg]:max-w-full">
      <div ref={ref} />
    </div>
  );
}
