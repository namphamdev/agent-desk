import { describe, expect, it } from "vitest";
import {
  clickScript,
  fillScript,
  parseTrResultHash,
  typeScript,
} from "./panel-actions";

describe("panel-actions", () => {
  it("builds click selectors with quoted refs", () => {
    // JSON.stringify produces escaped quotes inside the generated JS string.
    expect(clickScript("e3")).toContain("data-tr-ref");
    expect(clickScript("e3")).toContain("e3");
  });

  it("builds type/fill scripts with text payloads", () => {
    expect(typeScript("e1", "hello", true)).toContain("hello");
    expect(typeScript("e1", "hello", true)).toContain("requestSubmit");
    expect(fillScript("e2", "world")).toContain("world");
  });

  it("parses tr-result hash payloads", () => {
    const payload = { ok: true, url: "https://x.com", snapshot: "hi" };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    const parsed = parseTrResultHash(`https://x.com/#tr-result=${b64}`);
    expect(parsed).toEqual(payload);
    expect(parseTrResultHash("https://x.com/")).toBeNull();
  });
});
