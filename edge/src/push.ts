/**
 * Push notification routes — Expo push service relay.
 *
 * Mobile apps register their Expo push token via POST /push/register. The
 * Rust engine (desktop daemon) calls POST /push/send when a session
 * transitions Working → Idle / Errored / AwaitingInput, and the edge
 * forwards the notification through Expo's push API (which routes to
 * APNs/FCM).
 *
 * Security: /push/register uses the caller's JWT (user-scoped). /push/send
 * uses a shared secret (PUSH_INTERNAL_SECRET) since the engine is an
 * internal caller acting on behalf of any user in the workspace doc.
 */

import { type Env } from "./env";

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

export async function handlePushRegister(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch (err) {
    console.error("[push] register JSON parse failed", err);
    return json({ error: "bad_json" }, 400);
  }

  console.info("[push] register userId=" + userId + " tokenLen=" + (body.token?.length ?? 0));

  if (!body.token || typeof body.token !== "string" || body.token.length < 10) {
    return json({ error: "invalid_token" }, 400);
  }

  // Must look like an Expo push token (ExponentPushToken[...] or
  // ExponentPushToken[...] with a project-scoped prefix).
  if (!body.token.startsWith("ExponentPushToken[")) {
    return json({ error: "not_expo_token" }, 400);
  }

  try {
    await env.PUSH_TOKENS.put(PUSH_KV_PREFIX + userId, body.token);
    console.info("[push] stored token for key: " + PUSH_KV_PREFIX + userId + " val=" + body.token.slice(0, 25) + "...");
  } catch (kvErr) {
    console.error("[push] KV put failed", kvErr);
    return json({ error: "kv_write_failed" }, 500);
  }
  return json({ ok: true });
}

export async function handlePushSend(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // Internal endpoint — verify shared secret.
  const secret = request.headers.get("x-internal-secret");
  if (!secret || secret !== env.PUSH_INTERNAL_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: SendBody;
  try {
    body = (await request.json()) as SendBody;
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  if (!body.userId || !body.title || !body.body) {
    return json({ error: "missing_fields" }, 400);
  }

  // Look up the user's push token.
  const token = await env.PUSH_TOKENS.get(PUSH_KV_PREFIX + body.userId);
  if (!token) {
    // No registered device — silently succeed (user has no mobile app).
    return json({ ok: true, sent: false, reason: "no_token" });
  }

  // Send through Expo's push API.
  const payload = {
    to: token,
    title: body.title,
    body: body.body,
    sound: "default",
    priority: "high",
    data: {
      chatId: body.chatId ?? "",
      deepLink: body.deepLink ?? "",
      kind: body.kind ?? "done",
    },
  };

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const raw = await response.text();
    console.info("[push] Expo status=" + response.status + " raw=" + raw);

    if (!response.ok) {
      console.error("[push] Expo push API error", response.status, raw);
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
      const errMsg = ticket?.details?.error ?? parsed.details?.error ?? ticket?.message ?? "unknown";
      // If the token is invalid/stale, remove it so we don't keep retrying.
      if (errMsg === "DeviceNotRegistered" || errMsg === "InvalidCredentials") {
        await env.PUSH_TOKENS.delete(PUSH_KV_PREFIX + body.userId);
      }
      return json({ ok: false, error: errMsg, raw }, 502);
    }

    return json({ ok: true, sent: true });
  } catch (err) {
    console.error("[push] Expo push fetch failed", err);
    return json({ ok: false, error: "fetch_failed" }, 502);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
