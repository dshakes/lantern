// Route Handler: manage the auth session cookie server-side so it can be
// HttpOnly (not readable by JavaScript / XSS).
//
// POST /api/auth/session   — set the token as an HttpOnly cookie
// DELETE /api/auth/session — clear the cookie (logout)
//
// The client calls these after a successful login/logout instead of writing
// document.cookie directly.  The token never leaves the server-side context
// after this point; the browser just holds the opaque cookie.

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

const COOKIE_NAME = "lantern_token";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function POST(req: NextRequest) {
  let token: string;
  try {
    const body = (await req.json()) as { token?: string };
    if (!body.token || typeof body.token !== "string") {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }
    token = body.token;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const isProduction = process.env.NODE_ENV === "production";
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest) {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return NextResponse.json({ ok: true });
}
