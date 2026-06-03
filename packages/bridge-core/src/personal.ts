// Client for the control-plane's WhatsApp personal-assistant
// endpoints: VIP contacts, contact facts (memory), pending drafts.
// All requests go through authedFetch so they're authenticated as
// the bridge's service principal.

import { authedFetch } from "./auth.js";
import type { Logger } from "pino";

interface VIPEntry { jid: string; displayName: string }
interface Fact { id: string; content: string; source: string; updatedAt: string }

// Response shape of GET /v1/memory/context — the unified person view.
interface UnifiedTimelineEvent {
  channel: string;
  kind: string;
  direction: string;
  content: string;
  occurredAt: string;
}
interface UnifiedContext {
  personId: string;
  displayName?: string;
  relationship?: string;
  handles?: { channel: string; handle: string }[];
  facts?: string[];
  events?: UnifiedTimelineEvent[];
  // Optional recency-ordered slice scoped to the requested windowDays. When
  // the control-plane exposes it we use it directly; otherwise unifiedBlock
  // derives the recent slice from `events` by filtering on occurredAt.
  recent?: UnifiedTimelineEvent[];
  windowDays?: number;
}

// Detect an owner "teach the bot a fact about this contact" instruction
// typed in a contact's own thread: "remember she's vegetarian",
// "note that he just had a baby", "fyi they're moving to Austin",
// "keep in mind her birthday is june 3". Returns the cleaned fact text
// (the part after the lead phrase) or null when it's not a remember cmd.
//
// Deliberately requires a clear lead phrase so normal conversation
// ("I'll remember to call you") doesn't get captured as a fact.
const REMEMBER_LEAD =
  /^\s*(?:remember(?:\s+that)?|note(?:\s+that)?|fyi[,:]?|keep in mind(?:\s+that)?|don'?t forget(?:\s+that)?)\b[:,]?\s*(.+?)\s*$/i;

export function parseRememberCommand(text: string): string | null {
  const t = (text || "").trim();
  if (t.length < 5 || t.length > 400) return null;
  const m = t.match(REMEMBER_LEAD);
  if (!m) return null;
  const fact = m[1].trim();
  // Guard against "remember to <do something>" — that's a self-reminder/
  // task, not a fact ABOUT the contact.
  if (/^to\s+/i.test(fact)) return null;
  return fact.length >= 2 ? fact : null;
}

export class PersonalClient {
  private logger: Logger;
  // Cache VIP list for 30s — checked on every inbound; don't hammer
  // the control-plane.
  private vipCache: { jids: Set<string>; fetchedAt: number } = { jids: new Set(), fetchedAt: 0 };
  private static readonly VIP_TTL_MS = 30_000;

  // Facts cache, keyed by jid. Short TTL because facts are read on
  // every inbound for that contact.
  private factsCache: Map<string, { facts: Fact[]; fetchedAt: number }> = new Map();
  private static readonly FACTS_TTL_MS = 60_000;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "personal" });
  }

  // Returns the set of VIP JIDs for this tenant.
  async isVIP(jid: string): Promise<boolean> {
    await this.refreshVIPsIfStale();
    return this.vipCache.jids.has(jid);
  }

  private async refreshVIPsIfStale(): Promise<void> {
    if (Date.now() - this.vipCache.fetchedAt < PersonalClient.VIP_TTL_MS) return;
    try {
      const res = await authedFetch("/v1/whatsapp/vips");
      if (!res.ok) {
        this.vipCache.fetchedAt = Date.now();
        return;
      }
      const data = (await res.json()) as { vips?: VIPEntry[] };
      this.vipCache = {
        jids: new Set((data.vips ?? []).map((v) => v.jid)),
        fetchedAt: Date.now(),
      };
    } catch (err) {
      this.logger.warn({ err }, "VIP list fetch failed");
    }
  }

  // Fetch facts for a contact, cached briefly.
  async factsFor(jid: string): Promise<Fact[]> {
    const hit = this.factsCache.get(jid);
    if (hit && Date.now() - hit.fetchedAt < PersonalClient.FACTS_TTL_MS) return hit.facts;
    try {
      const res = await authedFetch(`/v1/whatsapp/facts?jid=${encodeURIComponent(jid)}`);
      if (!res.ok) {
        this.factsCache.set(jid, { facts: [], fetchedAt: Date.now() });
        return [];
      }
      const data = (await res.json()) as { facts?: Fact[] };
      const facts = data.facts ?? [];
      this.factsCache.set(jid, { facts, fetchedAt: Date.now() });
      return facts;
    } catch (err) {
      this.logger.warn({ err, jid }, "facts fetch failed");
      return [];
    }
  }

  // Save a fact the owner taught the bot about a contact ("remember she's
  // vegetarian"). Persists server-side (whatsapp_contact_facts) so it
  // survives restarts and feeds factsBlock on every future reply.
  // Invalidates the local cache so the new fact is visible immediately.
  //
  // `source` tags origin for dashboard transparency:
  //   - "owner-remember" (explicit "remember X" command — default)
  //   - "auto-extract"   (proactive memory pattern extractor)
  //   - "user-edit"      (dashboard manual add)
  async addFact(jid: string, content: string, source: string = "owner-remember"): Promise<boolean> {
    const c = content.trim();
    if (!jid || !c) return false;

    // Auto-extracted facts: dedupe against existing facts for the
    // SAME contact so we don't spam the store with near-duplicates
    // ("works at stripe" then "works at Stripe Inc"). Owner-remember
    // facts skip dedup so the user can always force-save.
    if (source === "auto-extract") {
      try {
        const existing = await this.factsFor(jid);
        const { factsAreSimilar } = await import("./fact-extractor.js");
        for (const f of existing) {
          if (factsAreSimilar(f.content, c)) {
            // Don't log fact content (PII) — counts/lengths only.
            this.logger.debug({ jid, existingLen: f.content.length, candidateLen: c.length }, "auto-fact deduped against existing");
            return false;
          }
        }
      } catch { /* if dedup fails, fall through and save */ }
    }

    try {
      const res = await authedFetch(`/v1/whatsapp/facts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jid, content: c, source }),
      });
      if (!res.ok) {
        this.logger.warn({ jid, status: res.status, source }, "addFact failed");
        return false;
      }
      this.factsCache.delete(jid); // force refetch incl. the new fact
      return true;
    } catch (err) {
      this.logger.warn({ err, jid, source }, "addFact errored");
      return false;
    }
  }

  // Build a one-block markdown snippet to inject into the persona
  // prompt. Returns empty string when no facts exist.
  async factsBlock(jid: string): Promise<string> {
    const facts = await this.factsFor(jid);
    if (facts.length === 0) return "";
    const top = facts.slice(0, 10).map((f) => `- ${f.content}`).join("\n");
    return `\n\nThings you know about this contact (use these when relevant — do not recite them verbatim):\n${top}`;
  }

  // ── Identity graph + unified cross-channel memory ──────────────────
  // These power the "context memory across channels" goal: a contact is
  // ONE person regardless of whether they reach you on WhatsApp, iMessage,
  // SMS, a call, or email — and their facts + timeline are unified.

  private contextCache: Map<string, { ctx: UnifiedContext | null; fetchedAt: number }> = new Map();
  private static readonly CONTEXT_TTL_MS = 60_000;

  // Fetch the unified context (facts + cross-channel timeline) for the
  // person behind a (channel, handle). When `query` is given the timeline
  // is ranked by semantic similarity (vector recall) instead of recency —
  // so a reply pulls the MOST RELEVANT memories, not just the newest.
  // `windowDays` (optional) asks the control-plane to additionally return a
  // recency-ordered slice limited to the last N days, so a reply can inject
  // "what we discussed recently" by default. When the control-plane doesn't
  // yet honor windowDays it simply ignores the param — safe either way.
  // Cached briefly only for the no-query case (per-message queries are
  // unique, so caching them is pointless). Never throws.
  async unifiedContext(
    channel: string,
    handle: string,
    query?: string,
    opts: { windowDays?: number } = {},
  ): Promise<UnifiedContext | null> {
    const q = (query || "").trim();
    const win = opts.windowDays && opts.windowDays > 0 ? Math.floor(opts.windowDays) : 0;
    // Cache key folds in windowDays so a windowed and an unwindowed read of
    // the same person don't clobber each other.
    const key = `${channel}:${handle}:w${win}`;
    if (!q) {
      const hit = this.contextCache.get(key);
      if (hit && Date.now() - hit.fetchedAt < PersonalClient.CONTEXT_TTL_MS) return hit.ctx;
    }
    try {
      let qs = `channel=${encodeURIComponent(channel)}&handle=${encodeURIComponent(handle)}&limit=12`;
      if (q) qs += `&q=${encodeURIComponent(q.slice(0, 400))}`;
      if (win) qs += `&windowDays=${win}`;
      const res = await authedFetch(`/v1/memory/context?${qs}`);
      if (!res.ok) {
        if (!q) this.contextCache.set(key, { ctx: null, fetchedAt: Date.now() });
        return null;
      }
      const ctx = (await res.json()) as UnifiedContext;
      if (!q) this.contextCache.set(key, { ctx, fetchedAt: Date.now() });
      return ctx;
    } catch (err) {
      this.logger.debug({ err, channel, handle }, "unified context fetch failed");
      return null;
    }
  }

  // Record a timeline event (inbound/outbound message, call, email, etc.)
  // against the person behind (channel, handle). Fire-and-forget; a memory
  // write must NEVER block or break a reply.
  async ingestEvent(
    channel: string,
    handle: string,
    kind: string,
    direction: "in" | "out" | "",
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const c = (content || "").trim();
    if (!handle || !c) return;
    try {
      await authedFetch(`/v1/memory/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, handle, kind, direction, content: c.slice(0, 4000), metadata }),
      });
      this.contextCache.delete(`${channel}:${handle}`); // surface the new event next read
    } catch (err) {
      this.logger.debug({ err, channel, handle }, "memory event ingest failed");
    }
  }

  // Default lookback for the "what we discussed recently" timeline slice.
  private static readonly DEFAULT_WINDOW_DAYS = 14;

  // Persona-prompt block built from the UNIFIED person view: facts learned
  // on ANY channel + a recent time-windowed timeline + a cross-channel
  // slice. Falls back to the per-jid factsBlock when the identity graph is
  // unreachable, so this is always safe to call in place of factsBlock.
  //
  // `inboundText` doubles as the semantic-recall query (most-relevant
  // memories) AND triggers the recent-window request so the reply can ground
  // in "what we discussed recently" by default.
  async unifiedBlock(
    channel: string,
    handle: string,
    inboundText?: string,
    opts: { windowDays?: number } = {},
  ): Promise<string> {
    const windowDays = opts.windowDays ?? PersonalClient.DEFAULT_WINDOW_DAYS;
    const ctx = await this.unifiedContext(channel, handle, inboundText, { windowDays });
    if (!ctx) return this.factsBlock(handle);

    let block = "";
    const facts = (ctx.facts ?? []).slice(0, 10);
    if (facts.length > 0) {
      block += `\n\nThings you know about this contact across all channels (use when relevant — don't recite verbatim):\n` +
        facts.map((f) => `- ${f}`).join("\n");
    }

    // Recent time-windowed slice — "what we discussed recently" across ALL
    // channels. Prefer the control-plane's `recent` field; if it isn't
    // exposed yet, derive it from `events` by filtering on occurredAt so the
    // behavior is identical regardless of which side computes the window.
    const cutoff = Date.now() - windowDays * 86_400_000;
    const recentSrc = (ctx.recent ?? ctx.events ?? []).filter((e) => {
      const t = Date.parse(e.occurredAt || "");
      return Number.isNaN(t) ? true : t >= cutoff;
    });
    const recent = recentSrc.slice(0, 6);
    if (recent.length > 0) {
      block += `\n\nWhat you discussed recently (last ${windowDays} days, across all channels):\n` +
        recent.map((e) => {
          const who = e.direction === "out" ? "you" : "them";
          const ch = e.channel && e.channel !== channel ? ` on ${e.channel}` : "";
          return `- [${fmtDate(e.occurredAt)}] ${who}${ch}: ${(e.content || "").slice(0, 140)}`;
        }).join("\n");
    }

    // Recent timeline from OTHER channels — the current thread is already
    // in the live transcript, so the value-add is what happened elsewhere.
    const other = (ctx.events ?? [])
      .filter((e) => e.channel && e.channel !== channel)
      .slice(0, 6);
    if (other.length > 0) {
      block += `\n\nRecent across your other channels with them:\n` +
        other.map((e) => {
          const who = e.direction === "out" ? "you" : "them";
          return `- [${e.channel}] ${who}: ${(e.content || "").slice(0, 140)}`;
        }).join("\n");
    }
    return block;
  }

  // Post a draft for human approval. Bridge calls this for VIPs
  // instead of sending the draft directly.
  //
  // Multi-channel approval push: the moment a draft is queued, the
  // user gets pinged on every configured fallback channel so they
  // don't miss the approval (silence-by-default is unacceptable when
  // a VIP is waiting). Channels:
  //   1. Email via Gmail connector — body includes inbound + draft
  //   2. Self-chat on the OTHER bridge (if reachable) — e.g. when
  //      the WhatsApp bridge queues a draft, it DMs the user via
  //      iMessage and vice versa
  //   3. The dashboard already shows pending drafts in real time —
  //      that's the primary channel when the user IS at the computer
  //
  // All notifications are fire-and-forget; failure here NEVER blocks
  // the queue itself.
  async queueDraft(
    jid: string,
    displayName: string | undefined,
    inboundText: string,
    draftText: string,
    opts: {
      // Which channel this draft is from ("whatsapp" | "imessage").
      // Used in the notification body so the user knows where to
      // approve.
      channel?: string;
      // URL to deep-link from email/cross-channel notifications.
      // Defaults to LANTERN_DASHBOARD_URL or http://localhost:3001
      dashboardUrl?: string;
    } = {},
  ): Promise<{ id: string } | null> {
    let queueResult: { id: string } | null = null;
    try {
      const res = await authedFetch("/v1/whatsapp/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jid,
          displayName: displayName ?? "",
          inboundText,
          draftText,
          channel: opts.channel ?? "whatsapp",
        }),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status, jid }, "draft queue failed");
        return null;
      }
      queueResult = (await res.json()) as { id: string };
    } catch (err) {
      this.logger.warn({ err, jid }, "draft queue exception");
      return null;
    }

    // Fan out approval notifications. We fire all three (email,
    // cross-channel, dashboard WS) and don't block on any of them —
    // the user gets whichever reach them first.
    void this.notifyVipDraft(jid, displayName, inboundText, draftText, queueResult.id, opts);
    return queueResult;
  }

  private async notifyVipDraft(
    jid: string,
    displayName: string | undefined,
    inboundText: string,
    draftText: string,
    draftId: string,
    opts: { channel?: string; dashboardUrl?: string },
  ): Promise<void> {
    const senderLabel = displayName || prettyContact(jid);
    const channelLabel = opts.channel === "imessage" ? "iMessage" : "WhatsApp";
    const dashboardUrl =
      opts.dashboardUrl ||
      process.env.LANTERN_DASHBOARD_URL ||
      "http://localhost:3001";
    const draftsUrl = `${dashboardUrl.replace(/\/$/, "")}/personal/drafts`;

    // (1) Email — only if LANTERN_OWNER_EMAIL is set. Body has the
    // inbound + draft + a tap-target link to the dashboard.
    const ownerEmail = process.env.LANTERN_OWNER_EMAIL;
    if (ownerEmail) {
      const subject = `Lantern VIP draft: ${senderLabel}`;
      const body = [
        `${channelLabel} VIP — draft awaits your approval`,
        "",
        `From: ${senderLabel}`,
        "",
        "They wrote:",
        `> ${inboundText.replace(/\n/g, "\n> ")}`,
        "",
        "Lantern drafted:",
        `> ${draftText.replace(/\n/g, "\n> ")}`,
        "",
        `Approve / edit / discard at ${draftsUrl}`,
        "",
        `(draft id: ${draftId})`,
      ].join("\n");
      try {
        await authedFetch(`/v1/connectors/gmail/execute?action=send_message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: ownerEmail,
            subject,
            body,
            label: "lantern",
            // Drafts are time-sensitive — leave them IN inbox (not
            // skip-inbox like status mail) so they grab attention.
            skipInbox: false,
          }),
        });
      } catch (err) {
        this.logger.warn({ err, draftId }, "VIP draft email notification failed");
      }
    }

    // (2) Cross-channel self-chat ping. Only fires when the user has
    // BOTH bridges paired AND the other one is reachable. We hit the
    // /send-self endpoint on the opposite bridge; if it's down we
    // silently skip — email + dashboard are the primary channels.
    const otherChannel = opts.channel === "whatsapp" ? "imessage" : "whatsapp";
    const otherBridgeUrl = otherChannel === "whatsapp"
      ? (process.env.LANTERN_BRIDGE_URL || "http://localhost:3100")
      : (process.env.LANTERN_IMESSAGE_BRIDGE_URL || "http://localhost:3200");
    const tenantId = process.env.LANTERN_DEFAULT_TENANT_ID || "00000000-0000-0000-0000-000000000001";
    const crossText = [
      `📨 VIP draft from ${senderLabel} (on ${channelLabel})`,
      ``,
      `they: ${inboundText.slice(0, 200)}`,
      `draft: ${draftText.slice(0, 200)}`,
      ``,
      `approve: ${draftsUrl}`,
    ].join("\n");
    try {
      // Short timeout — if the other bridge is offline, fail fast and
      // don't block the rest of the notification fan-out.
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3000);
      await fetch(`${otherBridgeUrl}/session/${tenantId}/send-self`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: crossText }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
    } catch (err) {
      // Expected when the other channel isn't set up. Log debug-level.
      this.logger.debug({ err, otherChannel }, "cross-channel VIP ping skipped");
    }
  }
}

// ISO timestamp → "YYYY-MM-DD" for compact prompt lines. Falls back to the
// raw string when unparseable so a malformed timestamp never breaks the block.
function fmtDate(iso: string): string {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return (iso || "").slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}

function prettyContact(jid: string): string {
  const at = jid.indexOf("@");
  if (at > 0) {
    const local = jid.slice(0, at);
    if (/^\d+$/.test(local)) return `+${local}`;
    return local;
  }
  return jid;
}
