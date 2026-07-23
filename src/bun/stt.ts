/**
 * Speech-to-text client: OpenAI-compatible batch transcriptions API.
 * POST {baseUrl}/v1/audio/transcriptions with multipart form fields.
 */
import type { AppSettings, SttSettings } from "../shared/rpc";

export const DEFAULT_STT_SETTINGS: SttSettings = {
  baseUrl: "",
  apiKey: "",
  model: "xai/grok-stt",
  language: "en",
};

/** Coerce partial / untrusted JSON into a clean SttSettings object. */
export function normalizeSttSettings(raw: unknown): SttSettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_STT_SETTINGS };
  }
  const p = raw as Partial<SttSettings>;
  return {
    baseUrl: typeof p.baseUrl === "string" ? p.baseUrl.trim() : "",
    apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
    model:
      typeof p.model === "string" && p.model.trim()
        ? p.model.trim()
        : DEFAULT_STT_SETTINGS.model,
    language:
      typeof p.language === "string" ? p.language.trim() : DEFAULT_STT_SETTINGS.language,
  };
}

/** True when base URL and API key are both non-empty. */
export function isSttConfigured(stt: SttSettings | null | undefined): boolean {
  if (!stt) return false;
  return stt.baseUrl.trim().length > 0 && stt.apiKey.trim().length > 0;
}

/**
 * Build the transcriptions endpoint from a base URL.
 * Accepts roots like `https://host` or full paths ending in `/v1`.
 */
export function buildTranscriptionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/\/v1\/audio\/transcriptions$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/audio/transcriptions`;
  return `${trimmed}/v1/audio/transcriptions`;
}

/** Pick a multipart filename from MIME type. */
export function fileNameForMime(
  mimeType: string,
  explicit?: string,
): string {
  if (explicit?.trim()) return explicit.trim();
  const lower = mimeType.toLowerCase();
  if (lower.includes("webm")) return "audio.webm";
  if (lower.includes("ogg")) return "audio.ogg";
  if (lower.includes("mp4") || lower.includes("m4a")) return "audio.m4a";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "audio.mp3";
  if (lower.includes("wav")) return "audio.wav";
  if (lower.includes("flac")) return "audio.flac";
  return "audio.bin";
}

export type TranscribeAudioParams = {
  audioBase64: string;
  mimeType: string;
  fileName?: string;
};

export type TranscribeAudioResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Extract transcript text from common provider JSON shapes.
 * OpenAI-style: `{ text: "..." }`. Some gateways nest under `transcript`.
 */
export function extractTranscriptText(body: unknown): string | null {
  if (body == null) return null;
  if (typeof body === "string") {
    const t = body.trim();
    return t || null;
  }
  if (typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
  if (typeof o.transcript === "string" && o.transcript.trim()) {
    return o.transcript.trim();
  }
  if (
    o.transcript &&
    typeof o.transcript === "object" &&
    typeof (o.transcript as { text?: unknown }).text === "string"
  ) {
    const t = ((o.transcript as { text: string }).text || "").trim();
    return t || null;
  }
  return null;
}

/** Decode base64 audio into a Blob for multipart upload. */
export function audioBase64ToBlob(
  audioBase64: string,
  mimeType: string,
): Blob {
  const cleaned = audioBase64.replace(/^data:[^;]+;base64,/, "").trim();
  const binary = Buffer.from(cleaned, "base64");
  return new Blob([binary], {
    type: mimeType.trim() || "application/octet-stream",
  });
}

/**
 * POST multipart transcription request. `fetchImpl` is injectable for tests.
 */
export async function transcribeAudio(
  settings: Pick<AppSettings, "stt"> | SttSettings,
  params: TranscribeAudioParams,
  fetchImpl: typeof fetch = fetch,
): Promise<TranscribeAudioResult> {
  const stt =
    "stt" in settings
      ? normalizeSttSettings(settings.stt)
      : normalizeSttSettings(settings);

  if (!isSttConfigured(stt)) {
    return {
      ok: false,
      error:
        "Speech-to-text is not configured. Set base URL and API key in Settings.",
    };
  }

  const audioBase64 = params.audioBase64?.trim() ?? "";
  if (!audioBase64) {
    return { ok: false, error: "No audio data to transcribe." };
  }

  const url = buildTranscriptionsUrl(stt.baseUrl);
  if (!url) {
    return { ok: false, error: "Invalid STT base URL." };
  }

  const mimeType = params.mimeType?.trim() || "application/octet-stream";
  const fileName = fileNameForMime(mimeType, params.fileName);
  const blob = audioBase64ToBlob(audioBase64, mimeType);

  const form = new FormData();
  form.append("file", blob, fileName);
  form.append("model", stt.model || DEFAULT_STT_SETTINGS.model);
  if (stt.language.trim()) {
    form.append("language", stt.language.trim());
  }

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stt.apiKey.trim()}`,
      },
      body: form,
    });

    const rawText = await res.text();
    let parsed: unknown = null;
    if (rawText.trim()) {
      try {
        parsed = JSON.parse(rawText) as unknown;
      } catch {
        parsed = rawText;
      }
    }

    if (!res.ok) {
      const detail =
        (parsed &&
          typeof parsed === "object" &&
          (typeof (parsed as { error?: { message?: string } }).error?.message ===
          "string"
            ? (parsed as { error: { message: string } }).error.message
            : typeof (parsed as { error?: string }).error === "string"
              ? (parsed as { error: string }).error
              : typeof (parsed as { message?: string }).message === "string"
                ? (parsed as { message: string }).message
                : null)) ||
        (typeof parsed === "string" ? parsed.slice(0, 300) : null) ||
        res.statusText ||
        `HTTP ${res.status}`;
      return {
        ok: false,
        error: `Transcription failed (${res.status}): ${detail}`,
      };
    }

    const text = extractTranscriptText(parsed);
    if (text == null) {
      return {
        ok: false,
        error: "Transcription response did not include text.",
      };
    }
    return { ok: true, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message || "Transcription request failed." };
  }
}
