import { describe, expect, it } from "vitest";
import { rawTextFromContent, titleFromContext } from "./content-text";
import type { ContentBlock } from "./types";

describe("rawTextFromContent", () => {
  it("joins text blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    expect(rawTextFromContent(blocks)).toBe("Hello\n\nWorld");
  });

  it("includes resource text and links", () => {
    const blocks: ContentBlock[] = [
      {
        type: "resource",
        resource: { uri: "file://a.ts", text: "const x = 1" },
      },
      {
        type: "resource_link",
        uri: "https://example.com",
        name: "example",
        title: "Example",
      },
    ];
    expect(rawTextFromContent(blocks)).toContain("file://a.ts");
    expect(rawTextFromContent(blocks)).toContain("const x = 1");
    expect(rawTextFromContent(blocks)).toContain("Example");
  });

  it("returns empty for empty content", () => {
    expect(rawTextFromContent([])).toBe("");
  });
});

describe("titleFromContext", () => {
  it("truncates long text", () => {
    const long = "a".repeat(80);
    expect(titleFromContext(long, 20).length).toBeLessThanOrEqual(20);
    expect(titleFromContext(long, 20).endsWith("…")).toBe(true);
  });

  it("keeps short text", () => {
    expect(titleFromContext("short")).toBe("short");
  });
});
