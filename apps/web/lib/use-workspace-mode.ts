"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MODE_HOME, MODE_STORAGE_KEY, modeForPath, resolveMode, type WorkspaceMode } from "@/lib/workspace-nav";

function readStored(): string | null {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function rememberMode(mode: WorkspaceMode): void {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* storage unavailable — the route still decides the mode */
  }
}

/**
 * The active workspace mode. The route decides when it belongs to a mode;
 * shared routes (/settings) keep whatever mode the user was last in.
 */
export function useWorkspaceMode(): { mode: WorkspaceMode; switchTo: (m: WorkspaceMode) => void } {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  // SSR + first paint: route mode or "pal"; storage is read after mount.
  const [stored, setStored] = useState<string | null>(null);
  useEffect(() => setStored(readStored()), []);

  const mode = resolveMode(pathname, stored);

  // Visiting a mode's route makes it the remembered mode.
  useEffect(() => {
    const routeMode = modeForPath(pathname);
    if (routeMode) {
      rememberMode(routeMode);
      setStored(routeMode);
    }
  }, [pathname]);

  const switchTo = useCallback(
    (m: WorkspaceMode) => {
      rememberMode(m);
      setStored(m);
      router.push(MODE_HOME[m]);
    },
    [router],
  );

  return { mode, switchTo };
}
