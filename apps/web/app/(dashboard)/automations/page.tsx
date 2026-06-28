"use client";

/**
 * Automations page — mobile-first feed of life-events (bills, deliveries,
 * appointments, etc.) classified by the bot, plus per-kind trust toggles.
 *
 * Mobile-first: single-column, 390 px viewport, large tap targets (min-h-14).
 * Uses existing dashboard primitives: PageHeader, Button, EmptyState,
 * Skeleton, useToast.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Package,
  DollarSign,
  AlertTriangle,
  Key,
  Plane,
  Receipt,
  Calendar,
  Tag,
  RefreshCw,
  Undo2,
  CheckCircle2,
  ExternalLink,
  Phone,
  Zap,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import type { LifeEvent, LifeEventPref, LifeEventMode, LifeEventKind } from "@/lib/api";
import clsx from "clsx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KIND_ICONS: Record<LifeEventKind, React.ReactNode> = {
  delivery: <Package className="h-4 w-4" />,
  bill: <DollarSign className="h-4 w-4" />,
  fraud_alert: <AlertTriangle className="h-4 w-4" />,
  otp: <Key className="h-4 w-4" />,
  travel: <Plane className="h-4 w-4" />,
  receipt: <Receipt className="h-4 w-4" />,
  appointment: <Calendar className="h-4 w-4" />,
  promo: <Tag className="h-4 w-4" />,
};

const KIND_LABELS: Record<LifeEventKind, string> = {
  delivery: "Deliveries",
  bill: "Bills",
  fraud_alert: "Fraud alerts",
  otp: "OTPs",
  travel: "Travel",
  receipt: "Receipts",
  appointment: "Appointments",
  promo: "Promos",
};

const KIND_EMOJI: Record<LifeEventKind, string> = {
  delivery: "📦",
  bill: "💸",
  fraud_alert: "🚨",
  otp: "🔑",
  travel: "✈️",
  receipt: "🧾",
  appointment: "📅",
  promo: "🏷️",
};

const STATUS_LABELS: Record<string, string> = {
  suggested: "Suggested",
  auto_acted: "Auto-acted",
  undone: "Undone",
  dismissed: "Dismissed",
};

const STATUS_COLORS: Record<string, string> = {
  suggested: "bg-lantern-500/15 text-lantern-300",
  auto_acted: "bg-emerald-500/15 text-emerald-300",
  undone: "bg-zinc-700/40 text-zinc-400",
  dismissed: "bg-zinc-700/30 text-zinc-500",
};

const MODE_LABELS: Record<LifeEventMode, string> = {
  auto: "Auto",
  ask: "Ask",
  off: "Off",
};

const PREF_KINDS: LifeEventKind[] = [
  "delivery",
  "bill",
  "appointment",
  "fraud_alert",
  "otp",
  "travel",
  "receipt",
  "promo",
];

const REFRESH_INTERVAL_MS = 30_000;

// Carrier tracking URL builders
const CARRIER_URLS: Record<string, (trackingNo: string) => string> = {
  ups: (t) => `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}`,
  fedex: (t) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(t)}`,
  usps: (t) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(t)}`,
};

// ---------------------------------------------------------------------------
// Filter chip definitions
// ---------------------------------------------------------------------------

type FilterId =
  | "all"
  | "needs-attention"
  | "bills"
  | "deliveries"
  | "travel"
  | "done";

interface FilterChip {
  id: FilterId;
  label: string;
}

const FILTER_CHIPS: FilterChip[] = [
  { id: "all", label: "All" },
  { id: "needs-attention", label: "⚠️ Needs attention" },
  { id: "bills", label: "💸 Bills" },
  { id: "deliveries", label: "📦 Deliveries" },
  { id: "travel", label: "✈️ Travel" },
  { id: "done", label: "✓ Done" },
];

function matchesFilter(event: LifeEvent, filter: FilterId): boolean {
  switch (filter) {
    case "all":
      return true;
    case "needs-attention":
      return (
        event.urgency === "now" ||
        event.kind === "fraud_alert" ||
        event.kind === "bill"
      );
    case "bills":
      return event.kind === "bill";
    case "deliveries":
      return event.kind === "delivery";
    case "travel":
      return event.kind === "travel";
    case "done":
      return event.status === "undone" || event.status === "dismissed";
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Build a carrier tracking URL from event fields, or null if not enough info. */
function buildTrackingUrl(fields: Record<string, unknown>): string | null {
  const trackingNo = fields.trackingNo ?? fields.tracking_no ?? fields.trackingNumber;
  if (typeof trackingNo !== "string" || !trackingNo) return null;

  const carrier = String(
    fields.carrier ?? fields.Carrier ?? ""
  ).toLowerCase();

  const buildUrl = CARRIER_URLS[carrier];
  if (!buildUrl) {
    // Unknown carrier — link to UPS as generic fallback only if carrier key exists
    return null;
  }
  return buildUrl(trackingNo);
}

