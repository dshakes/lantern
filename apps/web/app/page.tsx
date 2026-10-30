"use client";
// "/" — decides where a signed-in user lands (lib/workspace-nav chooseLanding):
// a brand-new workspace goes to /welcome to pick pal or Runtime, an unfinished
// Runtime onboarding resumes, everyone else lands on their remembered home.
// Middleware has already bounced unauthenticated visitors to /login.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PalMark } from "@/components/pal-mark";
import { api } from "@/lib/api";
import { MODE_STORAGE_KEY, chooseLanding } from "@/lib/workspace-nav";

function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return err instanceof TypeError || msg.includes("Failed to fetch") || msg.includes("NetworkError");
}

export default function HomePage() {
  const router = useRouter();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let storedMode: string | null = null;
      try {
        storedMode = localStorage.getItem(MODE_STORAGE_KEY);
      } catch {
        /* ignore */
      }
      if (storedMode) {
        router.replace(chooseLanding({ storedMode, onboardingStarted: false, agentCount: 0 }));
        return;
      }
      try {
        const [agents, onboarding] = await Promise.all([
          api.listAgents(),
          api.getOnboarding().catch(() => ({}) as Record<string, unknown>),
        ]);
        if (cancelled) return;
        router.replace(
          chooseLanding({
            storedMode,
            agentCount: agents.length,
            onboardingStarted: Object.keys(onboarding ?? {}).length > 0,
          }),
        );
      } catch (err) {
        if (cancelled) return;
        if (isNetworkError(err)) setOffline(true);
        else router.replace("/welcome");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-0 px-4 text-center">
      <PalMark className="h-10 w-10" />
      {offline ? (
        <div>
          <p className="text-sm font-medium text-zinc-100">Can&apos;t reach the PAL API</p>
          <p className="mt-1 max-w-sm text-xs text-zinc-500">
            The control-plane isn&apos;t responding. If you&apos;re running locally, start it with{" "}
            <code className="rounded bg-surface-2 px-1 font-mono text-zinc-300">make run-api</code>.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg border border-zinc-700 bg-surface-1 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-surface-2"
          >
            Retry
          </button>
        </div>
      ) : (
        <p className="text-xs text-zinc-500" role="status">Loading your workspace…</p>
      )}
    </div>
  );
}
