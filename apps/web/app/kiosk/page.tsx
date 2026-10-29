"use client";

import { useState } from "react";
import { Button } from "@/components/button";
import { api } from "@/lib/api";
import { KIOSK_STORAGE_KEY } from "./kiosk-logic";

// Public landing for `lantern demo`: one button that mints an ephemeral demo
// workspace (POST /v1/kiosk/session) and drops the visitor into the dashboard.
export default function KioskStart() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
      const res = await fetch(`${base}/v1/kiosk/session`, { method: "POST" });
      if (!res.ok) {
        throw new Error(res.status === 429 ? "Too many demos from this device. Try again later."
          : res.status === 503 ? "The demo is full. Try again in a minute."
          : res.status === 404 ? "Demo mode is not enabled on this server."
          : "Could not start the demo.");
      }
      const s = (await res.json()) as { token: string; expiresAt: string };
      api.setToken(s.token);
      localStorage.setItem(KIOSK_STORAGE_KEY, JSON.stringify({ expiresAt: s.expiresAt, mode: "replay" }));
      await api.whenCookieSynced();
      window.location.href = "/inbox";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the demo.");
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold text-zinc-50">Try PAL</h1>
      <p className="max-w-md text-sm text-zinc-400">
        You get a private workspace with sample agents for 30 minutes, then it is deleted.
        Answers are recorded replays, not a live model.
      </p>
      <Button onClick={start} loading={busy}>Start demo</Button>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </main>
  );
}
