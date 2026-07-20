import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Code fences use highlight.js token classes (.hljs-*). Those colors must
 * follow the app theme: light github palette by default, dark palette only
 * under html.dark (applyDocumentTheme).
 */
describe("code-block highlight themes", () => {
  const css = readFileSync(join(import.meta.dirname, "index.css"), "utf8");

  it("imports the light github highlight theme as the base", () => {
    expect(css).toMatch(
      /@import\s+["']highlight\.js\/styles\/github\.css["']/,
    );
    // Unscoped dark theme would paint light mode with light-on-light tokens.
    expect(css).not.toMatch(
      /@import\s+["']highlight\.js\/styles\/github-dark\.css["']/,
    );
  });

  it("scopes dark syntax token colors under .dark", () => {
    expect(css).toMatch(/\.dark\s+\.hljs\s*\{/);
    expect(css).toMatch(/\.dark\s+\.hljs-keyword/);
    expect(css).toMatch(/\.dark\s+\.hljs-string/);
  });
});
