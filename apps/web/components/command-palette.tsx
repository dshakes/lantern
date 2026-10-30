"use client";
// ─────────────────────────────────────────────────────────────────────────
// ⌘K — search + Ask PAL (natural-language commands).
//
// Mounted ONCE in (dashboard)/layout.tsx. Opens on ⌘K / Ctrl+K, or from any
// inline command bar via openAsk() (lib/ask-events). Type to filter pages,
// agents and runs; press Enter on the "Ask PAL" row to hand the request to
// the control-plane LLM (lib/assistant — validated, capability-addressed).
//
// Safety: navigation, answers and explanations run directly; anything that
// changes state (creating an agent, pausing/terminating VMs) stops at a
// confirm card that says exactly what will happen. The model cannot invent
// ids — the action is validated against the context it was given.
// ─────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight, Bot, CircleDot, CornerDownLeft, Gauge, Hash, Loader2, Play, Plus, RefreshCw, Search, Server,
  Settings, Sparkles, Sun, Inbox, Zap, Plug, Repeat, type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { api, AssistError, type OnboardingSpec } from "@/lib/api";
import type { Run } from "@/lib/mock-data";
import { runtimeApi } from "@/lib/runtime-api";
import type { VmRow } from "@/lib/runtime-types";
import { ASK_EVENT, type AskEventDetail } from "@/lib/ask-events";
import {
  ASSIST_SYSTEM_PROMPT, formatAssistContext, parseAssistAction, vmActionLabel,
  type AssistAction, type AssistContext,
} from "@/lib/assistant";
import { MODE_LABEL } from "@/lib/workspace-nav";
import { useWorkspaceMode } from "@/lib/use-workspace-mode";

type Section = "Ask PAL" | "Go to" | "Actions" | "Agents" | "Runs";

interface CommandItem {
  id: string;
  label: string;
  meta?: string;
  section: Section;
  icon: LucideIcon;
  agentic?: boolean;
  onSelect: () => void;
}

const SECTION_ORDER: Section[] = ["Ask PAL", "Go to", "Actions", "Agents", "Runs"];
const PER_SECTION_LIMIT = 6;

/** Subsequence fuzzy score rewarding contiguous + early hits; null = no match. */
function fuzzyScore(text: string, query: string): number | null {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0, qi = 0, score = 0, streak = 0, firstHit = -1;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      if (firstHit === -1) firstHit = ti;
      streak += 1;
      score += 1 + streak;
      qi += 1;
    } else streak = 0;
    ti += 1;
  }
  if (qi < q.length) return null;
  return score + Math.max(0, 8 - firstHit);
}

// The Ask PAL result panel's state machine.
type Plan =
  | { state: "thinking" }
  | { state: "answer"; title: string; text: string; link?: { href: string; label: string } }
  | { state: "confirm_agent"; action: Extract<AssistAction, { kind: "create_agent" }>; spec: OnboardingSpec }
  | { state: "confirm_vms"; action: Extract<AssistAction, { kind: "vm_action" }>; selected: string[] }
  | { state: "working"; label: string }
  | { state: "error"; text: string; fix?: { href: string; label: string } };

