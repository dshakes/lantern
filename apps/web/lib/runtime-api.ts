// Minimal typed fetch wrapper for /v1/runtime/* endpoints.
//
// The main LanternAPI class is method-per-endpoint; the runtime surface is
// small + new + likely to evolve, so we keep it isolated here behind generic
// get/post/del helpers that read auth from the same localStorage slot.

function baseUrl(): string {
  if (typeof window !== "undefined") {
    return (
      (window as unknown as Record<string, unknown>).__NEXT_PUBLIC_API_URL as string | undefined ??
      process.env.NEXT_PUBLIC_API_URL ??
      "http://localhost:8080"
    );
  }
  return (
    process.env.LANTERN_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:8080"
  );
}

function token(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("lantern_token");
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const runtimeApi = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
  // Build a same-origin SSE URL for EventSource (auth via cookie token).
  logsUrl: (vmId: string) =>
    `${baseUrl()}/v1/runtime/vms/${encodeURIComponent(vmId)}/logs?follow=1`,
};
