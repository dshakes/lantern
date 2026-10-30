"use client";

import clsx from "clsx";
import { MODE_LABEL, type WorkspaceMode } from "@/lib/workspace-nav";
import { useWorkspaceMode } from "@/lib/use-workspace-mode";

/**
 * pal ⇄ Runtime switch. Two clear home spaces: the personal layer and the
 * builder runtime. Each half carries its brand accent (coral→magenta for pal,
 * indigo→cyan for Runtime) as a small dot — solid UI, gradient only as a mark.
 */
export function ModeSwitch({ compact = false }: { compact?: boolean }) {
  const { mode, switchTo } = useWorkspaceMode();
  return (
    <div
      role="group"
      aria-label="Workspace"
      className="grid grid-cols-2 gap-0.5 rounded-xl border border-zinc-800 bg-surface-0 p-0.5"
    >
      {(["pal", "runtime"] as WorkspaceMode[]).map((m) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={active}
            onClick={() => !active && switchTo(m)}
            className={clsx(
              "flex items-center justify-center gap-1.5 rounded-[10px] px-2 font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pal-400/50",
              compact ? "py-1.5 text-xs" : "py-1.5 text-[12px]",
              active ? "bg-surface-3 text-zinc-50 shadow-sm" : "text-zinc-500 hover:text-zinc-200",
            )}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundImage: m === "pal" ? "var(--pal-grad)" : "var(--rt-grad)" }}
            />
            {MODE_LABEL[m]}
          </button>
        );
      })}
    </div>
  );
}
