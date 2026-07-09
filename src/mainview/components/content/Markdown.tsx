import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { memo } from "react";
import { MermaidDiagram } from "./MermaidDiagram";

/**
 * Renders agent text as styled HTML: GFM tables/tasklists, syntax-highlighted
 * code fences, and Mermaid diagrams. ```mermaid fences are intercepted before
 * rehype-highlight runs, since Mermaid source isn't a real language.
 */
function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  return "";
}

const code = (props: any) => {
  const { className, children } = props;
  const match = /language-(\w+)/.exec(className || "");
  const lang = match?.[1];
  const raw = extractText(children).replace(/\n$/, "");

  if (lang === "mermaid") {
    return <MermaidDiagram source={raw} />;
  }

  // Let rehype-highlight handle real languages; inline renders as <code>.
  return <code className={className}>{children}</code>;
};

const pre = (props: any) => <pre {...props} />;

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{ code, pre }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
