import { describe, expect, it, vi } from "vitest";
import {
  audioBase64ToBlob,
  buildTranscriptionsUrl,
  DEFAULT_STT_SETTINGS,
  extractTranscriptText,
  fileNameForMime,
  isSttConfigured,
  normalizeSttSettings,
  transcribeAudio,
} from "./stt";

describe("normalizeSttSettings", () => {
  it("returns defaults for missing input", () => {
    expect(normalizeSttSettings(undefined)).toEqual(DEFAULT_STT_SETTINGS);
    expect(normalizeSttSettings(null)).toEqual(DEFAULT_STT_SETTINGS);
  });

  it("trims fields and keeps empty language", () => {
    expect(
      normalizeSttSettings({
        baseUrl: " https://api.example.com/ ",
        apiKey: "sk-test",
        model: "  custom-stt  ",
        language: "  ",
      }),
    ).toEqual({
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "custom-stt",
      language: "",
    });
  });

  it("defaults model when blank", () => {
    expect(
      normalizeSttSettings({
        baseUrl: "https://x",
        apiKey: "k",
        model: "  ",
        language: "en",
      }).model,
    ).toBe(DEFAULT_STT_SETTINGS.model);
  });
});

describe("isSttConfigured", () => {
  it("requires baseUrl and apiKey", () => {
    expect(isSttConfigured(undefined)).toBe(false);
    expect(isSttConfigured({ ...DEFAULT_STT_SETTINGS })).toBe(false);
    expect(
      isSttConfigured({
        ...DEFAULT_STT_SETTINGS,
        baseUrl: "https://x",
        apiKey: "",
      }),
    ).toBe(false);
    expect(
      isSttConfigured({
        ...DEFAULT_STT_SETTINGS,
        baseUrl: "https://x",
        apiKey: "k",
      }),
    ).toBe(true);
  });
});

describe("buildTranscriptionsUrl", () => {
  it("appends /v1/audio/transcriptions to root", () => {
    expect(buildTranscriptionsUrl("https://api.example.com")).toBe(
      "https://api.example.com/v1/audio/transcriptions",
    );
    expect(buildTranscriptionsUrl("https://api.example.com/")).toBe(
      "https://api.example.com/v1/audio/transcriptions",
    );
  });

  it("accepts base already ending in /v1", () => {
    expect(buildTranscriptionsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/audio/transcriptions",
    );
  });

  it("accepts full transcriptions path", () => {
    expect(
      buildTranscriptionsUrl(
        "https://api.example.com/v1/audio/transcriptions",
      ),
    ).toBe("https://api.example.com/v1/audio/transcriptions");
  });
});

describe("fileNameForMime / extractTranscriptText", () => {
  it("maps common mime types", () => {
    expect(fileNameForMime("audio/webm")).toBe("audio.webm");
    expect(fileNameForMime("audio/mpeg")).toBe("audio.mp3");
    expect(fileNameForMime("audio/wav", "clip.wav")).toBe("clip.wav");
  });

  it("extracts text from common shapes", () => {
    expect(extractTranscriptText({ text: " hello " })).toBe("hello");
    expect(extractTranscriptText({ transcript: "hi" })).toBe("hi");
    expect(extractTranscriptText({ transcript: { text: "nested" } })).toBe(
      "nested",
    );
    expect(extractTranscriptText("plain")).toBe("plain");
    expect(extractTranscriptText({})).toBeNull();
  });
});

describe("transcribeAudio", () => {
  it("rejects when not configured", async () => {
    const res = await transcribeAudio(
      { stt: { ...DEFAULT_STT_SETTINGS } },
      { audioBase64: "AAAA", mimeType: "audio/webm" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not configured/i);
  });

  it("posts multipart and returns text", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe("https://gw.example/v1/audio/transcriptions");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-secret");
      const body = init?.body as FormData;
      expect(body.get("model")).toBe("xai/grok-stt");
      expect(body.get("language")).toBe("en");
      expect(body.get("file")).toBeInstanceOf(Blob);
      return new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await transcribeAudio(
      {
        stt: {
          baseUrl: "https://gw.example",
          apiKey: "sk-secret",
          model: "xai/grok-stt",
          language: "en",
        },
      },
      {
        // "hi" as base64 is not real audio; blob decode still works for the form
        audioBase64: Buffer.from("fake-audio").toString("base64"),
        mimeType: "audio/webm",
      },
      fetchImpl as unknown as typeof fetch,
    );

    expect(res).toEqual({ ok: true, text: "hello world" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("surfaces HTTP errors", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
        }),
    );
    const res = await transcribeAudio(
      {
        stt: {
          baseUrl: "https://gw.example",
          apiKey: "bad",
          model: "m",
          language: "en",
        },
      },
      {
        audioBase64: Buffer.from("x").toString("base64"),
        mimeType: "audio/webm",
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/401.*bad key/i);
  });

  it("strips data-url prefix when decoding", () => {
    const b64 = Buffer.from("abc").toString("base64");
    const blob = audioBase64ToBlob(`data:audio/webm;base64,${b64}`, "audio/webm");
    expect(blob.type).toBe("audio/webm");
    expect(blob.size).toBe(3);
  });
});
