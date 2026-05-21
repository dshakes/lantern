// Auth helper shared by all Lantern bridges (WhatsApp + iMessage + any
// future ones). Each bridge initializes once with its own logger; the
// auth mode (static service token vs auto-login + relogin) is read
// from env so the same code works in dev (admin@lantern.dev fallback)
// and prod (long-lived LANTERN_API_TOKEN).
//
// Previously copied between bridges; now the single source of truth.

import type { Logger } from "pino";

const API_BASE_URL =
  process.env.LANTERN_API_URL || "http://localhost:8080";

const STATIC_TOKEN = process.env.LANTERN_API_TOKEN || "";

const EMAIL = process.env.LANTERN_BRIDGE_EMAIL || "admin@lantern.dev";
const PASSWORD = process.env.LANTERN_BRIDGE_PASSWORD || "lantern";

let runtimeToken = STATIC_TOKEN;
let loginInflight: Promise<string | null> | null = null;
let log: Logger | null = null;

export function initAuth(logger: Logger) {
  log = logger.child({ component: "auth" });
}

export function authEnabled(): boolean {
  return !!STATIC_TOKEN || !!(EMAIL && PASSWORD);
}

export function apiBaseUrl(): string { return API_BASE_URL; }

export function currentToken(): string { return runtimeToken; }

async function loginNow(): Promise<string | null> {
  if (loginInflight) return loginInflight;
  loginInflight = (async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      });
      if (!res.ok) {
        log?.warn({ status: res.status }, "bridge login failed");
        return null;
      }
      const data = (await res.json()) as { token?: string };
      if (!data.token) return null;
      runtimeToken = data.token;
      log?.info("bridge logged in");
      return data.token;
    } catch (err) {
      log?.warn({ err }, "bridge login errored");
      return null;
    } finally {
      loginInflight = null;
    }
  })();
  return loginInflight;
}

// Wraps fetch with bridge auth headers + 401 auto-relogin.
export async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
  const headers = new Headers(init?.headers);
  if (!runtimeToken && !STATIC_TOKEN && authEnabled()) {
    await loginNow();
  }
  if (runtimeToken) headers.set("Authorization", `Bearer ${runtimeToken}`);

  let res = await fetch(url, { ...init, headers });
  if (res.status === 401 && !STATIC_TOKEN && authEnabled()) {
    const fresh = await loginNow();
    if (fresh) {
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set("Authorization", `Bearer ${fresh}`);
      res = await fetch(url, { ...init, headers: retryHeaders });
    }
  }
  return res;
}
