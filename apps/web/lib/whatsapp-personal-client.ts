// Typed client for the control-plane's WhatsApp personal-assistant
// endpoints (VIPs, contact facts, pending drafts). Mirrors the
// bridge-client pattern: pure functions, no state, single auth source
// (the lantern_token cookie/localStorage via api.ts).

import { api } from "@/lib/api";

const API_BASE =
  (typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080")
    : (process.env.LANTERN_API_URL ?? "http://localhost:8080"));

function authHeaders(): HeadersInit {
  const token = api.token ?? api.restoreToken();
  return token
    ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    : { "Content-Type": "application/json" };
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`whatsapp-personal ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// ---- VIPs ----------------------------------------------------------------

export interface VIPEntry {
  jid: string;
  displayName: string;
}

export function listVIPs(): Promise<{ vips: VIPEntry[] }> {
  return req("/v1/whatsapp/vips");
}

export function addVIP(jid: string, displayName?: string): Promise<{ status: string }> {
  return req("/v1/whatsapp/vips", {
    method: "POST",
    body: JSON.stringify({ jid, displayName: displayName ?? "" }),
  });
}

export function removeVIP(jid: string): Promise<{ status: string }> {
  return req(`/v1/whatsapp/vips?jid=${encodeURIComponent(jid)}`, {
    method: "DELETE",
  });
}

// ---- Contact facts -------------------------------------------------------

export interface Fact {
  id: string;
  content: string;
  source: string;
  updatedAt: string;
}

export function listFacts(jid: string): Promise<{ facts: Fact[] }> {
  return req(`/v1/whatsapp/facts?jid=${encodeURIComponent(jid)}`);
}

export function addFact(jid: string, content: string): Promise<{ id: string }> {
  return req("/v1/whatsapp/facts", {
    method: "POST",
    body: JSON.stringify({ jid, content }),
  });
}

export function deleteFact(id: string): Promise<{ status: string }> {
  return req(`/v1/whatsapp/facts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---- Drafts --------------------------------------------------------------

export interface Draft {
  id: string;
  jid: string;
  displayName: string;
  inboundText: string;
  draftText: string;
  status: "pending" | "approved" | "edited" | "discarded";
  finalText: string;
  channel: "whatsapp" | "imessage";
  createdAt: string;
}

export function listDrafts(
  status: "pending" | "approved" | "edited" | "discarded" = "pending",
): Promise<{ drafts: Draft[] }> {
  return req(`/v1/whatsapp/drafts?status=${status}`);
}

export function actOnDraft(
  id: string,
  action: "approve" | "edit" | "discard",
  finalText?: string,
): Promise<{ status: string; sendError?: string; warning?: string }> {
  return req(`/v1/whatsapp/drafts/${encodeURIComponent(id)}/act`, {
    method: "POST",
    body: JSON.stringify({ action, finalText: finalText ?? "" }),
  });
}

// ---- helpers -------------------------------------------------------------

export function prettyJid(jid: string): string {
  // 15551234567@s.whatsapp.net → +15551234567
  const at = jid.indexOf("@");
  if (at > 0) {
    const local = jid.slice(0, at);
    if (/^\d+$/.test(local)) return `+${local}`;
    return local;
  }
  return jid;
}
