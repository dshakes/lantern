// Bridge → control-plane auth.
//
// Prod-grade replacement for the previous "hardcode a JWT in env and pray"
// scheme that broke every time the JWT expired or the API was restarted.
// Symptoms of the old setup: incoming WhatsApp DMs would show 3 dots in
// the sender's chat (bridge sent typing presence) and then nothing, with
// bridge logs full of `status:401, body:"unauthorized"`.
//
// This module:
//   - Boots with either a static LANTERN_API_TOKEN (back-compat) OR
//     LANTERN_BRIDGE_EMAIL / LANTERN_BRIDGE_PASSWORD (auto-login).
//     For dev convenience, defaults to admin@lantern.dev / lantern.
//   - Lazily logs in on first use.
//   - Exposes authedFetch() — a fetch wrapper that retries ONCE on a 401
//     by re-logging in and replaying the request. This survives API
//     restarts, JWT secret rotations, and expiry without restarting the
//     bridge.
//
// The single shared instance (`getAuth`) is process-wide so attention.ts
// and agent.ts share the same token + relogin state.

import type { Logger } from "pino";

interface AuthState {
  token: string;
  loginInflight: Promise<void> | null;
  email: string;
  password: string;
  apiUrl: string;
  logger: Logger;
}

let state: AuthState | null = null;

export function initAuth(logger: Logger) {
  if (state) return;
  state = {
    token: process.env.LANTERN_API_TOKEN || "",
    loginInflight: null,
    // In dev these default to the seeded admin account so the bridge
    // works out of the box. In prod set LANTERN_BRIDGE_EMAIL +
    // LANTERN_BRIDGE_PASSWORD (or LANTERN_API_TOKEN if you prefer a
    // long-lived service token).
    email: process.env.LANTERN_BRIDGE_EMAIL || "admin@lantern.dev",
    password: process.env.LANTERN_BRIDGE_PASSWORD || "lantern",
    apiUrl: (process.env.LANTERN_API_URL || "http://localhost:8080").replace(/\/$/, ""),
    logger: logger.child({ component: "bridge-auth" }),
  };
}

export function authEnabled(): boolean {
  if (!state) return false;
  // We're "enabled" if we have either a static token OR can log in.
  // In practice the dev defaults always allow login, so this returns
  // true unless someone explicitly cleared the email+password.
  return state.token !== "" || (state.email !== "" && state.password !== "");
}

// login fetches a fresh JWT using bridge credentials.
async function login(): Promise<void> {
  if (!state) throw new Error("initAuth() must be called first");
  // Coalesce concurrent logins. If a login is already in flight, await it
  // instead of stacking N parallel /auth/login requests.
  if (state.loginInflight) {
    await state.loginInflight;
    return;
  }
  const p = (async () => {
    const res = await fetch(`${state!.apiUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: state!.email, password: state!.password }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`bridge login failed: status=${res.status} body=${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      throw new Error("bridge login: no token in response");
    }
    state!.token = data.token;
    state!.logger.info({ email: state!.email, tokenPreview: data.token.slice(0, 16) + "..." },
      "bridge logged in to control-plane");
  })();
  state.loginInflight = p;
  try {
    await p;
  } finally {
    state.loginInflight = null;
  }
}

// authedFetch makes an authenticated request to the control-plane. On 401
// it transparently logs in and retries ONCE. After that, any further 401
// is returned to the caller (genuine credential failure, not just an
// expired session).
export async function authedFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!state) throw new Error("initAuth() must be called first");
  // Empty token → log in immediately so the first call already has auth.
  if (!state.token) {
    await login();
  }

  const doFetch = async (): Promise<Response> => {
    const headers = new Headers(init.headers as Record<string, string> | Headers | undefined);
    headers.set("Authorization", `Bearer ${state!.token}`);
    return fetch(`${state!.apiUrl}${path}`, { ...init, headers });
  };

  let res = await doFetch();
  if (res.status === 401) {
    state.logger.warn({ path }, "control-plane returned 401 — relogging in");
    // Drain the body so we don't leak the connection on retry.
    await res.text().catch(() => {});
    try {
      await login();
    } catch (err) {
      state.logger.error({ err }, "relogin failed — caller will see 401");
      // Re-issue the original request so the caller gets a fresh response
      // object with the 401 (instead of a half-consumed one).
      return doFetch();
    }
    res = await doFetch();
  }
  return res;
}

// apiBaseUrl exposes the resolved control-plane URL for places that need
// to build it themselves (e.g. SSE EventSource).
export function apiBaseUrl(): string {
  if (!state) throw new Error("initAuth() must be called first");
  return state.apiUrl;
}

// currentToken returns the current JWT — used by SSE consumers that can't
// go through authedFetch. Caller should still handle 401 manually since
// this returns without checking.
export function currentToken(): string {
  if (!state) return "";
  return state.token;
}
