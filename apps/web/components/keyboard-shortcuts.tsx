"use client";

// Global keyboard shortcuts — Linear/GitHub-grade nav.
//
// Convention:
//   - 1-4 jump to the four primary destinations (handled in sidebar already).
//   - `g <key>` go-to combos: g a → Agents, g i → Inbox, g r → Runs, etc.
//     Press `g`, release, then press the target letter within 800ms.
//   - `?` opens the shortcut cheat sheet.
//   - `Esc` closes the cheat sheet.
//
// All combos honor the standard "don't fire while typing" rule: if focus is
// in an input/textarea/contenteditable element, the handler bails. The user
// can still type `g` in a text field without triggering navigation.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Command as CommandIcon } from "lucide-react";

interface ShortcutDef {
  combo: string;        // visual representation, e.g. "g a"
  description: string;
  group: "Navigate" | "Action" | "Help";
  // For "g <key>" combos, the second key character.
  goToKey?: string;
  href?: string;
  fire?: () => void;
}

const SHORTCUTS: ShortcutDef[] = [
  { combo: "g a", description: "Go to Agents", group: "Navigate", goToKey: "a", href: "/agents" },
  { combo: "g i", description: "Go to Activity (Inbox)", group: "Navigate", goToKey: "i", href: "/inbox" },
  { combo: "g s", description: "Go to Settings", group: "Navigate", goToKey: "s", href: "/settings" },
  { combo: "g n", description: "New agent", group: "Navigate", goToKey: "n", href: "/agents/create" },
  { combo: "g m", description: "Templates marketplace", group: "Navigate", goToKey: "m", href: "/marketplace" },
  { combo: "g x", description: "Analytics", group: "Navigate", goToKey: "x", href: "/evaluations" },
  { combo: "/", description: "Search agents", group: "Action" },
  { combo: "⌘K", description: "Open command palette", group: "Action" },
  { combo: "?", description: "Show this cheat sheet", group: "Help" },
  { combo: "Esc", description: "Close dialogs / cheat sheet", group: "Help" },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function KeyboardShortcuts() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Track whether the user just pressed `g`. We accept the next character
    // within 800ms as the second half of a go-to combo. Outside that window
    // the state resets so a lone `g` press doesn't shadow normal typing.
    let goToArmed = false;
    let goToTimeout: ReturnType<typeof setTimeout> | null = null;

    const disarmGoTo = () => {
      goToArmed = false;
      if (goToTimeout) clearTimeout(goToTimeout);
      goToTimeout = null;
    };

    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) {
        // Cmd-K is owned by the command palette; we don't intercept it.
        return;
      }

      // ?  →  open cheat sheet
      if (e.key === "?") {
        e.preventDefault();
        setOpen(true);
        disarmGoTo();
        return;
      }
      // Esc  →  close cheat sheet
      if (e.key === "Escape" && open) {
        setOpen(false);
        return;
      }

      if (goToArmed) {
        const match = SHORTCUTS.find((s) => s.goToKey === e.key.toLowerCase());
        if (match) {
          e.preventDefault();
          disarmGoTo();
          if (match.href) router.push(match.href);
          else match.fire?.();
          return;
        }
        disarmGoTo();
        return;
      }

      if (e.key === "g") {
        e.preventDefault();
        goToArmed = true;
        goToTimeout = setTimeout(disarmGoTo, 800);
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (goToTimeout) clearTimeout(goToTimeout);
    };
  }, [router, open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbd-help-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-(--radius-xl) border border-zinc-800 bg-surface-1 shadow-(--elev-4)"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 id="kbd-help-title" className="inline-flex items-center gap-2 text-(--text-base) font-semibold text-zinc-100">
            <CommandIcon className="h-4 w-4 text-zinc-500" />
            Keyboard shortcuts
          </h2>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="rounded-md p-1 text-zinc-500 transition-colors duration-(--motion-fast) hover:bg-surface-3 hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] divide-y divide-zinc-800 overflow-y-auto">
          {(["Navigate", "Action", "Help"] as const).map((group) => {
            const items = SHORTCUTS.filter((s) => s.group === group);
            if (items.length === 0) return null;
            return (
              <section key={group} className="px-5 py-4">
                <h3 className="mb-2 text-(--text-xs) font-medium uppercase tracking-wider text-zinc-500">
                  {group}
                </h3>
                <ul className="space-y-1.5">
                  {items.map((s) => (
                    <li key={s.combo} className="flex items-center justify-between gap-3">
                      <span className="text-(--text-sm) text-zinc-300">{s.description}</span>
                      <kbd className="rounded-(--radius-sm) border border-zinc-700 bg-surface-2 px-2 py-0.5 font-mono text-(--text-xs) text-zinc-300">
                        {s.combo}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        <div className="border-t border-zinc-800 px-5 py-2.5 text-(--text-xs) text-zinc-500">
          Press <kbd className="rounded border border-zinc-700 bg-surface-2 px-1.5 text-zinc-300">?</kbd> anywhere to open this.
        </div>
      </div>
    </div>
  );
}
