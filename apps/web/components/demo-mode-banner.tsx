"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";
import { subscribeSimulated } from "@/lib/api";

// Window in which a simulated event keeps the banner visible. Past this,
// stale events drop off and the banner hides itself. 60s is long enough
// to catch the bursty pattern of "page loads, 4 API calls fail" without
// nagging the user after a transient blip clears.
const FRESH_MS = 60_000;

// DemoModeBanner shows up whenever any api.ts method has just fallen back
// to simulated data. The point is to make the lie visible — the dashboard
// still works offline, but the user now knows which slice of what they're
// seeing isn't real. Clicking expands the list of operations.
export function DemoModeBanner() {
  const [recent, setRecent] = useState<{ operation: string; at: number }[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const unsubscribe = subscribeSimulated((events) => {
      setRecent(events);
      // Surfacing a new simulated event resets the dismissal — the user
      // explicitly dismissed the *previous* state, not this fresh one.
      setDismissed(false);
    });
    return unsubscribe;
  }, []);

  // Ticker so the "fresh" window decays in real time without manual refresh.
  useEffect(() => {
    if (recent.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [recent.length]);

  const fresh = recent.filter((e) => now - e.at < FRESH_MS);
  if (dismissed || fresh.length === 0) return null;

  const uniqueOps = Array.from(new Set(fresh.map((e) => e.operation)));
  const summary = uniqueOps.length === 1
    ? `Simulated: ${uniqueOps[0]}`
    : `Simulated data in ${uniqueOps.length} operations`;

  return (
    <div className="border-b border-amber-500/20 bg-amber-500/5">
      <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-6 py-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />
        <div className="flex-1 min-w-0">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-left text-[12px] font-medium text-amber-200 hover:text-amber-100"
          >
            {summary}
            <span className="ml-2 text-[11px] text-amber-300/70">
              · Lantern API offline — values you see are local mocks
            </span>
          </button>
          {expanded && (
            <ul className="mt-1.5 space-y-0.5 text-[11px] text-amber-200/80">
              {uniqueOps.slice(0, 10).map((op) => (
                <li key={op}>
                  <code className="rounded bg-amber-500/10 px-1 py-0.5">{op}</code>
                </li>
              ))}
              {uniqueOps.length > 10 && (
                <li className="text-amber-300/60">
                  +{uniqueOps.length - 10} more
                </li>
              )}
            </ul>
          )}
        </div>
        <Link
          href="/settings"
          className="rounded-md border border-amber-500/30 px-2 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-500/10"
        >
          Check API status
        </Link>
        <button
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="rounded p-1 text-amber-300/70 hover:bg-amber-500/10 hover:text-amber-200"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
