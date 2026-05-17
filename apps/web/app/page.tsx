"use client";

// Home (/) — Claude-desktop pattern.
//
// Routes the user to the best landing target based on state:
//
//   1. Cached "last visited agent" exists AND we can confirm it still
//      exists in the user's tenant → /agents/<name> (the workspace).
//   2. User has at least one agent but no cached slug → most recent agent.
//   3. User has zero agents → /agents (which shows the welcome empty state
//      with suggestion chips + Create button).
//   4. Not authenticated → middleware handles the redirect to /login.
//
// We render a brief calm loading state during the decision so there's
// never a flash of a wrong page.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { getLastAgent, clearLastAgent, setLastAgent } from "@/lib/last-agent";

type Status = "deciding" | "offline";

export default function HomePage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("deciding");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // First — try the cached slug. If it resolves to a real agent we can
      // skip the full list fetch entirely: instant warm landing.
      const cached = getLastAgent();
      if (cached) {
        try {
          await api.getAgent(cached);
          if (!cancelled) router.replace(`/agents/${encodeURIComponent(cached)}`);
          return;
        } catch (err) {
          // Cached slug was deleted, renamed, or API is down.
          // Distinguish network failure from 404 by message — getAgent
          // throws a generic Error with a status code prefix on API errors,
          // and a fetch TypeError on network failures.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || err instanceof TypeError) {
            if (!cancelled) setStatus("offline");
            return;
          }
          clearLastAgent();
        }
      }

      // No usable cache. Fetch the agent list and route to the most
      // recently-created one (or to the create flow if empty).
      try {
        const agents = await api.listAgents();
        if (cancelled) return;
        if (agents.length === 0) {
          router.replace("/agents");
          return;
        }
        const sorted = [...agents].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        const target = sorted[0].name;
        setLastAgent(target);
        router.replace(`/agents/${encodeURIComponent(target)}`);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || err instanceof TypeError) {
          setStatus("offline");
        } else {
          // API returned an error response (e.g. 401) — let middleware
          // handle auth redirect by sending to /agents which is guarded.
          router.replace("/agents");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="flex h-screen items-center justify-center bg-surface-0">
      <div className="flex flex-col items-center gap-4">
        <div
          aria-hidden
          className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-lantern-400 to-lantern-600 shadow-xl"
        >
          <span className="text-xl font-bold text-white">L</span>
        </div>
        {status === "deciding" ? (
          <p className="text-xs text-zinc-500">Loading your workspace…</p>
        ) : (
          <div className="text-center">
            <p className="text-sm font-semibold text-zinc-200">
              Lantern API offline
            </p>
            <p className="mt-1 max-w-sm text-xs text-zinc-500">
              The control-plane isn&apos;t reachable. If you&apos;re running locally,
              start it with{" "}
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-zinc-300">
                lantern dev
              </code>
              .
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded-lg border border-zinc-700 bg-surface-1 px-4 py-2 text-xs font-medium text-zinc-300 transition-colors duration-150 hover:bg-surface-2 hover:text-zinc-100"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