/** Extract a pay/open URL from event fields, or null. */
function buildPayUrl(fields: Record<string, unknown>): { label: string; url: string } | null {
  if (typeof fields.pay === "string" && fields.pay) return { label: "Pay", url: fields.pay };
  if (typeof fields.payUrl === "string" && fields.payUrl) return { label: "Pay", url: fields.payUrl };
  if (typeof fields.url === "string" && fields.url) return { label: "Open", url: fields.url };
  if (typeof fields.link === "string" && fields.link) return { label: "Open", url: fields.link };
  return null;
}

/** Extract a phone number for fraud callback, or null. */
function buildPhoneLink(fields: Record<string, unknown>): string | null {
  const phone = fields.phone ?? fields.callbackPhone ?? fields.callback_phone;
  if (typeof phone !== "string" || !phone) return null;
  // Normalise: strip non-digits for the tel: href
  const digits = phone.replace(/\D/g, "");
  return digits ? `tel:+${digits}` : null;
}

// ---------------------------------------------------------------------------
// Summary strip
// ---------------------------------------------------------------------------

interface SummaryItem {
  emoji: string;
  label: string;
  filterId: FilterId;
  count: number;
}

function buildSummaryItems(events: LifeEvent[]): SummaryItem[] {
  const active = events.filter(
    (e) => e.status === "suggested" || e.status === "auto_acted",
  );

  const kindCounts: Partial<Record<LifeEventKind, number>> = {};
  for (const e of active) {
    kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
  }

  const needsAttention = active.filter(
    (e) => e.urgency === "now" || e.kind === "fraud_alert" || e.kind === "bill",
  ).length;

  const items: SummaryItem[] = [];

  if (needsAttention > 0) {
    items.push({
      emoji: "⚠️",
      label: `${needsAttention} needs attention`,
      filterId: "needs-attention",
      count: needsAttention,
    });
  }

  const billCount = kindCounts.bill ?? 0;
  if (billCount > 0) {
    items.push({
      emoji: "💸",
      label: `${billCount} ${billCount === 1 ? "bill" : "bills"} due`,
      filterId: "bills",
      count: billCount,
    });
  }

  const deliveryCount = kindCounts.delivery ?? 0;
  if (deliveryCount > 0) {
    items.push({
      emoji: "📦",
      label: `${deliveryCount} ${deliveryCount === 1 ? "delivery" : "deliveries"}`,
      filterId: "deliveries",
      count: deliveryCount,
    });
  }

  const travelCount = kindCounts.travel ?? 0;
  if (travelCount > 0) {
    items.push({
      emoji: "✈️",
      label: `${travelCount} travel`,
      filterId: "travel",
      count: travelCount,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        STATUS_COLORS[status] ?? "bg-zinc-700/30 text-zinc-400",
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** Compact horizontal summary strip above the feed. */
function SummaryStrip({
  events,
  activeFilter,
  onFilterChange,
}: {
  events: LifeEvent[];
  activeFilter: FilterId;
  onFilterChange: (id: FilterId) => void;
}) {
  const items = buildSummaryItems(events);
  if (items.length === 0) return null;

  return (
    <div className="mb-4 flex flex-wrap gap-x-3 gap-y-1.5 rounded-xl border border-zinc-800 bg-surface-1 px-4 py-3">
      {items.map((item) => (
        <button
          key={item.filterId}
          onClick={() =>
            onFilterChange(
              activeFilter === item.filterId ? "all" : item.filterId,
            )
          }
          className={clsx(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
            activeFilter === item.filterId
              ? "bg-lantern-500/20 text-lantern-200"
              : "text-zinc-400 hover:text-zinc-200",
          )}
        >
          <span aria-hidden>{item.emoji}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Horizontal scrollable filter chips. */
function FilterChips({
  active,
  onChange,
}: {
  active: FilterId;
  onChange: (id: FilterId) => void;
}) {
  return (
    <div
      className="mb-4 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
      style={{ scrollbarWidth: "none" }}
    >
      {FILTER_CHIPS.map((chip) => (
        <button
          key={chip.id}
          onClick={() => onChange(chip.id)}
          className={clsx(
            "inline-flex shrink-0 items-center rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors",
            "min-h-[34px]", // large enough tap target on mobile
            active === chip.id
              ? "bg-lantern-500/20 text-lantern-200 ring-1 ring-lantern-500/40"
              : "border border-zinc-800 bg-surface-1 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
          )}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

/** Inline action links derived from event.fields. */
function InlineActions({ event }: { event: LifeEvent }) {
  const payLink = buildPayUrl(event.fields);
  const trackingUrl =
    event.kind === "delivery" ? buildTrackingUrl(event.fields) : null;
  const phoneLink =
    event.kind === "fraud_alert" ? buildPhoneLink(event.fields) : null;

  const links: React.ReactNode[] = [];

  if (payLink) {
    links.push(
      <a
        key="pay"
        href={payLink.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
      >
        <ExternalLink className="h-3 w-3" />
        {payLink.label}
      </a>,
    );
  }

  if (trackingUrl) {
    links.push(
      <a
        key="track"
        href={trackingUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
      >
        <Package className="h-3 w-3" />
        Track
      </a>,
    );
  }

  if (phoneLink) {
    links.push(
      <a
        key="call"
        href={phoneLink}
        className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
      >
        <Phone className="h-3 w-3" />
        Call back
      </a>,
    );
  }

  if (links.length === 0) return null;

  return <div className="mt-3 flex flex-wrap gap-2">{links}</div>;
}

function EventCard({
  event,
  onUndo,
  onMarkDone,
}: {
  event: LifeEvent;
  onUndo: (id: string) => void;
  onMarkDone: (id: string) => void;
}) {
  const [busy, setBusy] = useState<"undo" | "mark-done" | null>(null);
  const icon = KIND_ICONS[event.kind] ?? <Zap className="h-4 w-4" />;
  const isDone = event.status === "undone" || event.status === "dismissed";

  const handleUndo = async () => {
    setBusy("undo");
    try {
      await onUndo(event.id);
    } finally {
      setBusy(null);
    }
  };

  const handleMarkDone = async () => {
    setBusy("mark-done");
    try {
      await onMarkDone(event.id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={clsx(
        "rounded-xl border bg-surface-1 p-4 transition-opacity",
        isDone ? "border-zinc-800/60 opacity-60" : "border-zinc-800",
      )}
    >
      {/* Header row */}
      <div className="flex items-start gap-3">
        {/* Kind icon */}
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-zinc-400">
          {icon}
        </div>

        {/* Summary + meta */}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-zinc-100">
            {event.summary}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusBadge status={event.status} />
            <span className="text-[11px] text-zinc-500">
              {KIND_LABELS[event.kind] ?? event.kind}
            </span>
            <span className="text-[11px] text-zinc-600">·</span>
            <span className="text-[11px] text-zinc-500">{event.channel}</span>
            <span className="text-[11px] text-zinc-600">·</span>
            <span className="text-[11px] text-zinc-500">
              {relativeTime(event.createdAt)}
            </span>
          </div>
        </div>
      </div>

      {/* Auto-acted detail */}
      {event.status === "auto_acted" && event.actionTaken && (
        <p className="mt-2.5 rounded-lg bg-emerald-500/8 px-3 py-2 text-[12px] text-emerald-300/90">
          {event.actionTaken}
        </p>
      )}

      {/* Inline action links from fields */}
      {!isDone && <InlineActions event={event} />}

      {/* Action buttons — large tap targets for mobile */}
      {!isDone && (
        <div className="mt-3 flex gap-2">
          {event.status === "auto_acted" && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Undo2 className="h-3.5 w-3.5" />}
              loading={busy === "undo"}
              onClick={handleUndo}
              className="min-h-[36px] flex-1"
            >
              Undo
            </Button>
          )}
          {/* Mark done (suggested or auto-acted) */}
          <Button
            variant="ghost"
            size="sm"
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            loading={busy === "mark-done"}
            onClick={handleMarkDone}
            className="min-h-[36px] flex-1"
          >
            Mark done
          </Button>
        </div>
      )}
    </div>
  );
}

function PrefRow({
  pref,
  onChange,
}: {
  pref: LifeEventPref;
  onChange: (kind: LifeEventKind, mode: LifeEventMode) => void;
}) {
  const icon = KIND_ICONS[pref.kind] ?? <Zap className="h-4 w-4" />;
  const modes: LifeEventMode[] = ["auto", "ask", "off"];

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-zinc-400">
        {icon}
      </div>
      <span className="flex-1 text-sm text-zinc-200">
        {KIND_LABELS[pref.kind] ?? pref.kind}
      </span>
      {/* Segmented control — three equal buttons */}
      <div className="flex overflow-hidden rounded-lg border border-zinc-800 bg-surface-0">
        {modes.map((m) => (
          <button
            key={m}
            onClick={() => onChange(pref.kind, m)}
            className={clsx(
              "min-h-[32px] min-w-[48px] px-3 text-[12px] font-medium transition-colors",
              pref.mode === m
                ? "bg-lantern-500/20 text-lantern-300"
                : "text-zinc-500 hover:bg-surface-3/60 hover:text-zinc-300",
            )}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AutomationsPage() {
  const { success: toastSuccess, error: toastError } = useToast();

  // Feed state
  const [events, setEvents] = useState<LifeEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Active filter
  const [activeFilter, setActiveFilter] = useState<FilterId>("all");

  // Prefs state
  const [prefs, setPrefs] = useState<LifeEventPref[]>([]);
  const [loadingPrefs, setLoadingPrefs] = useState(true);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- Data fetching -------------------------------------------------------

  const fetchEvents = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoadingEvents(true);
      else setRefreshing(true);
      try {
        const items = await api.listLifeEvents({ limit: 100 });
        setEvents(items);
      } catch (err) {
        toastError(err instanceof Error ? err.message : "Failed to load automations");
      } finally {
        setLoadingEvents(false);
        setRefreshing(false);
      }
    },
    [toastError],
  );

  const fetchPrefs = useCallback(async () => {
    setLoadingPrefs(true);
    try {
      const p = await api.getLifeEventPrefs();
      setPrefs(p);
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Failed to load trust settings");
    } finally {
      setLoadingPrefs(false);
    }
  }, [toastError]);

  useEffect(() => {
    fetchEvents();
    fetchPrefs();
  }, [fetchEvents, fetchPrefs]);

  // Auto-refresh every 30 s
  useEffect(() => {
    intervalRef.current = setInterval(() => fetchEvents(true), REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchEvents]);

  // ---- Event actions -------------------------------------------------------

  const handleUndo = useCallback(
    async (id: string) => {
      try {
        await api.undoLifeEvent(id);
        setEvents((prev) =>
          prev.map((e) => (e.id === id ? { ...e, status: "undone" as const } : e)),
        );
        toastSuccess("Action undone");
      } catch (err) {
        toastError(err instanceof Error ? err.message : "Failed to undo");
      }
    },
    [toastSuccess, toastError],
  );

  /** Mark done = dismiss; optimistic update. */
  const handleMarkDone = useCallback(
    async (id: string) => {
      // Optimistic update
      setEvents((prev) =>
        prev.map((e) => (e.id === id ? { ...e, status: "dismissed" as const } : e)),
      );
      try {
        await api.dismissLifeEvent(id);
        toastSuccess("Marked as done");
      } catch (err) {
        // Revert on failure
        setEvents((prev) =>
          prev.map((e) =>
            e.id === id
              ? { ...e, status: "suggested" as const }
              : e,
          ),
        );
        toastError(err instanceof Error ? err.message : "Failed to mark done");
      }
    },
    [toastSuccess, toastError],
  );

  // ---- Pref change ---------------------------------------------------------

  const handlePrefChange = useCallback(
    async (kind: LifeEventKind, mode: LifeEventMode) => {
      // Optimistic update
      setPrefs((prev) =>
        prev.map((p) => (p.kind === kind ? { ...p, mode } : p)),
      );
      try {
        await api.setLifeEventPref({ kind, mode });
        toastSuccess(`${KIND_LABELS[kind] ?? kind} set to ${MODE_LABELS[mode]}`);
      } catch (err) {
        // Revert on error
        fetchPrefs();
        toastError(err instanceof Error ? err.message : "Failed to save setting");
      }
    },
    [toastSuccess, toastError, fetchPrefs],
  );

  // ---- Derived state -------------------------------------------------------

  const filteredEvents = events.filter((e) => matchesFilter(e, activeFilter));

  // Within the filtered view, active events first, then terminal
  const activeEvents = filteredEvents.filter(
    (e) => e.status === "suggested" || e.status === "auto_acted",
  );
  const terminalEvents = filteredEvents.filter(
    (e) => e.status === "undone" || e.status === "dismissed",
  );

  // Synthesise pref rows: if API returned fewer than all kinds, fill defaults
  const prefRows: LifeEventPref[] = PREF_KINDS.map((kind) => {
    const found = prefs.find((p) => p.kind === kind);
    return found ?? { kind, mode: "ask" as LifeEventMode };
  });

  // Determine if the current filter produced an empty result despite having events
  const isFilteredEmpty = !loadingEvents && events.length > 0 && filteredEvents.length === 0;

  // ---- Render --------------------------------------------------------------

  return (
    <div className="min-h-screen bg-surface-0">
      <PageHeader
        title="Automations"
        description="Actions your bot has taken or suggested — bills, deliveries, appointments, and more."
        action={
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            loading={refreshing}
            onClick={() => fetchEvents(true)}
          >
            Refresh
          </Button>
        }
      />

      {/* Main content — single-column, max 640 px so it reads well on iPhone */}
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-6 sm:px-6">

        {/* ── Feed ── */}
        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Recent activity
          </h2>

          {loadingEvents ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <EmptyState
              icon={Zap}
              title="No automations yet"
              description="They'll appear here as your bot handles deliveries, bills, and more."
              size="compact"
            />
          ) : (
            <>
              {/* Summary strip — tap a stat to filter */}
              <SummaryStrip
                events={events}
                activeFilter={activeFilter}
                onFilterChange={setActiveFilter}
              />

              {/* Filter chips — horizontal scroll on mobile */}
              <FilterChips active={activeFilter} onChange={setActiveFilter} />

              {isFilteredEmpty ? (
                <EmptyState
                  icon={Zap}
                  title="Nothing here"
                  description="No events match this filter. Try All to see everything."
                  size="compact"
                  actionLabel="Show all"
                  onAction={() => setActiveFilter("all")}
                />
              ) : (
                <div className="space-y-3">
                  {activeEvents.map((e) => (
                    <EventCard
                      key={e.id}
                      event={e}
                      onUndo={handleUndo}
                      onMarkDone={handleMarkDone}
                    />
                  ))}

                  {terminalEvents.length > 0 && (
                    <>
                      {activeEvents.length > 0 && (
                        <div className="pt-1 pb-1">
                          <p className="text-xs font-medium text-zinc-600">Earlier</p>
                        </div>
                      )}
                      {terminalEvents.map((e) => (
                        <EventCard
                          key={e.id}
                          event={e}
                          onUndo={handleUndo}
                          onMarkDone={handleMarkDone}
                        />
                      ))}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {/* ── Trust toggles ── */}
        <section>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Trust settings
          </h2>
          <p className="mb-3 text-[12px] text-zinc-500">
            Choose how much the bot does automatically for each category.
          </p>

          <div className="rounded-xl border border-zinc-800 bg-surface-1 px-4 divide-y divide-zinc-800/60">
            {loadingPrefs ? (
              <div className="space-y-3 py-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 rounded-lg" />
                ))}
              </div>
            ) : (
              prefRows.map((pref) => (
                <PrefRow
                  key={pref.kind}
                  pref={pref}
                  onChange={handlePrefChange}
                />
              ))
            )}
          </div>

          <p className="mt-3 text-[11px] text-zinc-600">
            <strong className="text-zinc-500">Auto</strong> — bot acts immediately.{" "}
            <strong className="text-zinc-500">Ask</strong> — bot suggests, you approve.{" "}
            <strong className="text-zinc-500">Off</strong> — bot ignores this category.
          </p>
        </section>
      </div>
    </div>
  );
}
