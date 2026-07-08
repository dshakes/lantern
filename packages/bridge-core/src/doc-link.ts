// Secure-link delivery for docs that can't ride iMessage/WhatsApp (SMS/RCS-only
// contacts). The bridge stages the file with the control-plane, which returns a
// short-lived HMAC capability URL; the contact gets that URL as plain text
// (which delivers reliably to any phone) instead of a flaky MMS attachment.

export interface StageLinkOptions {
  controlPlaneUrl: string; // e.g. http://127.0.0.1:8080
  serviceToken?: string; // LANTERN_GRPC_SERVICE_TOKEN
  filename: string;
  contentB64: string; // base64 of the file bytes
  ttlSeconds?: number; // default 3600 (server caps at 3600)
  fetchImpl?: typeof fetch; // injectable for tests
  timeoutMs?: number;
}

// POST the bytes to /internal/dl/stage and return the public link (or null).
export async function stageDownloadLink(o: StageLinkOptions): Promise<{ url: string; expiresAt: number } | null> {
  const base = o.controlPlaneUrl.replace(/\/$/, "");
  const doFetch = o.fetchImpl || fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (o.serviceToken) headers["x-lantern-service-token"] = o.serviceToken;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15000);
  try {
    const res = await doFetch(`${base}/internal/dl/stage`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filename: o.filename, contentB64: o.contentB64, ttlSeconds: o.ttlSeconds ?? 3600 }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { url?: string; expiresAt?: number };
    if (!j.url) return null;
    return { url: j.url, expiresAt: j.expiresAt ?? 0 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The contact-facing message carrying the link — the owner's voice, warm and
// plain, with an honest expiry note.
export function buildDocLinkMessage(request: string, url: string, ttlMinutes: number): string {
  const window =
    ttlMinutes >= 120 ? `${Math.round(ttlMinutes / 60)} hours` : ttlMinutes >= 60 ? "about an hour" : `${ttlMinutes} minutes`;
  return `here's the ${request} — ${url}\n\n(that link expires in ${window})`;
}
