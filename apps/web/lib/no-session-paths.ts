// Pages a visitor reaches with no session. A 401 there is expected (an
// app-wide provider fetching before a session exists) and must not bounce the
// visitor to /login — that broke /kiosk, which mints its session on load.
const NO_SESSION_PATHS = ["/login", "/auth", "/kiosk"];

export function isNoSessionPath(pathname: string): boolean {
  return NO_SESSION_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
