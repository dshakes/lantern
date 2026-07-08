// Secure-link delivery for docs that can't ride iMessage/WhatsApp (SMS/RCS-only
// contacts). The bridge stages the file with the control-plane, which returns a
// short-lived HMAC capability URL; the contact gets that URL as plain text
// (which delivers reliably to any phone) instead of a flaky MMS attachment.

export interface StageLinkOptions {
  controlPlaneUrl: string; // e.g. http://127.0.0.1:8080
  serviceToken?: string; // LANTERN_GRPC_SERVICE_TOKEN
  filename: string;
  content: Uint8Array; // raw file bytes — streamed, not base64 (no 33% bloat)
  ttlSeconds?: number; // default 3600 (server caps at 3600)
  fetchImpl?: typeof fetch; // injectable for tests
  timeoutMs?: number;
}

// POST the raw bytes to /internal/dl/stage and return the public link (or null).
export async function stageDownloadLink(o: StageLinkOptions): Promise<{ url: string; expiresAt: number } | null> {
  const base = o.controlPlaneUrl.replace(/\/$/, "");
  const doFetch = o.fetchImpl || fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "X-Filename": o.filename,
    "X-TTL-Seconds": String(o.ttlSeconds ?? 3600),
    "Content-Length": String(o.content.byteLength),
  };
  if (o.serviceToken) headers["x-lantern-service-token"] = o.serviceToken;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15000);
  try {
    const res = await doFetch(`${base}/internal/dl/stage`, {
      method: "POST",
      headers,
      body: o.content,
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { url?: string; expiresAt?: number };
    if (!j.url) return null;
    // Guard against a dead link: if LANTERN_PUBLIC_BASE_URL isn't set on the
    // control-plane, the staged URL is a loopback/private host the contact can't
    // reach. Refuse rather than text someone a useless link.
    if (/\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(j.url)) {
      return null;
    }
    return { url: j.url, expiresAt: j.expiresAt ?? 0 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Choose how to deliver a FILE to a handle. The hard-won rule: an AppleScript
// file send returns "success" even when iMessage can't actually reach the
// recipient, so NEVER infer capability from the send result. Push inline over
// iMessage ONLY with positive evidence it works; otherwise a secure link (which
// delivers reliably as text). This is the decision that kept silently failing —
// it is pure and unit-tested so it can't regress.
//   - non-phone handle (email / Apple ID): iMessage is the only channel.
//   - phone with recent status proving iMessage delivered (service imessage,
//     error 0): iMessage inline.
//   - phone otherwise (SMS/RCS, a delivery error, or no history): link.
export function chooseFileTransport(input: {
  isPhone: boolean;
  recent?: { service: string; error: number } | null;
}): "imessage" | "link" {
  if (!input.isPhone) return "imessage";
  const r = input.recent;
  if (r && r.service.toLowerCase() === "imessage" && r.error === 0) return "imessage";
  return "link";
}

// The contact-facing message carrying the link — the owner's voice, warm and
// plain, with an honest expiry note.
export function buildDocLinkMessage(request: string, url: string, ttlMinutes: number): string {
  const window =
    ttlMinutes >= 120 ? `${Math.round(ttlMinutes / 60)} hours` : ttlMinutes >= 60 ? "about an hour" : `${ttlMinutes} minutes`;
  return `here's the ${request} — ${url}\n\n(that link expires in ${window})`;
}
