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

const RAW_STATIC_TOKEN = process.env.LANTERN_API_TOKEN || "";

// Smart static-token validation. If the env var holds a JWT whose
// `exp` claim is in the past, we treat it as if no static token were
// set — falling back to credential login + auto-relogin. This prevents
// the foot-gun where a developer exports a JWT once into their shell
// and the env var stays set across machine reboots / weeks; the
// bridge would otherwise silently 401 on every API call.
function isJWTExpired(token: string): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false; // not a JWT, can't tell
  try {
    // base64url decode the payload
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf-8");
    const claims = JSON.parse(json) as { exp?: number };
    if (typeof claims.exp !== "number") return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return claims.exp <= nowSec;
  } catch {
    return false;
  }
}

const STATIC_TOKEN = isJWTExpired(RAW_STATIC_TOKEN) ? "" : RAW_STATIC_TOKEN;

const EMAIL = process.env.LANTERN_BRIDGE_EMAIL || "admin@lantern.dev";
const PASSWORD = process.env.LANTERN_BRIDGE_PASSWORD || "lantern";

let runtimeToken = STATIC_TOKEN;
let loginInflight: Promise<string | null> | null = null;
let log: Logger | null = null;

export function initAuth(logger: Logger) {
  log = logger.child({ component: "auth" });
  const rawHadToken = !!RAW_STATIC_TOKEN;
  const tokenWasExpired = rawHadToken && !STATIC_TOKEN;
  log.info(
    {
      apiUrl: API_BASE_URL,
      hasStaticToken: !!STATIC_TOKEN,
      ignoredExpiredEnvToken: tokenWasExpired,
      email: EMAIL,
    },
    "auth initialized",
  );
  if (tokenWasExpired) {
    log.warn(
      "LANTERN_API_TOKEN env var holds an EXPIRED JWT — falling back to credential login. Run `unset LANTERN_API_TOKEN` in your shell to silence this.",
    );
  }
  // Eagerly log in at startup so the first authedFetch always has a
  // fresh token. Without this, the first request triggers a lazy
  // login — and ANY auth blip later (token rotation, brief connection
  // hiccup) creates a window where a 401 hits the caller before
  // auto-relogin completes. Eager login + periodic refresh closes
  // that window entirely.
  if (!STATIC_TOKEN && authEnabled()) {
    log.info("scheduling eager login");
    loginNow()
      .then((tok) => log?.info({ ok: !!tok }, "eager login resolved"))
      .catch((err) => log?.warn({ err: String(err) }, "eager login rejected"));
    // Refresh every 12 hours to stay ahead of JWT expiry (typical
    // bridge sessions are 24h; refreshing at half-life is safe).
    setInterval(() => {
      loginNow()
        .then((tok) => log?.info({ ok: !!tok }, "periodic relogin resolved"))
        .catch((err) => log?.warn({ err: String(err) }, "periodic relogin rejected"));
    }, 12 * 60 * 60_000);
  } else {
    log.info({ reason: STATIC_TOKEN ? "static-token mode" : "auth disabled" }, "no eager login");
  }
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
