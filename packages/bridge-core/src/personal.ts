// Client for the control-plane's WhatsApp personal-assistant
// endpoints: VIP contacts, contact facts (memory), pending drafts.
// All requests go through authedFetch so they're authenticated as
// the bridge's service principal.

import { authedFetch } from "./auth.js";
import type { Logger } from "pino";

interface VIPEntry { jid: string; displayName: string }
interface Fact { id: string; content: string; source: string; updatedAt: string }

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
            this.logger.debug({ jid, existing: f.content, candidate: c }, "auto-fact deduped against existing");
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

function prettyContact(jid: string): string {
  const at = jid.indexOf("@");
  if (at > 0) {
    const local = jid.slice(0, at);
    if (/^\d+$/.test(local)) return `+${local}`;
    return local;
  }
  return jid;
}
