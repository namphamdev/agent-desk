import { describe, expect, it } from "vitest";
import { normalizeBrowserUrl } from "./BrowserPanel";

describe("normalizeBrowserUrl", () => {
  it("keeps http(s) URLs", () => {
    expect(normalizeBrowserUrl("https://example.com/a")).toBe(
      "https://example.com/a",
    );
    expect(normalizeBrowserUrl("http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
  });

  it("promotes bare hosts to https", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com");
    expect(normalizeBrowserUrl("  localhost:3000/path ")).toBe(
      "https://localhost:3000/path",
    );
  });

  it("rejects empty and non-http schemes", () => {
    expect(normalizeBrowserUrl("")).toBeNull();
    expect(normalizeBrowserUrl("   ")).toBeNull();
    expect(normalizeBrowserUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
  });

  it("allows about:blank", () => {
    expect(normalizeBrowserUrl("about:blank")).toBe("about:blank");
  });
});
