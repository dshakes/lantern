// digest-compose.ts — narrative daily-brief composer.
//
// Two paths:
//   LLM:   owner-voice system prompt + structured data → 3-6 line brief.
//   Det.:  deterministic prioritized template (always available as fallback).
//
// The LLM path is used when opts.llmCompose is provided AND
// LANTERN_DIGEST_NARRATIVE !== "0" (default ON). Any error → deterministic.
//
// ponytail: pure functions; no I/O; deterministic path is the guarantee.

import type { DigestData } from "./daily-digest.js";

export interface ComposeOpts {
  /**
   * Optional LLM synthesizer: (systemPrompt, userPrompt) → brief string or null.
   * The caller passes `agent.respondTo('digest::compose', user, sys, ...)`.
   * Returning null or throwing → deterministic fallback.
   */
  llmCompose?: (systemPrompt: string, userPrompt: string) => Promise<string | null>;
}

// ── scored-item model ─────────────────────────────────────────────────────────

interface ScoredItem {
  score: number;
  line: string;
  action?: string; // optional one-click coda hint
}

function buildScoredItems(data: DigestData, now: number): ScoredItem[] {
  const items: ScoredItem[] = [];

  // commitments (urgent first)
  for (const c of (data.commitments ?? []).slice(0, 3)) {
    const from = c.assignedBy ? ` (from ${c.assignedBy})` : "";
    const urg = c.urgency;
    const score = urg === "now" ? 90 : urg === "soon" ? 70 : 50;
    const prefix = urg === "now" ? "🔴 " : urg === "soon" ? "⚡ " : "";
    items.push({
      score,
      line: `${prefix}${c.title}${from}`,
      action: `reply *research* to plan it out`,
    });
  }

  // escalations
  if (data.escalations > 0) {
    items.push({
      score: 85,
      line: `🚨 ${data.escalations} escalation${data.escalations === 1 ? "" : "s"} — check email`,
    });
  }

  // life-events (money/bills get higher priority)
  for (const ev of (data.lifeEvents ?? []).slice(0, 3)) {
    const hasMoney = /\$|bill|due|payment|charge|refund/i.test(ev);
    items.push({ score: hasMoney ? 80 : 60, line: ev });
  }

  // overdue contacts (top 2)
  for (const oc of (data.overdueContacts ?? []).slice(0, 2)) {
    const name = oc.displayName || "someone";
    const days = Math.max(1, Math.round(oc.daysOverdue));
    items.push({
      score: 65,
      line: `${name} still waiting (${days}d)`,
      action: `reply *draft to ${name}* to handle it`,
    });
  }

  // VIP drafts
  if (data.drafts && data.drafts.count > 0) {
    const sample = data.drafts.sample ? ` (${data.drafts.sample})` : "";
    items.push({
      score: 55,
      line: `👑 ${data.drafts.count} VIP draft${data.drafts.count === 1 ? "" : "s"} waiting${sample}`,
    });
  }

  // next calendar event
  if (data.nextEvent) {
    items.push({ score: 50, line: `next: ${data.nextEvent}` });
  }

  // sleep warning (only when short — no noise when ok)
  if (typeof data.sleepHours === "number" && data.sleepHours < 6) {
    const h = Math.round(data.sleepHours * 10) / 10;
    items.push({ score: 40, line: `slept ~${h}h last night` });
  }

  // ops stats (low priority; omit zeros)
  if (data.repliesSent > 0) {
    items.push({
      score: 20,
      line: `${data.repliesSent} auto-${data.repliesSent === 1 ? "reply" : "replies"} sent overnight`,
    });
  }
  if (data.pausedContacts.length > 0) {
    const top = data.pausedContacts.slice(0, 2).map((c) => {
      const mins = Math.max(0, Math.round((c.resumesAtMs - now) / 60_000));
      return `${c.label} (${mins < 60 ? mins + "m" : Math.round(mins / 60) + "h"})`;
    });
    items.push({ score: 15, line: `${data.pausedContacts.length} paused: ${top.join(", ")}` });
  }

  return items.sort((a, b) => b.score - a.score);
}

// ── deterministic path ────────────────────────────────────────────────────────

