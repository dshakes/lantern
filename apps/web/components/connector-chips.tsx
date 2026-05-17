"use client";

// ConnectorChips — context-aware install-status chips that appear
// beneath the agent-create description textarea.
//
// As the user types ("Reply to my Gmail and post to Slack…"), we
// detect referenced connectors and show whether each is already
// installed at the workspace level (since Lantern connectors are
// tenant-wide — install once, every agent uses them).
//
// Click an uninstalled chip to jump straight to /connectors with
// that connector pre-selected. The draft description is kept in
// localStorage so the user can come back without retyping.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Plus, Loader2 } from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";

// Each entry maps a connector id to the keywords that surface it.
// Keywords are matched as whole-word substrings (case-insensitive).
// Adding a new connector means appending one row here.
const CONNECTOR_DETECTORS: Array<{
  id: string;
  label: string;
  keywords: RegExp;
}> = [
  { id: "gmail", label: "Gmail", keywords: /\b(gmail|email|inbox|mail)\b/i },
  { id: "github", label: "GitHub", keywords: /\b(github|gh|pull request|prs?|issues?)\b/i },
  { id: "slack", label: "Slack", keywords: /\bslack\b/i },
  { id: "linear", label: "Linear", keywords: /\b(linear|ticket|sprint)\b/i },
  { id: "notion", label: "Notion", keywords: /\b(notion|page|doc)\b/i },
  { id: "google-calendar", label: "Calendar", keywords: /\b(calendar|gcal|meeting)\b/i },
  { id: "google-drive", label: "Drive", keywords: /\b(drive|google docs|file)\b/i },
  { id: "stripe", label: "Stripe", keywords: /\b(stripe|invoice|charge|subscription)\b/i },
  { id: "telegram", label: "Telegram", keywords: /\btelegram\b/i },
  { id: "discord", label: "Discord", keywords: /\bdiscord\b/i },
  { id: "twilio", label: "Twilio (SMS)", keywords: /\b(twilio|sms|text message)\b/i },
  { id: "jira", label: "Jira", keywords: /\bjira\b/i },
  { id: "hubspot", label: "HubSpot", keywords: /\bhubspot\b/i },
  { id: "sentry", label: "Sentry", keywords: /\b(sentry|error)\b/i },
  // Special: WhatsApp is a SURFACE (the bridge), not an installable
  // connector — link to its pairing page instead of /connectors.
  { id: "whatsapp", label: "WhatsApp", keywords: /\bwhatsapp\b/i },
];

export function ConnectorChips({ description }: { description: string }) {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listConnectors()
      .then((c) => {
        if (cancelled) return;
        const set = new Set<string>();
        for (const ci of c as Array<{ connectorId: string }>) {
          if (ci?.connectorId) set.add(ci.connectorId);
        }
        setInstalled(set);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const detected = useMemo(() => {
    if (!description) return [];
    return CONNECTOR_DETECTORS.filter((d) => d.keywords.test(description));
  }, [description]);

  if (detected.length === 0) return null;

  return (
    <div className="rounded-(--radius-md) border border-zinc-800/60 bg-surface-1/50 p-3">
      <p className="mb-2 text-(--text-xs) text-zinc-500">
        Detected references — these connect once at the workspace level, every agent can use them:
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {detected.map((d) => {
          const isWhatsApp = d.id === "whatsapp";
          const ok = isWhatsApp
            // WhatsApp's "installed" signal is whether a paired session
            // exists — we don't fetch that here for simplicity; the chip
            // just links to the pairing flow.
            ? false
            : installed.has(d.id);
          const href = isWhatsApp
            ? "/surfaces"
            : `/connectors?install=${encodeURIComponent(d.id)}`;
          return (
            <Link
              key={d.id}
              href={href}
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-(--text-xs) font-medium transition-colors duration-(--motion-fast)",
                ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15"
                  : "border-zinc-700 bg-surface-2 text-zinc-300 hover:border-lantern-500/40 hover:bg-lantern-500/5 hover:text-lantern-200"
              )}
              title={ok ? "Already installed at the workspace level" : `Click to install ${d.label}`}
            >
              {!loaded ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : ok ? (
                <Check className="h-3 w-3" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              {d.label}
              {ok && <span className="text-emerald-400/70">installed</span>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
