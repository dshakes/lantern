"use client";

// Agent setup gate. Lives at /agents/{name}/setup.
//
// Why this page exists: templates (Morning Brief, Inbox Concierge, …) create
// an agent whose system prompt references connectors. If those connectors
// aren't wired before Run, the model babbles "no connectors provided." This
// page reads the agent's required-connectors / required-surfaces (written
// into labels JSONB by the backend Apply handler) and renders an inline
// checklist with one-click links to /connectors and /surfaces.
//
// The agent detail page also calls the same /v1/agents/{name}/setup endpoint
// to gate the Run button. Single source of truth.

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Circle,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import clsx from "clsx";

import { api } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Button, LinkButton } from "@/components/button";

interface Status {
  templateId: string;
  required: { connectors: string[]; surfaces: string[] };
  installed: { connectors: string[]; surfaces: string[] };
  missing: { connectors: string[]; surfaces: string[] };
  ready: boolean;
  nextSteps: Array<{ kind: string; id: string; label: string; href: string }>;
}

interface PageProps {
  params: Promise<{ name: string }>;
}

// Friendly display name for known connector / surface IDs. Anything not in
// this map renders the raw ID, which is acceptable for power users.
const PRETTY: Record<string, string> = {
  github: "GitHub",
  linear: "Linear",
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
  notion: "Notion",
  slack: "Slack",
  stripe: "Stripe",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
  email: "Email",
  webchat: "Web chat",
};

function pretty(id: string): string {
  return PRETTY[id] ?? id;
}

export default function AgentSetupPage({ params }: PageProps) {
  const { name } = use(params);
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getAgentSetupStatus(name);
      setStatus(s as Status);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load setup status");
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Soft poll while items are still missing — the user is about to click
  // through to /connectors and come back; we want the green check to appear
  // without a manual refresh. Stop polling once ready.
  useEffect(() => {
    if (!status || status.ready) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [status, refresh]);

  if (loading) {
    return (
      <div className="flex flex-1 flex-col overflow-auto">
        <PageHeader title="Setup" description="Loading…" />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-600" />
        </div>
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="flex flex-1 flex-col overflow-auto">
        <PageHeader title="Setup" description={error ?? "Unable to load status"} />
        <div className="mx-auto mt-8 w-full max-w-2xl px-6">
          <Button onClick={refresh} icon={<RefreshCw className="h-3.5 w-3.5" />}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const items: Array<{
    id: string;
    label: string;
    done: boolean;
    href: string;
    kind: "connector" | "surface";
  }> = [
    ...status.required.connectors.map((c) => ({
      id: c,
      kind: "connector" as const,
      label: pretty(c),
      done: status.installed.connectors.includes(c),
      // Deep-link: /connectors auto-opens the matching install modal when
      // ?install=<id> is present (see connectors page useEffect).
      href: `/connectors?install=${encodeURIComponent(c)}`,
    })),
    ...status.required.surfaces.map((s) => ({
      id: s,
      kind: "surface" as const,
      label: pretty(s),
      done: status.installed.surfaces.includes(s),
      href: `/surfaces?setup=${encodeURIComponent(s)}`,
    })),
  ];

  const doneCount = items.filter((i) => i.done).length;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title={`Set up ${name}`}
        description="Connect the tools and channels this agent needs before its first run."
        badge={
          status.ready ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
              <CheckCircle2 className="h-3 w-3" />
              Ready
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
              {doneCount} / {items.length} done
            </span>
          )
        }
        action={
          status.ready ? (
            <LinkButton
              href={`/agents/${encodeURIComponent(name)}`}
              variant="primary"
              icon={<Sparkles className="h-3.5 w-3.5" />}
            >
              Open agent
            </LinkButton>
          ) : (
            <Button
              variant="ghost"
              onClick={refresh}
              icon={<RefreshCw className="h-3.5 w-3.5" />}
            >
              Refresh
            </Button>
          )
        }
      />

      <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-8">
        {/* Progress bar */}
        <div className="mb-6 h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-emerald-400 transition-all duration-300"
            style={{
              width: items.length === 0 ? "100%" : `${(doneCount / items.length) * 100}%`,
            }}
          />
        </div>

        {items.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-surface-1 px-6 py-8 text-center">
            <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-emerald-400" />
            <p className="text-sm text-zinc-300">No setup required — you can run this agent now.</p>
            <LinkButton
              href={`/agents/${encodeURIComponent(name)}`}
              variant="primary"
              className="mt-4"
            >
              Open agent
            </LinkButton>
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                <Link
                  href={item.href}
                  className={clsx(
                    "flex items-center justify-between rounded-xl border px-4 py-3 transition-colors",
                    item.done
                      ? "border-emerald-500/20 bg-emerald-500/5"
                      : "border-zinc-800 bg-surface-1 hover:border-zinc-700 hover:bg-surface-2",
                  )}
                >
                  <div className="flex items-center gap-3">
                    {item.done ? (
                      <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
                    ) : (
                      <Circle className="h-5 w-5 shrink-0 text-zinc-600" />
                    )}
                    <div>
                      <p
                        className={clsx(
                          "text-sm font-medium",
                          item.done ? "text-emerald-300 line-through decoration-emerald-500/40" : "text-zinc-200",
                        )}
                      >
                        {item.done ? `Connected ${item.label}` : `Connect ${item.label}`}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {item.kind === "connector"
                          ? "Tool the agent will call to get data"
                          : "Channel the agent will send messages on"}
                      </p>
                    </div>
                  </div>
                  {!item.done && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-lantern-400">
                      Go <ChevronRight className="h-3.5 w-3.5" />
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* Hint footer */}
        <p className="mt-8 text-xs text-zinc-500">
          Items refresh automatically once connected — you can leave this tab
          open while you wire things up in another window.
        </p>
      </div>
    </div>
  );
}
