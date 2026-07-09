import type { ContentBlock } from "../../../session/types";
import { Markdown } from "./Markdown";

/** Renders a single ACP content block (text/image/resource/resource_link). */
export function Content({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "text":
      return <Markdown>{block.text}</Markdown>;

    case "image":
      return (
        <img
          src={`data:${block.mimeType};base64,${block.data}`}
          alt={block.uri ?? "agent image"}
          className="my-3 max-w-full rounded-lg border border-[#2e2e2e]"
        />
      );

    case "resource": {
      const r = block.resource;
      if ("text" in r) {
        return (
          <div className="my-2 rounded-lg border border-[#2e2e2e] bg-[#161616] p-3">
            <div className="mb-1 font-mono text-[11px] text-gray-500">{r.uri}</div>
            <pre className="overflow-x-auto text-xs text-gray-300">
              <code>{r.text}</code>
            </pre>
          </div>
        );
      }
      // blob resource
      return (
        <div className="my-2 rounded-lg border border-[#2e2e2e] bg-[#161616] p-3 font-mono text-xs text-gray-400">
          <span className="text-gray-500">blob:</span> {r.uri}{" "}
          <span className="text-gray-600">({r.mimeType ?? "unknown"})</span>
        </div>
      );
    }

    case "resource_link":
      return (
        <a
          href={block.uri}
          className="my-1 inline-flex items-center gap-1 rounded border border-[#333] bg-[#1e1e1e] px-2 py-1 text-xs text-blue-400 hover:bg-[#252525]"
        >
          <span className="text-gray-500">🔗</span>
          {block.title ?? block.name}
        </a>
      );

    default:
      return null;
  }
}
