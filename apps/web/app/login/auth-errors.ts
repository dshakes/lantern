// Maps sign-in / sign-up failures to clear, actionable copy. Pure — tested in
// auth-errors.test.mts. Input is the Error thrown by lib/api (messages look
// like `API <status>: <json body>`; a fetch TypeError means the API is down).

export type AuthErrorKind = "rate_limited" | "unverified" | "invalid" | "unreachable" | "server" | "closed" | "other";

export interface AuthErrorView {
  kind: AuthErrorKind;
  message: string;
}

function serverReason(body: string): string | null {
  try {
    const v = JSON.parse(body) as { error?: unknown };
    return typeof v.error === "string" && v.error ? v.error : null;
  } catch {
    return null;
  }
}

export function describeAuthError(err: unknown, mode: "signin" | "signup"): AuthErrorView {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (err instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return { kind: "unreachable", message: "Can't reach PAL right now. Check your connection and try again." };
  }
  if (/email_unverified|Verify your email/i.test(msg)) {
    return { kind: "unverified", message: "Verify your email first — we sent you a link. Didn't get it? Send a new one below." };
  }
  const m = msg.match(/API (\d+): ([\s\S]*)/);
  const status = m ? Number(m[1]) : 0;
  const reason = m ? serverReason(m[2]) : null;
  if (status === 429) {
    return { kind: "rate_limited", message: "Too many attempts. For your security, wait a few minutes before trying again." };
  }
  if (status === 401 || (mode === "signin" && /invalid credentials/i.test(msg))) {
    return { kind: "invalid", message: "Incorrect email or password." };
  }
  if (status >= 500) {
    return { kind: "server", message: "Something went wrong on our side. Try again in a moment." };
  }
  if (mode === "signup" && reason && /closed|invite/i.test(reason)) {
    return { kind: "closed", message: reason.charAt(0).toUpperCase() + reason.slice(1) };
  }
  if (reason) return { kind: "other", message: reason.charAt(0).toUpperCase() + reason.slice(1) };
  return { kind: "other", message: mode === "signin" ? "Couldn't sign in. Check your email and password." : "Couldn't create your account. Try again." };
}

/** Same-origin path only — never an open redirect. Defaults to "/". */
export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.startsWith("/login")) return "/";
  return raw;
}
