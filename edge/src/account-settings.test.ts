import { describe, expect, it } from "vitest";
import {
  decodeBase64Key,
  getSettingsCryptoKey,
  encryptSettings,
  decryptSettings,
  handleAccountSettings,
  MAX_SETTINGS_BYTES
} from "./account-settings";
import type { Env } from "./env";

// Valid 32-byte key base64-encoded (32 bytes of 0x01..0x20)
const VALID_KEY_BYTES = new Uint8Array(32);
for (let i = 0; i < 32; i++) VALID_KEY_BYTES[i] = i + 1;
const VALID_KEY_BASE64 = btoa(String.fromCharCode(...VALID_KEY_BYTES));

// 16-byte key base64-encoded (invalid length)
const SHORT_KEY_BASE64 = btoa("1234567890123456");

class MockR2Bucket {
  private store = new Map<string, Uint8Array>();

  async put(key: string, value: ArrayBuffer | Uint8Array): Promise<void> {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.store.set(key, bytes);
  }

  async get(key: string) {
    const data = this.store.get(key);
    if (!data) return null;
    return {
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    };
  }
}

describe("account settings encryption & key validation", () => {
  it("decodes valid 32-byte base64 key", () => {
    const decoded = decodeBase64Key(VALID_KEY_BASE64);
    expect(decoded).not.toBeNull();
    expect(decoded?.length).toBe(32);
    expect(decoded?.[0]).toBe(1);
    expect(decoded?.[31]).toBe(32);
  });

  it("rejects missing, empty, or invalid base64 key", () => {
    expect(decodeBase64Key(undefined)).toBeNull();
    expect(decodeBase64Key("")).toBeNull();
    expect(decodeBase64Key("   ")).toBeNull();
    expect(decodeBase64Key("not-valid-base64-!@#$%")).toBeNull();
  });

  it("rejects key that is not 32 bytes long", () => {
    expect(decodeBase64Key(SHORT_KEY_BASE64)).toBeNull();
  });

  it("round-trips encryption and decryption with a valid key", async () => {
    const key = await getSettingsCryptoKey(VALID_KEY_BASE64);
    expect(key).not.toBeNull();
    if (!key) return;

    const plaintext = new TextEncoder().encode(JSON.stringify({ theme: "dark", fontSize: 14 }));
    const encrypted = await encryptSettings(key, plaintext);

    expect(encrypted.length).toBeGreaterThan(12);

    const decrypted = await decryptSettings(key, encrypted);
    expect(decrypted).not.toBeNull();
    if (!decrypted) return;

    const parsed = JSON.parse(new TextDecoder().decode(decrypted));
    expect(parsed).toEqual({ theme: "dark", fontSize: 14 });
  });

  it("fails to decrypt data with wrong key", async () => {
    const key1 = await getSettingsCryptoKey(VALID_KEY_BASE64);
    const OTHER_KEY_BYTES = new Uint8Array(32).fill(7);
    const key2 = await getSettingsCryptoKey(btoa(String.fromCharCode(...OTHER_KEY_BYTES)));

    expect(key1).not.toBeNull();
    expect(key2).not.toBeNull();
    if (!key1 || !key2) return;

    const plaintext = new TextEncoder().encode("secret data");
    const encrypted = await encryptSettings(key1, plaintext);

    const decrypted = await decryptSettings(key2, encrypted);
    expect(decrypted).toBeNull();
  });

  it("returns null when decrypting truncated data (< 12 bytes)", async () => {
    const key = await getSettingsCryptoKey(VALID_KEY_BASE64);
    expect(key).not.toBeNull();
    if (!key) return;

    const decrypted = await decryptSettings(key, new Uint8Array([1, 2, 3]));
    expect(decrypted).toBeNull();
  });
});

describe("account settings endpoint handler", () => {
  const createMockEnv = (key?: string) => {
    const mockR2 = new MockR2Bucket();
    return {
      env: {
        SETTINGS_ENCRYPTION_KEY: key,
        BLOBS: mockR2 as unknown as R2Bucket
      } as Env,
      mockR2
    };
  };

  it("returns 503 when SETTINGS_ENCRYPTION_KEY is missing or invalid", async () => {
    const { env } = createMockEnv(undefined);
    const req = new Request("https://edge.comet/account-settings", { method: "GET" });
    const res = await handleAccountSettings(req, env, "user_123");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "service_unavailable" });
  });

  it("returns 404 when settings blob does not exist", async () => {
    const { env } = createMockEnv(VALID_KEY_BASE64);
    const req = new Request("https://edge.comet/account-settings", { method: "GET" });
    const res = await handleAccountSettings(req, env, "user_123");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
  });

  it("returns 405 for unsupported HTTP methods", async () => {
    const { env } = createMockEnv(VALID_KEY_BASE64);
    const req = new Request("https://edge.comet/account-settings", { method: "DELETE" });
    const res = await handleAccountSettings(req, env, "user_123");
    expect(res.status).toBe(405);
  });

  it("returns 400 when PUT payload is not valid JSON", async () => {
    const { env } = createMockEnv(VALID_KEY_BASE64);
    const req = new Request("https://edge.comet/account-settings", {
      method: "PUT",
      body: "not json content {"
    });
    const res = await handleAccountSettings(req, env, "user_123");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "bad_request" });
  });

  it("returns 413 when PUT payload exceeds 1MiB limit", async () => {
    const { env } = createMockEnv(VALID_KEY_BASE64);
    const largeBody = "x".repeat(MAX_SETTINGS_BYTES + 1);
    const req = new Request("https://edge.comet/account-settings", {
      method: "PUT",
      body: largeBody
    });
    const res = await handleAccountSettings(req, env, "user_123");
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toEqual({ error: "too_large" });
  });

  it("stores encrypted settings on PUT and retrieves plaintext JSON on GET", async () => {
    const { env } = createMockEnv(VALID_KEY_BASE64);
    const payload = { preferences: { theme: "system", sidebarOpen: true } };

    // PUT
    const putReq = new Request("https://edge.comet/account-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const putRes = await handleAccountSettings(putReq, env, "user_456");
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody).toEqual({ ok: true });

    // GET
    const getReq = new Request("https://edge.comet/account-settings", { method: "GET" });
    const getRes = await handleAccountSettings(getReq, env, "user_456");
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("application/json");

    const getBody = await getRes.json();
    expect(getBody).toEqual(payload);
  });
});