function deterministicNarrative(data: DigestData): string {
  const now = Date.now();
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const items = buildScoredItems(data, now);

  if (items.length === 0) {
    return `*${dateStr.toLowerCase()}* — quiet night, nothing urgent.\n\nreply *help* anytime.`;
  }

  const body = items
    .slice(0, 5)
    .map((i) => `• ${i.line}`)
    .join("\n");

  // Collect up to 2 one-click action hints from top-scored items.
  const actions = items
    .filter((i) => i.action)
    .slice(0, 2)
    .map((i) => `→ ${i.action}`);

  const coda = actions.length > 0 ? `\n${actions.join("\n")}` : "";

  return `*${dateStr.toLowerCase()}*\n${body}${coda}`;
}

// ── LLM path ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(data: DigestData): string {
  const voice = data.ownerVoiceBlock?.trim() ?? "";
  return [
    "You are writing the owner's morning brief TO HIMSELF — like a sticky note he left himself.",
    "Rules: 3-6 lines max. No preamble, no greeting. Lowercase is fine. Terse. Lead with what matters MOST (urgent task / money / overdue VIP first). End with 1-2 one-tap action hints. Omit sections that have nothing to report. NEVER state anything not present in the data.",
    voice,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildUserPrompt(data: DigestData): string {
  const now = Date.now();
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const lines = [`Morning brief data — ${dateStr}:`];

  const tasks = data.commitments ?? [];
  if (tasks.length > 0) {
    lines.push(
      `tasks: ${tasks
        .slice(0, 3)
        .map(
          (c) =>
            `"${c.title}"${c.urgency === "now" ? " [URGENT]" : c.urgency === "soon" ? " [today]" : ""}${c.assignedBy ? ` from ${c.assignedBy}` : ""}`,
        )
        .join(", ")}`,
    );
  }
  if (data.escalations > 0) lines.push(`escalations: ${data.escalations}`);
  if ((data.lifeEvents ?? []).length > 0)
    lines.push(`life-events: ${(data.lifeEvents ?? []).join(" | ")}`);
  if ((data.overdueContacts ?? []).length > 0) {
    lines.push(
      `overdue contacts: ${(data.overdueContacts ?? [])
        .map((c) => `${c.displayName || "someone"} (${Math.max(1, Math.round(c.daysOverdue))}d)`)
        .join(", ")}`,
    );
  }
  if (data.drafts && data.drafts.count > 0) {
    lines.push(
      `VIP drafts: ${data.drafts.count}${data.drafts.sample ? ` (${data.drafts.sample})` : ""}`,
    );
  }
  if (data.nextEvent) lines.push(`next event: ${data.nextEvent}`);
  if (typeof data.sleepHours === "number") {
    lines.push(`sleep: ${Math.round(data.sleepHours * 10) / 10}h`);
  }
  if (data.repliesSent > 0) lines.push(`auto-replies sent: ${data.repliesSent}`);
  if (data.pausedContacts.length > 0) {
    lines.push(
      `paused contacts: ${data.pausedContacts
        .slice(0, 3)
        .map((c) => {
          const mins = Math.max(0, Math.round((c.resumesAtMs - now) / 60_000));
          return `${c.label} (${mins < 60 ? mins + "m" : Math.round(mins / 60) + "h"})`;
        })
        .join(", ")}`,
    );
  }

  return lines.join("\n");
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Compose a narrative morning brief for the owner.
 *
 * When `opts.llmCompose` is provided and `LANTERN_DIGEST_NARRATIVE !== "0"`,
 * tries the LLM path first; falls back to deterministic on null / error.
 * The deterministic path is always correct and available.
 */
export async function composeDigestNarrative(
  data: DigestData,
  opts?: ComposeOpts,
): Promise<string> {
  const narrativeEnabled = process.env.LANTERN_DIGEST_NARRATIVE !== "0";

  if (narrativeEnabled && opts?.llmCompose) {
    try {
      const reply = await opts.llmCompose(buildSystemPrompt(data), buildUserPrompt(data));
      if (reply && reply.trim().length > 10) return reply.trim();
    } catch {
      // fall through to deterministic
    }
  }

  return deterministicNarrative(data);
}
