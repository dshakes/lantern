// Server-side proxy for all bridge REST calls.
//
// The dashboard client never talks to the bridge directly; it calls
// /api/bridge/<channel>/<path> (same-origin) and this handler forwards
// to the real bridge with the shared secret injected from a server-only
// env var.  The token never reaches the browser.
//
// Env vars (server-only, NOT NEXT_PUBLIC):
//   LANTERN_BRIDGE_TOKEN            — shared secret for the WhatsApp bridge
//   LANTERN_IMESSAGE_BRIDGE_TOKEN   — shared secret for the iMessage bridge
//   NEXT_PUBLIC_LANTERN_BRIDGE_URL  — bridge base URL (URL is not a secret)
//   NEXT_PUBLIC_LANTERN_IMESSAGE_BRIDGE_URL

import { NextRequest, NextResponse } from "next/server";

type Channel = "whatsapp" | "imessage";

function bridgeConfig(channel: Channel): { url: string; token: string } {
  if (channel === "imessage") {
    return {
      url: (
        process.env.LANTERN_IMESSAGE_BRIDGE_URL ||
        process.env.NEXT_PUBLIC_LANTERN_IMESSAGE_BRIDGE_URL ||
        "http://localhost:3200"
      ).replace(/\/$/, ""),
      token: process.env.LANTERN_IMESSAGE_BRIDGE_TOKEN || "",
    };
  }
  return {
    url: (
      process.env.LANTERN_BRIDGE_URL ||
      process.env.NEXT_PUBLIC_LANTERN_BRIDGE_URL ||
      "http://localhost:3100"
    ).replace(/\/$/, ""),
    token: process.env.LANTERN_BRIDGE_TOKEN || "",
  };
}

async function proxyToBridge(
  req: NextRequest,
  channel: Channel,
  bridgePath: string,
): Promise<NextResponse> {
  const { url: bridgeBase, token } = bridgeConfig(channel);

  // Preserve query string from the original request.
  const search = req.nextUrl.search;
  const targetUrl = `${bridgeBase}/${bridgePath}${search}`;

  const headers: Record<string, string> = {
    "Content-Type": req.headers.get("content-type") || "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let body: BodyInit | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Buffer the body so we can forward it.  Bridge payloads are small
    // (JSON commands), so reading into memory is fine.
    body = await req.text();
    // Remove Content-Type override for empty bodies.
    if (!body) delete headers["Content-Type"];
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: body || undefined,
      // Never cache bridge responses — they are always live state.
      cache: "no-store",
    });

    const responseBody = await upstream.text();
    return new NextResponse(responseBody || null, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch (err) {
    // Bridge unreachable — surface a 503 so the client's
    // bridge_offline state triggers correctly.
    const msg = err instanceof Error ? err.message : "bridge unreachable";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}

interface RouteContext {
  params: Promise<{ channel: string; path: string[] }>;
}

function resolveParams(context: RouteContext) {
  return context.params;
}

export async function GET(req: NextRequest, context: RouteContext) {
  const { channel, path } = await resolveParams(context);
  return proxyToBridge(req, channel as Channel, path.join("/"));
}

export async function POST(req: NextRequest, context: RouteContext) {
  const { channel, path } = await resolveParams(context);
  return proxyToBridge(req, channel as Channel, path.join("/"));
}

export async function PUT(req: NextRequest, context: RouteContext) {
  const { channel, path } = await resolveParams(context);
  return proxyToBridge(req, channel as Channel, path.join("/"));
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const { channel, path } = await resolveParams(context);
  return proxyToBridge(req, channel as Channel, path.join("/"));
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  const { channel, path } = await resolveParams(context);
  return proxyToBridge(req, channel as Channel, path.join("/"));
}