export function CommandPalette() {
  const router = useRouter();
  const { mode, switchTo } = useWorkspaceMode();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [plan, setPlan] = useState<Plan | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const askSeq = useRef(0);
  const pendingSubmit = useRef<string | null>(null);

  // ── Context data, loaded lazily on first open and refreshed per open ──
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [vms, setVms] = useState<VmRow[]>([]);
  const loadContext = useCallback(async () => {
    const [agents, recent, vmRes] = await Promise.all([
      api.listAgents().catch(() => []),
      api.listRuns().catch(() => [] as Run[]),
      runtimeApi.get<VmRow[] | { items: VmRow[] }>("/v1/runtime/vms?state=running&limit=50").catch(() => [] as VmRow[]),
    ]);
    setAgentNames(agents.map((a) => a.name));
    setRuns(recent.slice(0, 30));
    setVms((Array.isArray(vmRes) ? vmRes : vmRes.items ?? []).filter((v) => v.state === "running"));
  }, []);

  const context = useMemo<AssistContext>(() => {
    const runCountsByStatus: Record<string, number> = {};
    for (const r of runs) runCountsByStatus[r.status || "unknown"] = (runCountsByStatus[r.status || "unknown"] ?? 0) + 1;
    const now = Date.now();
    return {
      mode,
      agentNames,
      runCountsByStatus,
      failedRuns: runs.filter((r) => r.status === "failed").slice(0, 8).map((r) => ({ id: r.id, agentName: r.agentName })),
      runningVms: vms.map((v) => ({
        id: v.vmId,
        idleMinutes: null, // the API exposes no activity signal; the confirm step lets the user choose
        upMinutes: v.createdAt ? Math.max(0, Math.round((now - Date.parse(v.createdAt)) / 60000)) : null,
      })),
    };
  }, [mode, agentNames, runs, vms]);

  const close = useCallback(() => setOpen(false), []);
  const go = useCallback((path: string) => { router.push(path); setOpen(false); }, [router]);

  // ── Execute a validated action ──
  const execute = useCallback(async (action: AssistAction, seq: number) => {
    const stale = () => seq !== askSeq.current;
    switch (action.kind) {
      case "navigate":
        go(action.path);
        return;
      case "answer":
        setPlan({ state: "answer", title: action.summary, text: action.answer });
        return;
      case "explain_run": {
        setPlan({ state: "working", label: "Reading the run…" });
        try {
          const text = await api.assistExplain({ kind: "run", runId: action.runId });
          if (!stale()) setPlan({ state: "answer", title: "Why this run failed", text, link: { href: `/runs/${encodeURIComponent(action.runId)}`, label: "Open run" } });
        } catch (err) {
          if (!stale()) setPlan(assistErrorPlan(err));
        }
        return;
      }
      case "create_agent": {
        setPlan({ state: "working", label: "Designing your agent…" });
        try {
          const spec = await api.generateSpecFromGoal(action.description);
          if (!stale()) setPlan({ state: "confirm_agent", action, spec });
        } catch (err) {
          if (!stale()) setPlan(assistErrorPlan(err));
        }
        return;
      }
      case "vm_action":
        setPlan({ state: "confirm_vms", action, selected: action.vmIds });
        return;
    }
  }, [go]);

  const runAsk = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (q.length < 2) return;
    const seq = ++askSeq.current;
    setPlan({ state: "thinking" });
    const text = await api.assistJSON(ASSIST_SYSTEM_PROMPT, `Workspace context (compact, real):\n${formatAssistContext(context)}\n\nRequest: ${q}`);
    if (seq !== askSeq.current) return;
    const action = text ? parseAssistAction(text, context) : null;
    if (!action) {
      setPlan({
        state: "error",
        text: text
          ? "PAL couldn't turn that into an action. Try rephrasing, or search runs for it."
          : "PAL couldn't reach a model. Check that a provider key is set.",
        fix: text ? { href: `/runs?q=${encodeURIComponent(q)}`, label: "Search runs" } : { href: "/settings?tab=providers", label: "Model providers" },
      });
      return;
    }
    await execute(action, seq);
  }, [context, execute]);

  // ── Confirm handlers (the only place mutations run) ──
  const confirmAgent = useCallback(async (spec: OnboardingSpec) => {
    const seq = ++askSeq.current;
    setPlan({ state: "working", label: "Creating agent…" });
    try {
      await api.createAgent({ name: spec.name, description: spec.description, systemPrompt: spec.systemPrompt, model: spec.model || "auto" });
      if (seq === askSeq.current) go(`/agents/${encodeURIComponent(spec.name)}`);
    } catch (err) {
      if (seq === askSeq.current) setPlan({ state: "error", text: `Couldn't create the agent: ${shortError(err)}` });
    }
  }, [go]);

  const confirmVms = useCallback(async (action: Extract<AssistAction, { kind: "vm_action" }>, ids: string[]) => {
    const seq = ++askSeq.current;
    setPlan({ state: "working", label: `${vmActionLabel(action.op, ids.length)}…` });
    const results = await Promise.allSettled(ids.map((id) => {
      const path = `/v1/runtime/vms/${encodeURIComponent(id)}`;
      return action.op === "terminate" ? runtimeApi.del(path) : runtimeApi.post(`${path}/${action.op}`);
    }));
    if (seq !== askSeq.current) return;
    const failed = results.filter((r) => r.status === "rejected").length;
    setPlan({
      state: "answer",
      title: vmActionLabel(action.op, ids.length),
      text: failed === 0 ? `Done — ${ids.length} VM${ids.length === 1 ? "" : "s"} ${action.op === "terminate" ? "terminating" : action.op + "d"}.` : `${ids.length - failed} succeeded, ${failed} failed. Open Sandboxes for details.`,
      link: { href: "/runtime", label: "Open Sandboxes" },
    });
    void loadContext();
  }, [loadContext]);

  // ── Items ──
  const askItem: CommandItem | null = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return null;
    return { id: "ask", label: `Ask PAL: “${q}”`, meta: "Enter to ask", section: "Ask PAL", icon: Sparkles, agentic: true, onSelect: () => void runAsk(q) };
  }, [query, runAsk]);

  const baseItems = useMemo<CommandItem[]>(() => {
    const nav = (id: string, label: string, icon: LucideIcon, path: string, meta?: string): CommandItem =>
      ({ id, label, icon, meta, section: "Go to", onSelect: () => go(path) });
    const other = mode === "pal" ? "runtime" : "pal";
    const items: CommandItem[] = [
      nav("go-today", "Today — your Brief", Sun, "/brief", "pal"),
      nav("go-holds", "Holds — replies waiting on you", Inbox, "/personal/drafts", "pal"),
      nav("go-automations", "Automations", Zap, "/automations", "pal"),
      nav("go-overview", "Runtime overview", Gauge, "/overview", "Runtime"),
      nav("go-agents", "Agents", Bot, "/agents", "Runtime"),
      nav("go-runs", "Runs", Play, "/runs", "Runtime"),
      nav("go-sandboxes", "Sandboxes", Server, "/runtime", "Runtime"),
      nav("go-connectors", "Connectors", Plug, "/connectors", "Runtime"),
      nav("go-settings", "Settings", Settings, "/settings"),
      { id: "act-switch", label: `Switch to ${MODE_LABEL[other]}`, icon: Repeat, section: "Actions", onSelect: () => { switchTo(other); setOpen(false); } },
      { id: "act-new-agent", label: "Create new agent", icon: Plus, section: "Actions", onSelect: () => go("/agents/create") },
      { id: "act-refresh", label: "Refresh this page", icon: RefreshCw, section: "Actions", onSelect: () => { router.refresh(); setOpen(false); } },
    ];
    for (const name of agentNames) items.push({ id: `agent-${name}`, label: name, icon: Bot, section: "Agents", onSelect: () => go(`/agents/${encodeURIComponent(name)}`) });
    for (const r of runs.slice(0, 12)) items.push({ id: `run-${r.id}`, label: r.id, meta: `${r.agentName} · ${r.status}`, icon: Hash, section: "Runs", onSelect: () => go(`/runs/${encodeURIComponent(r.id)}`) });
    return items;
  }, [mode, agentNames, runs, go, router, switchTo]);

  const grouped = useMemo(() => {
    const q = query.trim();
    const scored = baseItems
      .map((item) => ({ item, score: q ? fuzzyScore(item.meta ? `${item.label} ${item.meta}` : item.label, q) : 0 }))
      .filter((x): x is { item: CommandItem; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
    const bySection = new Map<Section, CommandItem[]>();
    for (const { item } of scored) {
      if (!q && (item.section === "Agents" || item.section === "Runs")) continue; // keep the empty state calm
      const list = bySection.get(item.section) ?? [];
      if (list.length < PER_SECTION_LIMIT) list.push(item);
      bySection.set(item.section, list);
    }
    const out: { section: Section; items: CommandItem[] }[] = [];
    if (askItem) out.push({ section: "Ask PAL", items: [askItem] });
    for (const s of SECTION_ORDER) {
      if (s === "Ask PAL") continue;
      const list = bySection.get(s);
      if (list?.length) out.push({ section: s, items: list });
    }
    return out;
  }, [baseItems, query, askItem]);

  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  // ── Lifecycle ──
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setSelectedIndex(0);
      document.body.style.overflow = "hidden";
      requestAnimationFrame(() => inputRef.current?.focus());
      void loadContext().then(() => {
        const q = pendingSubmit.current;
        pendingSubmit.current = null;
        if (q) void runAsk(q);
      });
    } else {
      document.body.style.overflow = "";
      askSeq.current += 1;
      setPlan(null);
      setQuery("");
      restoreFocusRef.current?.focus?.();
    }
    return () => { document.body.style.overflow = ""; };
    // runAsk is intentionally read at open time only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadContext]);

  useEffect(() => {
    setSelectedIndex((i) => (i >= flat.length ? Math.max(0, flat.length - 1) : i));
  }, [flat.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((p) => !p);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onAsk = (e: Event) => {
      const d = (e as CustomEvent<AskEventDetail>).detail ?? {};
      setQuery(d.query ?? "");
      if (d.submit && d.query) pendingSubmit.current = d.query;
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(ASK_EVENT, onAsk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(ASK_EVENT, onAsk);
    };
  }, []);

  const onInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); flat[selectedIndex]?.onSelect(); }
  }, [flat, selectedIndex]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;
  let cursor = 0;

  return (
    <div className="modal-backdrop fixed inset-0 z-[100] flex items-start justify-center bg-black/50 px-4 pt-[12vh]" onClick={close} role="presentation">
      <div
        className="modal-content w-full max-w-xl overflow-hidden rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Ask PAL"
      >
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3.5">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
              if (plan) { askSeq.current += 1; setPlan(null); }
            }}
            onKeyDown={onInputKeyDown}
            placeholder={mode === "pal" ? "Ask PAL or search — “what needs me today?”" : "Ask PAL or search — “pause idle VMs”"}
            aria-label="Ask PAL or search"
            aria-controls="command-list"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 bg-transparent text-sm text-zinc-100 !shadow-none !outline-none placeholder:text-zinc-500"
          />
          <kbd className="hidden h-5 items-center rounded border border-zinc-700 bg-surface-2 px-1.5 text-[11px] font-medium text-zinc-500 sm:inline-flex">ESC</kbd>
        </div>

        {plan && <PlanPanel plan={plan} setPlan={setPlan} onConfirmAgent={confirmAgent} onConfirmVms={confirmVms} onNavigate={close} />}

        <div ref={listRef} id="command-list" role="listbox" aria-label="Commands" className="max-h-[min(55vh,420px)] overflow-y-auto py-2">
          {flat.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-zinc-400">No matches</p>
              <p className="mt-1 text-xs text-zinc-600">Describe what you want — “create an agent that triages GitHub issues”.</p>
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.section} className="mb-1 last:mb-0">
                <div className="flex items-center gap-1.5 px-4 pb-1 pt-2">
                  {group.section === "Ask PAL" && <Sparkles className="h-3 w-3 text-pal-400" aria-hidden />}
                  <span className={clsx("mc-micro-label", group.section === "Ask PAL" && "!text-pal-400")}>{group.section}</span>
                </div>
                {group.items.map((item) => {
                  const idx = cursor++;
                  const selected = idx === selectedIndex;
                  const Icon = item.agentic && plan?.state === "thinking" ? Loader2 : item.icon;
                  return (
                    <button
                      key={item.id}
                      data-index={idx}
                      role="option"
                      aria-selected={selected}
                      onMouseMove={() => setSelectedIndex(idx)}
                      onClick={() => item.onSelect()}
                      className={clsx(
                        "mx-1 flex w-[calc(100%-0.5rem)] items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                        selected ? (item.agentic ? "bg-pal-500/10 text-zinc-50 ring-1 ring-inset ring-pal-500/30" : "bg-surface-3 text-zinc-50") : "text-zinc-400 hover:bg-surface-2 hover:text-zinc-200",
                      )}
                    >
                      <span className={clsx("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", item.agentic ? "bg-pal-500/15 text-pal-400" : "bg-surface-2 text-zinc-400")}>
                        <Icon className={clsx("h-4 w-4", item.agentic && plan?.state === "thinking" && "animate-spin")} aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                      {item.meta && <span className="hidden shrink-0 truncate text-[12px] text-zinc-500 sm:block">{item.meta}</span>}
                      {selected && <CornerDownLeft className="hidden h-3.5 w-3.5 shrink-0 text-zinc-500 sm:block" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-zinc-800 px-4 py-2.5 text-[12px] text-zinc-600">
          <span><kbd className="rounded border border-zinc-700 bg-surface-2 px-1 text-[11px]">↑↓</kbd> navigate</span>
          <span><kbd className="rounded border border-zinc-700 bg-surface-2 px-1 text-[11px]">↵</kbd> select</span>
          <span className="ml-auto hidden items-center gap-1.5 text-pal-400 sm:flex">
            <CircleDot className="h-2.5 w-2.5" aria-hidden /> Changes always ask first
          </span>
        </div>
      </div>
    </div>
  );
}

function shortError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  const body = m.match(/API \d+: (.*)/)?.[1];
  if (body) {
    try { return (JSON.parse(body) as { error?: string }).error ?? body; } catch { return body.slice(0, 160); }
  }
  return m.slice(0, 160);
}

function assistErrorPlan(err: unknown): Plan {
  if (err instanceof AssistError && err.code === "no_provider") return { state: "error", text: err.message, fix: { href: "/settings?tab=providers", label: "Add a key" } };
  if (err instanceof AssistError) return { state: "error", text: err.message };
  const msg = shortError(err);
  if (msg.includes("no_provider") || msg.toLowerCase().includes("provider")) return { state: "error", text: "Add a model provider key first.", fix: { href: "/settings?tab=providers", label: "Add a key" } };
  return { state: "error", text: msg || "Something went wrong." };
}

function PlanPanel({
  plan, setPlan, onConfirmAgent, onConfirmVms, onNavigate,
}: {
  plan: Plan;
  setPlan: (p: Plan | null) => void;
  onConfirmAgent: (spec: OnboardingSpec) => void;
  onConfirmVms: (action: Extract<AssistAction, { kind: "vm_action" }>, ids: string[]) => void;
  onNavigate: () => void;
}) {
  const box = "mx-3 mt-3 rounded-xl border px-4 py-3";
  switch (plan.state) {
    case "thinking":
    case "working":
      return (
        <div className={clsx(box, "border-zinc-800 bg-surface-2")} role="status" aria-live="polite">
          <p className="flex items-center gap-2 text-sm text-zinc-300">
            <Loader2 className="h-4 w-4 animate-spin text-pal-400" />
            {plan.state === "thinking" ? "Thinking…" : plan.label}
          </p>
        </div>
      );
    case "answer":
      return (
        <div className={clsx(box, "border-pal-500/25 bg-pal-500/[0.06]")} role="status" aria-live="polite">
          <p className="mc-micro-label flex items-center gap-1.5 !text-pal-400"><Sparkles className="h-3 w-3" /> {plan.title}</p>
          <p className="mt-1.5 text-sm leading-relaxed text-zinc-100">{plan.text}</p>
          {plan.link && (
            <Link href={plan.link.href} onClick={onNavigate} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-pal-400 hover:text-pal-300">
              {plan.link.label} <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      );
    case "error":
      return (
        <div className={clsx(box, "border-amber-500/25 bg-amber-500/5")} role="alert">
          <p className="text-sm text-amber-300">{plan.text}</p>
          {plan.fix && (
            <Link href={plan.fix.href} onClick={onNavigate} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-300 underline-offset-2 hover:underline">
              {plan.fix.label} <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      );
    case "confirm_agent":
      return (
        <div className={clsx(box, "border-zinc-800 bg-surface-2")}>
          <p className="mc-micro-label">Confirm — create agent</p>
          <p className="mt-1.5 font-mono text-sm text-zinc-50">{plan.spec.name}</p>
          {plan.spec.description && <p className="mt-0.5 text-xs text-zinc-400">{plan.spec.description}</p>}
          {plan.spec.rationale && <p className="mt-1.5 text-xs text-zinc-500">{plan.spec.rationale}</p>}
          <div className="mt-3 flex gap-2">
            <button onClick={() => onConfirmAgent(plan.spec)} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-pal-400 px-3 text-xs font-medium text-on-flame hover:bg-pal-300">
              <Plus className="h-3.5 w-3.5" /> Create agent
            </button>
            <Link href="/agents/create" onClick={onNavigate} className="inline-flex h-8 items-center rounded-lg border border-zinc-700 px-3 text-xs text-zinc-300 hover:bg-surface-3">
              Edit first
            </Link>
            <button onClick={() => setPlan(null)} className="inline-flex h-8 items-center rounded-lg px-3 text-xs text-zinc-500 hover:text-zinc-200">Cancel</button>
          </div>
        </div>
      );
    case "confirm_vms": {
      const { action, selected } = plan;
      const toggle = (id: string) =>
        setPlan({ ...plan, selected: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id] });
      return (
        <div className={clsx(box, action.op === "terminate" ? "border-red-500/25 bg-red-500/5" : "border-zinc-800 bg-surface-2")}>
          <p className="mc-micro-label">Confirm — {vmActionLabel(action.op, selected.length).toLowerCase()}</p>
          <p className="mt-1 text-xs text-zinc-400">{action.summary}</p>
          <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto">
            {action.vmIds.map((id) => (
              <li key={id}>
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <input type="checkbox" checked={selected.includes(id)} onChange={() => toggle(id)} className="accent-[var(--color-pal-500)]" />
                  <span className="font-mono">{id}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <button
              disabled={selected.length === 0}
              onClick={() => onConfirmVms(action, selected)}
              className={clsx(
                "inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium disabled:opacity-50",
                action.op === "terminate" ? "border border-red-500/30 bg-red-500/15 text-red-300 hover:bg-red-500/25" : "bg-pal-400 text-on-flame hover:bg-pal-300",
              )}
            >
              {vmActionLabel(action.op, selected.length)}
            </button>
            <button onClick={() => setPlan(null)} className="inline-flex h-8 items-center rounded-lg px-3 text-xs text-zinc-500 hover:text-zinc-200">Cancel</button>
          </div>
        </div>
      );
    }
  }
}
