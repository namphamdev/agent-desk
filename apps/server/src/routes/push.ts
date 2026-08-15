/**
 * Push notification routes — Expo push service relay.
 * Ported from edge/src/push.ts. Uses the filesystem KV store instead of
 * Cloudflare KV.
 */
import type { Env } from "../env";
import type { KvStore } from "../storage/kv-store";

const PUSH_KV_PREFIX = "push:";
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

interface RegisterBody {
  token: string;
}

interface SendBody {
  userId: string;
  title: string;
  body: string;
  chatId?: string;
  deepLink?: string;
  kind?: "done" | "input" | "error";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });

export const handlePushRegister = async (
  method: string,
  rawBody: ArrayBuffer | null,
  kv: KvStore,
  userId: string
): Promise<Response> => {
  if (method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: RegisterBody;
  try {
    body = rawBody ? JSON.parse(new TextDecoder().decode(rawBody)) : ({} as RegisterBody);
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  if (!body.token || typeof body.token !== "string" || body.token.length < 10) {
    return json({ error: "invalid_token" }, 400);
  }
  if (!body.token.startsWith("ExponentPushToken[")) {
    return json({ error: "not_expo_token" }, 400);
  }

  try {
    await kv.put(PUSH_KV_PREFIX + userId, body.token);
  } catch {
    return json({ error: "kv_write_failed" }, 500);
  }
  return json({ ok: true });
};

export const handlePushSend = async (
  method: string,
  headers: Headers,
  rawBody: ArrayBuffer | null,
  env: Env,
  kv: KvStore
): Promise<Response> => {
  if (method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const secret = headers.get("x-internal-secret");
  if (!secret || secret !== env.PUSH_INTERNAL_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: SendBody;
  try {
    body = rawBody ? JSON.parse(new TextDecoder().decode(rawBody)) : ({} as SendBody);
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  if (!body.userId || !body.title || !body.body) {
    return json({ error: "missing_fields" }, 400);
  }

  const token = await kv.get(PUSH_KV_PREFIX + body.userId);
  if (!token) {
    return json({ ok: true, sent: false, reason: "no_token" });
  }

  const payload = {
    to: token,
    title: body.title,
    body: body.body,
    sound: "default",
    priority: "high",
    data: {
      chatId: body.chatId ?? "",
      deepLink: body.deepLink ?? "",
      kind: body.kind ?? "done"
    }
  };

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    if (!response.ok) {
      return json({ ok: false, error: "expo_api_error", status: response.status, raw }, 502);
    }

    let parsed: { data?: ExpoPushTicket; details?: { error?: string } };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "parse_failed", raw }, 502);
    }
    const ticket = parsed.data;
    if (!ticket || ticket.status === "error") {
      const errMsg =
        ticket?.details?.error ?? parsed.details?.error ?? ticket?.message ?? "unknown";
      if (errMsg === "DeviceNotRegistered" || errMsg === "InvalidCredentials") {
        await kv.delete(PUSH_KV_PREFIX + body.userId);
      }
      return json({ ok: false, error: errMsg, raw }, 502);
    }

    return json({ ok: true, sent: true });
  } catch {
    return json({ ok: false, error: "fetch_failed" }, 502);
  }
};
