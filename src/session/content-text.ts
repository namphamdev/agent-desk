import type { ContentBlock } from "./types";

/**
 * Flatten ACP content blocks into plain text suitable for clipboard copy
 * or seeding a new thread's starting context.
 */
export function rawTextFromContent(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
        break;
      case "image":
        parts.push(`[image: ${block.mimeType}${block.uri ? ` ${block.uri}` : ""}]`);
        break;
      case "resource": {
        const r = block.resource;
        if ("text" in r) {
          parts.push(r.text ? `${r.uri}\n${r.text}` : r.uri);
        } else {
          parts.push(`[blob: ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ""}]`);
        }
        break;
      }
      case "resource_link":
        parts.push(block.title ?? block.name ?? block.uri);
        break;
    }
  }
  return parts.join("\n\n").trim();
}

/** Short title for a forked session from message text. */
export function titleFromContext(text: string, max = 48): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "New thread";
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
