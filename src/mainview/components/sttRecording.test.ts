import { describe, expect, it } from "vitest";
import {
  appendTranscript,
  isSttReady,
  pickRecorderMimeType,
} from "./sttRecording";

describe("pickRecorderMimeType", () => {
  it("returns first supported candidate", () => {
    expect(
      pickRecorderMimeType((t) => t === "audio/webm"),
    ).toBe("audio/webm");
  });

  it("returns empty when none supported", () => {
    expect(pickRecorderMimeType(() => false)).toBe("");
  });
});

describe("appendTranscript", () => {
  it("sets text when empty", () => {
    expect(appendTranscript("", "hello")).toBe("hello");
    expect(appendTranscript("  ", "hello")).toBe("hello");
  });

  it("appends with a space", () => {
    expect(appendTranscript("Fix the", "bug please")).toBe(
      "Fix the bug please",
    );
  });

  it("trims trailing space on existing", () => {
    expect(appendTranscript("Hello  ", "world")).toBe("Hello world");
  });

  it("ignores empty transcript", () => {
    expect(appendTranscript("keep", "  ")).toBe("keep");
  });
});

describe("isSttReady", () => {
  it("requires both fields", () => {
    expect(isSttReady(null)).toBe(false);
    expect(isSttReady({ baseUrl: "https://x", apiKey: "" })).toBe(false);
    expect(isSttReady({ baseUrl: "https://x", apiKey: "k" })).toBe(true);
  });
});
