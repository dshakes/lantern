import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Regression: PROACTIVE INGESTER (maybeIngestUnknownInbound) is designed for
// unknown 1:1 senders ("appointment confirmations from an unrecognized
// number"), but its iMessage call site had no !isGroup guard — unlike every
// sibling proactive-scan block in this file (style-learning, inner-circle
// agentic, proactive-memory) and unlike the WhatsApp bridge's own
// maybeIngestUnknownInbound (`!this.isGroupJid(from)`). A group participant's
// message pattern-matching delivery/appointment language got silently
// swallowed — "contact reply suppressed — unknown-inbound owned by
// life-event/appointment ingestion" — inside live GROUP threads, confirmed
// live 2026-08-18 (chatRowid 2656, isGroup:true) and reconfirmed repeatedly.
// This only fixes the group-scope leak; whether a genuine 1:1 unknown-sender
// appointment text should ever get a contact-facing reply is a separate,
// still-open product question (introspect state.json).

describe("maybeIngestUnknownInbound call site is DM-only", () => {
  const src = readFileSync(new URL("./session.ts", import.meta.url), "utf8");

  it("the call site checks !isGroup before invoking the ingester", () => {
    const anchor = "const ingest = ";
    const site = src.slice(src.indexOf(anchor), src.indexOf(anchor) + 300);
    expect(site).toMatch(/!isGroup/);
    expect(site).toMatch(/maybeIngestUnknownInbound/);
  });
});
