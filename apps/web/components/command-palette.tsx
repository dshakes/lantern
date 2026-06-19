"use client";

// ─────────────────────────────────────────────────────────────────────────
// Lantern ⌘K Command Palette
//
// The global console primitive — Linear/Vercel/Raycast-grade — with an
// agentic "Ask Lantern" row at the top. Calm Google/Anthropic aesthetic:
// soft backdrop blur, a rounded surface-1 panel, one accent on the active
// row, monochrome icons, generous spacing.
//
// Mounted ONCE in (dashboard)/layout.tsx. Opens from anywhere on ⌘K / Ctrl+K
// (or the topbar "Search" affordance, which dispatches the same keydown).
// Esc closes; type to fuzzy-filter; ↑/↓ to move; Enter to run.
//
// Hand-rolled (no `cmdk` dependency) on React + existing tokens/icons.
// ─────────────────────────────────────────────────────────────────────────

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Bot,
  Play,
  MessageSquare,
  Plug,
  Cloud,
  Settings,
  Plus,
  CornerDownLeft,
  Hash,
  Server,
  Inbox,
  RefreshCw,
  Sparkles,
  CalendarPlus,
  CircleDot,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Run } from "@/lib/mock-data";

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

type Section =
  | "Ask Lantern"
  | "Quick actions"
  | "Agents"
  | "Runs"
  | "Workloads";

interface CommandItem {
  id: string;
  label: string;
  /** Secondary muted text shown to the right of the label (status, hint). */
  meta?: string;
  section: Section;
  icon: LucideIcon;
  /** Keyboard hint chip on the right (e.g. a go-to shortcut). */
  shortcut?: string;
  /** Marks the agentic row so it gets the ✨ accent treatment. */
  agentic?: boolean;
  /** Lower number sorts first within a section + in fuzzy ranking ties. */
  weight?: number;
  onSelect: () => void;
}

const SECTION_ORDER: Section[] = [
  "Ask Lantern",
  "Quick actions",
  "Agents",
  "Runs",
  "Workloads",
];

const RECENT_KEY = "lantern_palette_recent";
const PER_SECTION_LIMIT = 6;

// ─────────────────────────────────────────────────────────────────────────
// Fuzzy match + score — subsequence match, rewarding contiguous + prefix hits
// ─────────────────────────────────────────────────────────────────────────

function fuzzyScore(text: string, query: string): number | null {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  let qi = 0;
  let score = 0;
  let streak = 0;
  let firstHit = -1;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      if (firstHit === -1) firstHit = ti;
      streak += 1;
      score += 1 + streak; // contiguous runs compound
      qi += 1;
    } else {
      streak = 0;
    }
    ti += 1;
  }
  if (qi < q.length) return null; // not all query chars matched
  // Reward early matches (prefix-ish) — lower firstHit is better.
  score += Math.max(0, 8 - firstHit);
  return score;
}

// ─────────────────────────────────────────────────────────────────────────
// Ask Lantern — demo-grade client-side intent layer.
//
// In production this query would be handed to the Lantern agent/LLM
// (router → a small intent model, or the control-plane's existing
// /v1/completions) which would return a structured action. Here we
// pattern-match a handful of common intents deterministically so the row
// FEELS agentic and actually navigates/acts. See `interpretIntent`.
// ─────────────────────────────────────────────────────────────────────────

interface ResolvedIntent {
  /** One-line restatement of what Lantern will do. */
  summary: string;
  run: () => void;
}

