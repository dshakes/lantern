import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/onboarding", "/api", "/auth"];

// The control-plane base URL. Server-side env (LANTERN_API_URL) wins; the
// public URL is the next.config rewrite target. Falls back to local dev.
function controlPlaneBaseUrl(): string {
  return (
    process.env.LANTERN_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:8080"
  );
}

// Redirect to /login and clear the (invalid/expired/forged) cookie so the
// browser stops re-sending it and the user gets a clean re-auth.
function redirectToLogin(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("from", pathname);
  const res = NextResponse.redirect(loginUrl);
  res.cookies.delete("lantern_token");
  return res;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = request.cookies.get("lantern_token")?.value;

  // Presence is necessary but NOT sufficient — a non-empty cookie used to be
  // enough to authenticate, which let a garbage value (or a client-minted
  // demo_token_*) through. We now hand the token to the control-plane's
  // /auth/me, which validates the HS256 signature + expiry with the shared
  // JWT_SECRET we don't (and shouldn't) hold here. Non-200 → unauthenticated.
  if (!token) {
    return redirectToLogin(request);
  }

  let valid = false;
  try {
    const res = await fetch(`${controlPlaneBaseUrl()}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      // Never serve a cached auth decision.
      cache: "no-store",
      // Don't let a slow/unreachable control-plane hang every navigation.
      signal: AbortSignal.timeout(5000),
    });
    valid = res.status === 200;
  } catch {
    // Network failure / timeout reaching the control-plane. Fail closed —
    // an unverifiable token is treated as unauthenticated.
    valid = false;
  }

  if (!valid) {
    return redirectToLogin(request);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|favicon\\.ico|.*\\..*).*)"],
};
