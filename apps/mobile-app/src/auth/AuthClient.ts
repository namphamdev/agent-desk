// Edge auth client — /auth/exchange, /auth/refresh, /auth/orgs
// (edge/src/auth-routes.ts). Two modes, mirroring the engine:
// - WorkOS: paste-code exchange → access/refresh tokens; refresh scoped to
//   an org adds the org_id claim the workspace room requires.
// - Dev (AUTH_MODE=dev edge): the bearer string IS the user id; "user@org"
//   supplies a fake org claim.

import * as SecureStore from 'expo-secure-store';

export interface AuthUser {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

export interface AuthOrg {
  id: string;
  organizationId: string;
  name: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export class AuthError extends Error {
  constructor(public code: number, public body: string) {
    super(`Auth failed (${code}): ${body}`);
    this.name = 'AuthError';
  }
}

async function postJson<T>(baseURL: string, path: string, body: Record<string, string>): Promise<T> {
  const res = await fetch(`${baseURL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok || res.status < 200 || res.status >= 300) {
    throw new AuthError(res.status, text);
  }
  return JSON.parse(text) as T;
}

export class AuthClient {
  constructor(public baseURL: string) {}

  async exchange(code: string): Promise<{ user: AuthUser; tokens: AuthTokens }> {
    interface Reply {
      user: AuthUser;
      accessToken: string;
      refreshToken: string;
    }
    const r = await postJson<Reply>(this.baseURL, 'auth/exchange', { code });
    return { user: r.user, tokens: { accessToken: r.accessToken, refreshToken: r.refreshToken } };
  }

  async refresh(refreshToken: string, organizationId?: string): Promise<AuthTokens> {
    const body: Record<string, string> = { refreshToken };
    if (organizationId) body.organizationId = organizationId;
    return postJson<AuthTokens>(this.baseURL, 'auth/refresh', body);
  }

  async orgs(accessToken: string): Promise<AuthOrg[]> {
    const res = await fetch(`${this.baseURL}/auth/orgs`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await res.text();
    if (!res.ok || res.status < 200 || res.status >= 300) {
      throw new AuthError(res.status, text);
    }
    const parsed = JSON.parse(text) as { orgs: AuthOrg[] };
    return parsed.orgs;
  }
}

// MARK: - Secure storage (Keychain equivalent via expo-secure-store).

const KEY_ACCESS = 'accessToken';
const KEY_REFRESH = 'refreshToken';

export const Keychain = {
  async saveAccessToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(KEY_ACCESS, token, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },
  async loadAccessToken(): Promise<string | null> {
    return SecureStore.getItemAsync(KEY_ACCESS);
  },
  async saveRefreshToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(KEY_REFRESH, token, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },
  async loadRefreshToken(): Promise<string | null> {
    return SecureStore.getItemAsync(KEY_REFRESH);
  },
  async deleteAll(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY_ACCESS);
    await SecureStore.deleteItemAsync(KEY_REFRESH);
  },
};

// JWT helpers — decode the payload's `exp` (120s early-refresh margin).
// The access token is baked into WS URLs at connect time and cannot be
// refreshed mid-socket; with WorkOS's short access-token lifetimes the
// margin must comfortably exceed the WS handshake RTT + WorkOS JWKS
// verification latency on the edge, otherwise the edge's jwtVerify runs
// past `exp` and rejects the upgrade (surfacing as RN close code 1006).
// On any parse failure the token is treated as expired so the app refreshes
// rather than trusting an unreadable JWT.
const TOKEN_REFRESH_MARGIN_S = 120;

export function isJwtExpired(jwt: string): boolean {
  return jwtExpiresIn(jwt) <= 0;
}

/** Seconds until the token's `exp`, accounting for the early-refresh margin.
 * Returns 0 (treat as expired) on any decode failure so the app refreshes
 * rather than trusting an unreadable JWT. */
export function jwtExpiresIn(jwt: string): number {
  const segments = jwt.split('.');
  if (segments.length !== 3) return 0;
  const payload = base64UrlDecode(segments[1]);
  if (!payload) return 0;
  try {
    const obj = JSON.parse(payload) as { exp?: number };
    if (typeof obj.exp !== 'number') return 0;
    return obj.exp - TOKEN_REFRESH_MARGIN_S - Date.now() / 1000;
  } catch {
    return 0;
  }
}

function base64UrlDecode(s: string): string | null {
  const fromUrlSafe = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = fromUrlSafe + '='.repeat((4 - (fromUrlSafe.length % 4)) % 4);
  try {
    // atob exists in RN's runtime (Hermes provides it).
    // eslint-disable-next-line no-undef
    const bin = atob(padded);
    // Convert binary string to UTF-8 string.
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}
