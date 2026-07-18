import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { memo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { MermaidDiagram } from "./MermaidDiagram";

/**
 * Renders agent text as styled HTML: GFM tables/tasklists, syntax-highlighted
 * code fences, and Mermaid diagrams. Long fences collapse by default so a
 * dumped package.json doesn't dominate the timeline.
 *
 * remark-breaks keeps single newlines as <br> so Shift+Enter in the prompt
 * (and multi-line agent text) still show as multiple lines in the timeline.
 */

/**
 * Languages considered for auto-detect on unlabeled fences.
 * Full highlight.js ranking often mislabels JSON as Perl; keep this list
 * focused on languages agents emit and omit high false-positive grammars.
 * Must be registered in lowlight's `common` set (rehype-highlight default).
 */
const DETECT_SUBSET = [
  "json",
  "javascript",
  "typescript",
  "python",
  "bash",
  "shell",
  "xml", // also covers HTML
  "css",
  "yaml",
  "markdown",
  "sql",
  "diff",
  "rust",
  "go",
  "java",
  "kotlin",
  "swift",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "ini",
  "graphql",
] as const;

/** Fences longer than this start collapsed. */
const COLLAPSE_LINE_THRESHOLD = 12;

function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  return "";
}

function CodeBlock({
  className,
  language,
  children,
}: {
  className?: string;
  language?: string;
  children: ReactNode;
}) {
  const raw = extractText(children).replace(/\n$/, "");
  const lineCount = raw.length === 0 ? 0 : raw.split("\n").length;
  const collapsible = lineCount > COLLAPSE_LINE_THRESHOLD;
  const [expanded, setExpanded] = useState(!collapsible);

  const label = language && language !== "hljs" ? language : "code";

  return (
    <div className="code-block my-[0.9em] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--code-bg)]">
      <button
        type="button"
        onClick={() => {
          if (collapsible) setExpanded((e) => !e);
        }}
        className={`flex w-full items-center justify-between bg-[var(--bg-elevated)]/40 px-3 py-1.5 text-left text-xs ${
          collapsible ? "cursor-pointer hover:bg-[var(--bg-elevated)]" : "cursor-default"
        }`}
        aria-expanded={collapsible ? expanded : undefined}
      >
        <span className="flex items-center gap-2 font-mono text-[var(--text-muted)]">
          {collapsible && (
            <span className="text-[var(--text-faint)]" aria-hidden>
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </span>
          )}
          <span className="text-[var(--text-muted)]">{label}</span>
        </span>
        <span className="font-mono text-[11px] text-[var(--text-faint)]">
          {lineCount} {lineCount === 1 ? "line" : "lines"}
          {collapsible && !expanded ? " · click to expand" : ""}
        </span>
      </button>

      {expanded && (
        <pre className="m-0 overflow-x-auto rounded-none border-0 bg-transparent">
          <code className={className}>{children}</code>
        </pre>
      )}
    </div>
  );
}

// react-markdown component props are wide (HTML attrs + ExtraProps); keep loose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const code = (props: any) => {
  const { className, children } = props;
  const match = /language-(\w+)/.exec(className || "");
  const lang = match?.[1];
  const raw = extractText(children).replace(/\n$/, "");

  if (lang === "mermaid") {
    return <MermaidDiagram source={raw} />;
  }

  // Block fences get a class from rehype-highlight (`hljs` / `language-*`) or
  // contain newlines. Inline `code` has neither.
  const isBlock =
    Boolean(className?.includes("hljs") || className?.includes("language-")) ||
    raw.includes("\n");

  if (!isBlock) {
    return <code className={className}>{children}</code>;
  }

  return (
    <CodeBlock className={className} language={lang}>
      {children}
    </CodeBlock>
  );
};

/** Unwrap default <pre> — CodeBlock supplies its own chrome + <pre>. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pre = (props: any) => <>{props.children}</>;

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[
          [
            rehypeHighlight,
            {
              detect: true,
              ignoreMissing: true,
              subset: [...DETECT_SUBSET],
            },
          ],
        ]}
        components={{ code, pre }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
