import { describe, expect, it } from "vitest";
import {
  BROWSER_MCP_USAGE_HINT,
  formatBrowserTokensForPrompt,
  injectBrowserTokensIntoPrompt,
} from "./browser-tokens";
import type { BrowserTokenRecord } from "./store";

function tok(
  partial: Partial<BrowserTokenRecord> & Pick<BrowserTokenRecord, "key" | "value">,
): BrowserTokenRecord {
  return {
    id: "id",
    projectCwd: "/p",
    domain: "",
    label: "",
    sessionId: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("browser-tokens prompt injection", () => {
  it("returns null for empty list", () => {
    expect(formatBrowserTokensForPrompt([])).toBeNull();
  });

  it("always prepends browser MCP usage hint so agents use tools not curl", () => {
    const full = injectBrowserTokensIntoPrompt("hello", []);
    expect(full.startsWith(BROWSER_MCP_USAGE_HINT)).toBe(true);
    expect(full.endsWith("hello")).toBe(true);
    expect(full).toContain("browser_navigate");
  });

  it("can skip the usage hint when requested", () => {
    expect(
      injectBrowserTokensIntoPrompt("hello", [], { includeUsageHint: false }),
    ).toBe("hello");
  });

  it("formats keys and values and prepends to the user prompt", () => {
    const block = formatBrowserTokensForPrompt([
      tok({
        key: "oauth_access_token",
        value: "abc123",
        label: "GitHub",
        domain: "github.com",
      }),
    ]);
    expect(block).toContain("oauth_access_token");
    expect(block).toContain("abc123");
    expect(block).toContain("GitHub");
    expect(block).toContain("github.com");

    const full = injectBrowserTokensIntoPrompt("do the thing", [
      tok({ key: "api_key", value: "k" }),
    ]);
    expect(full.startsWith(BROWSER_MCP_USAGE_HINT)).toBe(true);
    expect(full).toContain("[Stored browser tokens");
    expect(full.endsWith("do the thing")).toBe(true);
    expect(full).toContain("api_key: k");
  });
});
