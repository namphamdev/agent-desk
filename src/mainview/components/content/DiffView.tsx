import { diffLines } from "diff";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

interface DiffViewProps {
  path: string;
  oldText: string | null;
  newText: string;
}

/**
 * Renders a tool-call diff as a split line diff. `oldText === null` means a new
 * file (shown as all additions). File path header + added/removed line counts.
 */
export function DiffView({ path, oldText, newText }: DiffViewProps) {
  const [expanded, setExpanded] = useState(true);
  const parts = oldText === null ? [] : diffLines(oldText, newText);
  const newFile = oldText === null;

  const added = newFile
    ? newText.split("\n").length
    : parts.reduce((n, p) => n + (p.added ? p.value.split("\n").filter(Boolean).length : 0), 0);
  const removed = parts.reduce(
    (n, p) => n + (p.removed ? p.value.split("\n").filter(Boolean).length : 0),
    0,
  );

  const filename = path.split("/").pop();

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-[#2e2e2e] bg-[#161616]">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between bg-[#1d1d1d] px-3 py-2 text-left text-xs hover:bg-[#222]"
      >
        <span className="flex items-center gap-2 font-mono text-gray-300">
          <span className="text-gray-500" aria-hidden>
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
          {filename}
          {newFile && (
            <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] text-emerald-400">
              new
            </span>
          )}
        </span>
        <span className="flex gap-2 font-mono text-[11px]">
          <span className="text-emerald-400">+{added}</span>
          {!newFile && <span className="text-red-400">-{removed}</span>}
        </span>
      </button>

      {expanded && (
        <pre className="overflow-x-auto px-3 py-2 text-[12px] leading-relaxed">
          <code className="font-mono">
            {newFile ? (
              newText.split("\n").map((line, i) => (
                <div key={i} className="whitespace-pre bg-emerald-950/20 text-emerald-300">
                  <span className="select-none pr-3 text-emerald-700">+</span>
                  {line}
                </div>
              ))
            ) : (
              parts.map((part, i) =>
                part.value
                  .split("\n")
                  .filter((_, idx, arr) => !(idx === arr.length - 1 && part.value.endsWith("\n")))
                  .map((line, j) => {
                    const cls = part.added
                      ? "bg-emerald-950/20 text-emerald-300"
                      : part.removed
                        ? "bg-red-950/20 text-red-300"
                        : "text-gray-400";
                    const marker = part.added ? "+" : part.removed ? "-" : " ";
                    return (
                      <div key={`${i}-${j}`} className={`whitespace-pre ${cls}`}>
                        <span className="select-none pr-3 text-gray-600">{marker}</span>
                        {line}
                      </div>
                    );
                  }),
              )
            )}
          </code>
        </pre>
      )}
    </div>
  );
}
