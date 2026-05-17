"use client";

// Last-visited-agent cache.
//
// We persist the slug of the most recently opened agent in localStorage so
// the home page (/) can route the user straight back into their workspace
// on every subsequent visit — same UX as Claude's "your most recent
// conversation opens by default" pattern. Only the slug is stored; the
// actual agent record is re-fetched from the API on hit so the cache
// never goes stale.

const KEY = "lantern_last_agent";

export function getLastAgent(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setLastAgent(name: string): void {
  if (typeof window === "undefined") return;
  if (!name) return;
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // localStorage can throw in private-browsing modes; safe to ignore.
  }
}

export function clearLastAgent(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignored
  }
}
