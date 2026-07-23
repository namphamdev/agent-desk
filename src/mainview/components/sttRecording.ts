/**
 * Helpers for prompt-bar speech-to-text recording (MediaRecorder).
 * Pure enough to unit-test MIME pick + text merge without a real mic.
 */

/** Prefer webm/opus when the browser supports it (Chromium / WebView2). */
export function pickRecorderMimeType(
  isTypeSupported: (type: string) => boolean = (t) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const c of candidates) {
    try {
      if (isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** Append transcript to existing prompt text with a single space when needed. */
export function appendTranscript(existing: string, transcript: string): string {
  const t = transcript.trim();
  if (!t) return existing;
  const base = existing.replace(/\s+$/, "");
  if (!base) return t;
  // Avoid double space if existing already ends with punctuation + space handling
  return `${base} ${t}`;
}

/** Convert a Blob to base64 (no data: URL prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read audio"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read audio"));
    reader.readAsDataURL(blob);
  });
}

export function isSttReady(stt: {
  baseUrl?: string;
  apiKey?: string;
} | null | undefined): boolean {
  if (!stt) return false;
  return (
    (stt.baseUrl?.trim().length ?? 0) > 0 &&
    (stt.apiKey?.trim().length ?? 0) > 0
  );
}