function interpretIntent(
  rawQuery: string,
  router: ReturnType<typeof useRouter>,
  agentNames: string[],
): ResolvedIntent {
  const q = rawQuery.trim();
  const lower = q.toLowerCase();

  const go = (path: string, summary: string): ResolvedIntent => ({
    summary,
    run: () => router.push(path),
  });

  // 1. Failing / broken / errored runs → the needs-review queue in Inbox.
  if (/\b(fail|failing|failed|error|errored|broke|broken|crash)\b/.test(lower)) {
    return go(
      "/inbox",
      "Show runs that need review (failed / errored)",
    );
  }

  // 2. Running / live / in-flight work → Inbox live queue (or Runs).
  if (/\b(running|live|in.?flight|active|in progress|ongoing)\b/.test(lower)) {
    return go("/inbox", "Show live runs in flight");
  }

  // 3. Runtime / workloads / microVMs / regions (us-east, etc.) → Runtime.
  if (
    /\b(workload|workloads|microvm|micro.?vm|vm|vms|node|nodes|fleet|cluster|capacity)\b/.test(
      lower,
    ) ||
    /\b(us-?east|us-?west|eu-?\w+|region|regions)\b/.test(lower)
  ) {
    return go("/runtime", "Open Runtime — workloads & capacity");
  }

  // 4. Schedule something → the Runtime schedule modal (deep-linked).
  if (/\b(schedule|run at|cron|every (day|hour|week)|nightly|daily)\b/.test(lower)) {
    return {
      summary: "Schedule a workload",
      run: () => router.push("/runtime?schedule=1"),
    };
  }

  // 5. Connectors / integrations.
  if (/\b(connect|connector|connectors|integration|integrations|oauth)\b/.test(lower)) {
    return go("/connectors", "Open Connectors");
  }

  // 6. Channels / whatsapp / slack / telegram / surfaces.
  if (/\b(channel|channels|whatsapp|slack|telegram|surface|surfaces|webchat)\b/.test(lower)) {
    return go("/surfaces", "Open Channels");
  }

  // 7. Deployments / data plane.
  if (/\b(deploy|deployment|deployments|data.?plane|dataplane)\b/.test(lower)) {
    return go("/deployments", "Open Deployments & data planes");
  }

  // 8. Settings / providers / keys.
  if (/\b(setting|settings|provider|providers|api key|api keys|billing)\b/.test(lower)) {
    return go("/settings", "Open Settings");
  }

  // 9. Direct agent-name reference (fuzzy contains) → that agent.
  const hit = agentNames.find(
    (n) => lower.includes(n.toLowerCase()) || n.toLowerCase().includes(lower),
  );
  if (hit && lower.length >= 2) {
    return {
      summary: `Open agent “${hit}”`,
      run: () => router.push(`/agents/${encodeURIComponent(hit)}`),
    };
  }

  // 10. Fallback — route to a scoped Runs search so the query is never a
  //     dead end. (Production: hand off to the agent for a real answer.)
  return {
    summary: "Search runs & agents for this",
    run: () => router.push(`/runs?q=${encodeURIComponent(q)}`),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Element focused before the palette opened — restored on close (a11y).
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // ── Data: agents + recent runs, lazily loaded the first time it opens ──
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const loadedRef = useRef(false);
  const [recentIds, setRecentIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const agents = await api.listAgents();
        if (!cancelled) setAgentNames(agents.map((a) => a.name));
      } catch {
        /* API offline — agents section just stays empty. */
      }
      try {
        const runs = await api.listRuns();
        if (!cancelled) setRecentRuns(runs.slice(0, 12));
      } catch {
        /* API offline — runs section just stays empty. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Recent command ids (localStorage) — surfaced to bias the empty state.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (raw) setRecentIds(JSON.parse(raw) as string[]);
    } catch {
      /* corrupt / unavailable — ignore */
    }
  }, [open]);

  const pushRecent = useCallback((id: string) => {
    setRecentIds((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, 8);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const act = useCallback(
    (item: CommandItem) => {
      pushRecent(item.id);
      item.onSelect();
      setOpen(false);
    },
    [pushRecent],
  );

  // ── The agentic "Ask Lantern" item (only when there's a real query) ──
  const askItem: CommandItem | null = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return null;
    const intent = interpretIntent(q, router, agentNames);
    return {
      id: "ask-lantern",
      label: `Ask Lantern: “${q}”`,
      meta: intent.summary,
      section: "Ask Lantern",
      icon: Sparkles,
      agentic: true,
      weight: -100, // always pinned to the very top
      onSelect: intent.run,
    };
  }, [query, router, agentNames]);

  // ── Static quick actions + dynamic agents/runs/workloads ──
  const baseItems: CommandItem[] = useMemo(() => {
    const nav = (
      id: string,
      label: string,
      icon: LucideIcon,
      path: string,
    ): CommandItem => ({
      id,
      label,
      section: "Quick actions",
      icon,
      onSelect: () => router.push(path),
    });

    const items: CommandItem[] = [
      {
        id: "qa-schedule",
        label: "Schedule a workload",
        meta: "Runtime",
        section: "Quick actions",
        icon: CalendarPlus,
        onSelect: () => router.push("/runtime?schedule=1"),
      },
      nav("qa-runtime", "Go to Runtime", Server, "/runtime"),
      nav("qa-inbox", "Go to Mission Control", Inbox, "/inbox"),
      nav("qa-runs", "Go to Runs", Play, "/runs"),
      nav("qa-agents", "Go to Agents", Bot, "/agents"),
      nav("qa-channels", "Go to Channels", MessageSquare, "/surfaces"),
      nav("qa-connectors", "Go to Connectors", Plug, "/connectors"),
      nav("qa-dataplane", "Go to Data planes", Cloud, "/deployments"),
      nav("qa-settings", "Go to Settings", Settings, "/settings"),
      {
        id: "qa-new-agent",
        label: "Create new agent",
        section: "Quick actions",
        icon: Plus,
        onSelect: () => router.push("/agents/create"),
      },
      {
        id: "qa-refresh",
        label: "Refresh this page",
        section: "Quick actions",
        icon: RefreshCw,
        onSelect: () => router.refresh(),
      },
    ];

    for (const name of agentNames) {
      items.push({
        id: `agent-${name}`,
        label: name,
        section: "Agents",
        icon: Bot,
        onSelect: () => router.push(`/agents/${encodeURIComponent(name)}`),
      });
    }

    for (const run of recentRuns) {
      items.push({
        id: `run-${run.id}`,
        label: run.id,
        meta: `${run.agentName} · ${run.status}`,
        section: "Runs",
        icon: Hash,
        onSelect: () => router.push(`/runs/${encodeURIComponent(run.id)}`),
      });
    }

    items.push(
      {
        id: "wl-runtime",
        label: "View running workloads",
        meta: "Runtime",
        section: "Workloads",
        icon: Server,
        onSelect: () => router.push("/runtime"),
      },
      {
        id: "wl-dataplanes",
        label: "View data planes",
        meta: "Deployments",
        section: "Workloads",
        icon: Cloud,
        onSelect: () => router.push("/deployments"),
      },
    );

    return items;
  }, [router, agentNames, recentRuns]);

  // ── Filter + rank ──
  const grouped = useMemo(() => {
    const q = query.trim();
    const scored: { item: CommandItem; score: number }[] = [];

    for (const item of baseItems) {
      if (!q) {
        scored.push({ item, score: 0 });
        continue;
      }
      // Match against label + meta so "failed" finds a run row, etc.
      const hay = item.meta ? `${item.label} ${item.meta}` : item.label;
      const s = fuzzyScore(hay, q);
      if (s !== null) scored.push({ item, score: s });
    }

    // Sort within each section by score desc, then weight, then label.
    const bySection = new Map<Section, CommandItem[]>();
    scored
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.item.weight ?? 0) - (b.item.weight ?? 0) ||
          a.item.label.localeCompare(b.item.label),
      )
      .forEach(({ item }) => {
        const list = bySection.get(item.section) ?? [];
        if (list.length < PER_SECTION_LIMIT) list.push(item);
        bySection.set(item.section, list);
      });

    const out: { section: Section; items: CommandItem[] }[] = [];

    // Ask Lantern always leads when present.
    if (askItem) out.push({ section: "Ask Lantern", items: [askItem] });

    for (const section of SECTION_ORDER) {
      if (section === "Ask Lantern") continue;
      const list = bySection.get(section);
      if (list && list.length > 0) out.push({ section, items: list });
    }
    return out;
  }, [baseItems, query, askItem]);

  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  // ── Open/close lifecycle: reset query, manage focus restore ──
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setSelectedIndex(0);
      document.body.style.overflow = "hidden";
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      document.body.style.overflow = "";
      restoreFocusRef.current?.focus?.();
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Keep selection in range as the list shrinks/grows.
  useEffect(() => {
    setSelectedIndex((i) => (i >= flat.length ? Math.max(0, flat.length - 1) : i));
  }, [flat.length]);

  // ── Global ⌘K / Ctrl+K toggle + Esc ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((p) => !p);
      } else if (e.key === "Escape") {
        setOpen((p) => (p ? false : p));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── In-palette navigation keys ──
  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flat.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = flat[selectedIndex];
        if (item) act(item);
      }
    },
    [flat, selectedIndex, act],
  );

  // Keep the active row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  // Flat running index lets the grouped render share one selection cursor.
  let cursor = 0;

  return (
    <div
      className="modal-backdrop fixed inset-0 z-[100] flex items-start justify-center bg-black/50 px-4 pt-[16vh] backdrop-blur-md"
      onClick={close}
      role="presentation"
    >
      <div
        className="modal-content w-full max-w-xl overflow-hidden rounded-2xl border border-zinc-700/80 bg-surface-1 shadow-2xl ring-1 ring-black/20"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3.5">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Search or ask Lantern…"
            aria-label="Search or ask Lantern"
            aria-controls="command-palette-list"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <kbd className="hidden h-5 items-center rounded border border-zinc-700 bg-surface-2 px-1.5 text-[10px] font-medium text-zinc-500 sm:inline-flex">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label="Commands"
          className="max-h-[min(60vh,420px)] overflow-y-auto py-2"
        >
          {flat.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-zinc-400">No matches</p>
              <p className="mt-1 text-xs text-zinc-600">
                Try an agent name, a run id, or describe what you want.
              </p>
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.section} className="mb-1 last:mb-0">
                <div className="flex items-center gap-1.5 px-4 pb-1 pt-2">
                  {group.section === "Ask Lantern" && (
                    <Sparkles className="h-3 w-3 text-lantern-400" aria-hidden />
                  )}
                  <span
                    className={
                      group.section === "Ask Lantern"
                        ? "text-[11px] font-semibold uppercase tracking-wider text-lantern-300/90"
                        : "text-[11px] font-medium uppercase tracking-wider text-zinc-600"
                    }
                  >
                    {group.section}
                  </span>
                </div>
                {group.items.map((item) => {
                  const idx = cursor++;
                  const selected = idx === selectedIndex;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      data-index={idx}
                      role="option"
                      aria-selected={selected}
                      onMouseMove={() => setSelectedIndex(idx)}
                      onClick={() => act(item)}
                      className={[
                        "group/item flex w-full items-center gap-3 px-3 py-2 text-sm transition-colors",
                        "mx-1 rounded-lg",
                        selected
                          ? item.agentic
                            ? "bg-lantern-500/10 text-zinc-100 ring-1 ring-inset ring-lantern-500/30"
                            : "bg-surface-3 text-zinc-100"
                          : "text-zinc-400 hover:bg-surface-2 hover:text-zinc-200",
                      ].join(" ")}
                    >
                      <span
                        className={[
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                          item.agentic
                            ? "bg-lantern-500/15 text-lantern-300"
                            : "bg-surface-2 text-zinc-400 group-hover/item:text-zinc-300",
                        ].join(" ")}
                      >
                        <Icon className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate">{item.label}</span>
                      </span>
                      {item.meta && (
                        <span className="hidden shrink-0 truncate text-[11px] text-zinc-500 sm:block">
                          {item.meta}
                        </span>
                      )}
                      {item.agentic ? (
                        <span className="flex shrink-0 items-center gap-1 rounded-md border border-lantern-500/30 bg-lantern-500/10 px-1.5 py-0.5 text-[10px] font-medium text-lantern-300">
                          <Sparkles className="h-2.5 w-2.5" aria-hidden />
                          act
                        </span>
                      ) : item.shortcut ? (
                        <kbd className="hidden h-5 min-w-[20px] shrink-0 items-center justify-center rounded border border-zinc-700 bg-surface-2 px-1 text-[10px] font-medium text-zinc-500 sm:inline-flex">
                          {item.shortcut}
                        </kbd>
                      ) : (
                        selected && (
                          <CornerDownLeft
                            className="hidden h-3.5 w-3.5 shrink-0 text-zinc-500 sm:block"
                            aria-hidden
                          />
                        )
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 border-t border-zinc-800 px-4 py-2.5">
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-600">
            <kbd className="rounded border border-zinc-700 bg-surface-2 px-1 text-[10px]">
              &uarr;&darr;
            </kbd>
            navigate
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-600">
            <kbd className="rounded border border-zinc-700 bg-surface-2 px-1 text-[10px]">
              &crarr;
            </kbd>
            to select
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-600">
            <kbd className="rounded border border-zinc-700 bg-surface-2 px-1 text-[10px]">
              esc
            </kbd>
            to close
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-lantern-400/80">
            <CircleDot className="h-2.5 w-2.5" aria-hidden />
            Ask Lantern ✨
          </span>
        </div>
      </div>
    </div>
  );
}
