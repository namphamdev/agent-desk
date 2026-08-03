import type { Env } from "./env";

export const MAX_SETTINGS_BYTES = 1 * 1024 * 1024; // 1MiB max request size

const textDecoder = new TextDecoder();

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });

/**
 * Decode a base64 string into a 32-byte Uint8Array for AES-256 keys.
 * Returns null if base64 is invalid or byte length is not 32.
 */
export const decodeBase64Key = (base64?: string): Uint8Array | null => {
  if (!base64) return null;
  const trimmed = base64.trim();
  if (!trimmed) return null;
  try {
    const binary = atob(trimmed);
    if (binary.length !== 32) return null;
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
};

export const getSettingsCryptoKey = async (base64Key?: string): Promise<CryptoKey | null> => {
  const rawKey = decodeBase64Key(base64Key);
  if (!rawKey) return null;
  try {
    return await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  } catch {
    return null;
  }
};

export const encryptSettings = async (
  key: CryptoKey,
  plaintext: Uint8Array
): Promise<Uint8Array> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );
  const ciphertextBytes = new Uint8Array(ciphertextBuffer);
  const result = new Uint8Array(iv.length + ciphertextBytes.length);
  result.set(iv, 0);
  result.set(ciphertextBytes, iv.length);
  return result;
};

export const decryptSettings = async (
  key: CryptoKey,
  data: Uint8Array
): Promise<Uint8Array | null> => {
  if (data.length < 12) return null;
  const iv = data.subarray(0, 12);
  const ciphertext = data.subarray(12);
  try {
    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new Uint8Array(plaintextBuffer);
  } catch {
    return null;
  }
};

export const handleAccountSettings = async (
  request: Request,
  env: Env,
  userId: string
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "PUT") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const cryptoKey = await getSettingsCryptoKey(env.SETTINGS_ENCRYPTION_KEY);
  if (!cryptoKey) {
    return json({ error: "service_unavailable" }, 503);
  }

  const r2Key = `settings/${userId}`;

  if (request.method === "GET") {
    const object = await env.BLOBS.get(r2Key);
    if (!object) {
      return json({ error: "not_found" }, 404);
    }
    const encryptedBytes = new Uint8Array(await object.arrayBuffer());
    const decryptedBytes = await decryptSettings(cryptoKey, encryptedBytes);
    if (!decryptedBytes) {
      return json({ error: "service_unavailable" }, 503);
    }
    return new Response(decryptedBytes, {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  if (request.method === "PUT") {
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_SETTINGS_BYTES) {
      return json({ error: "too_large" }, 413);
    }

    const bodyBuffer = await request.arrayBuffer();
    if (bodyBuffer.byteLength > MAX_SETTINGS_BYTES) {
      return json({ error: "too_large" }, 413);
    }

    const bodyBytes = new Uint8Array(bodyBuffer);
    try {
      JSON.parse(textDecoder.decode(bodyBytes));
    } catch {
      return json({ error: "bad_request" }, 400);
    }

    const encryptedBytes = await encryptSettings(cryptoKey, bodyBytes);
    await env.BLOBS.put(r2Key, encryptedBytes, {
      httpMetadata: { contentType: "application/json" }
    });

    return json({ ok: true });
  }

  return json({ error: "method_not_allowed" }, 405);
};
