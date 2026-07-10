import { describe, expect, it } from "vitest";
import { qrToDataUrl, qrToSvg } from "./qrcode";

describe("qrcode", () => {
  it("encodes a short URL as SVG with modules", () => {
    const svg = qrToSvg("http://192.168.1.10:8743/r/abc123");
    expect(svg).toContain("<svg");
    expect(svg).toContain('fill="#000"');
    expect(svg).toMatch(/d="M/);
  });

  it("produces a data URL", () => {
    const url = qrToDataUrl("hello");
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    // Decodable base64 payload
    const b64 = url.slice("data:image/svg+xml;base64,".length);
    const svg = atob(b64);
    expect(svg).toContain("<svg");
  });
});
