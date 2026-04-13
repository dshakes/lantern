"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
  ArrowRight,
  Hash,
  Clock,
} from "lucide-react";
import { api } from "@/lib/api";
import { agents as mockAgents } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandItem {
  id: string;
  label: string;
  section: string;
  icon: typeof Search;
  shortcut?: string;
  onSelect: () => void;
}

interface AgentSummary {
  name: string;
}

// ---------------------------------------------------------------------------
// Simple fuzzy match
// ---------------------------------------------------------------------------

function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load agents from API on mount (with mock fallback)
  const [agentNames, setAgentNames] = useState<AgentSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function loadAgents() {
      try {
        const agents = await api.listAgents();
        if (!cancelled) setAgentNames(agents.map((a) => ({ name: a.name })));
      } catch {
        // API unavailable — fall back to mock agents
        if (!cancelled) setAgentNames(mockAgents.map((a) => ({ name: a.name })));
      }
    }
    loadAgents();
    return () => { cancelled = true; };
  }, []);

  const items: CommandItem[] = useMemo(
    () => [
      // Navigation
      { id: "nav-agents", label: "Go to Agents", section: "Navigation", icon: Bot, shortcut: "1", onSelect: () => router.push("/agents") },
      { id: "nav-runs", label: "Go to Runs", section: "Navigation", icon: Play, shortcut: "2", onSelect: () => router.push("/runs") },
      { id: "nav-surfaces", label: "Go to Surfaces", section: "Navigation", icon: MessageSquare, shortcut: "3", onSelect: () => router.push("/surfaces") },
      { id: "nav-connectors", label: "Go to Connectors", section: "Navigation", icon: Plug, shortcut: "4", onSelect: () => router.push("/connectors") },
      { id: "nav-deployments", label: "Go to Deployments", section: "Navigation", icon: Cloud, shortcut: "5", onSelect: () => router.push("/deployments") },
      { id: "nav-settings", label: "Go to Settings", section: "Navigation", icon: Settings, shortcut: "6", onSelect: () => router.push("/settings") },
      // Actions
      { id: "action-create-agent", label: "Create new agent", section: "Actions", icon: Plus, onSelect: () => router.push("/agents/create") },
      { id: "action-new-run", label: "Start a new run", section: "Actions", icon: Play, onSelect: () => router.push("/runs") },
      // Agents (loaded dynamically)
      ...agentNames.map((a) => ({
        id: `agent-${a.name}`,
        label: a.name,
        section: "Agents",
        icon: Bot,
        onSelect: () => router.push(`/agents/${encodeURIComponent(a.name)}`),
      })),
      // Recent
      { id: "recent-1", label: "run_01hqa1b2c3d4", section: "Recent", icon: Clock, onSelect: () => router.push("/runs/run_01hqa1b2c3d4") },
      { id: "recent-2", label: "run_01hqa2c3d4e5", section: "Recent", icon: Clock, onSelect: () => router.push("/runs/run_01hqa2c3d4e5") },
    ],
    [router, agentNames],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    return items.filter((item) => fuzzyMatch(item.label, query));
  }, [items, query]);

  // Group by section
  const grouped = useMemo(() => {
    const sectionOrder = ["Recent", "Agents", "Navigation", "Actions"];
    const map = new Map<string, CommandItem[]>();
    for (const item of filtered) {
      const list = map.get(item.section) ?? [];
      list.push(item);
      map.set(item.section, list);
    }
    const result: { section: string; items: CommandItem[] }[] = [];
    for (const section of sectionOrder) {
      const list = map.get(section);
      if (list && list.length > 0) result.push({ section, items: list });
    }
    return result;
  }, [filtered]);

  const flatFiltered = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  // Reset on open/close
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      // Focus input after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Clamp selectedIndex
  useEffect(() => {
    if (selectedIndex >= flatFiltered.length) {
      setSelectedIndex(Math.max(0, flatFiltered.length - 1));
    }
  }, [flatFiltered.length, selectedIndex]);

  // Keyboard shortcut to open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, flatFiltered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = flatFiltered[selectedIndex];
        if (item) {
          item.onSelect();
          setOpen(false);
        }
      }
    },
    [flatFiltered, selectedIndex],
  );

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  let runningIndex = 0;

  return (
    <div
      className="modal-backdrop fixed inset-0 z-[100] flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[20vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="modal-content w-full max-w-xl overflow-hidden rounded-xl border border-zinc-700 bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
          <Search className="h-4.5 w-4.5 shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
          />
          <kbd className="hidden sm:inline-flex h-5 items-center rounded border border-zinc-700 bg-surface-2 px-1.5 text-[10px] font-medium text-zinc-500">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[340px] overflow-y-auto py-2">
          {flatFiltered.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-zinc-500">No results found</p>
              <p className="mt-1 text-xs text-zinc-600">Try a different search term</p>
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.section}>
                <div className="px-4 py-1.5">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                    {group.section}
                  </span>
                </div>
                {group.items.map((item) => {
                  const idx = runningIndex++;
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={item.id}
                      data-index={idx}
                      className={`flex w-full items-center gap-3 px-4 py-2 text-sm transition-colors ${
                        isSelected
                          ? "bg-surface-3 text-zinc-100"
                          : "text-zinc-400 hover:bg-surface-2 hover:text-zinc-200"
                      }`}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onClick={() => {
                        item.onSelect();
                        setOpen(false);
                      }}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1 text-left truncate">{item.label}</span>
                      {item.shortcut && (
                        <kbd className="hidden sm:inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-zinc-700 bg-surface-2 px-1 text-[10px] font-medium text-zinc-500">
                          {item.shortcut}
                        </kbd>
                      )}
                      {isSelected && (
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 border-t border-zinc-800 px-4 py-2">
          <span className="flex items-center gap-1 text-[11px] text-zinc-600">
            <kbd className="rounded border border-zinc-700 bg-surface-2 px-1 text-[10px]">&uarr;&darr;</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1 text-[11px] text-zinc-600">
            <kbd className="rounded border border-zinc-700 bg-surface-2 px-1 text-[10px]">&crarr;</kbd>
            select
          </span>
          <span className="flex items-center gap-1 text-[11px] text-zinc-600">
            <kbd className="rounded border border-zinc-700 bg-surface-2 px-1 text-[10px]">esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
