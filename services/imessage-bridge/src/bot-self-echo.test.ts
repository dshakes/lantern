import { describe, it, expect } from "vitest";
import { isBotSelfOrEcho } from "./session.js";

// Regression for the dedicated-bot / dual-Apple-ID echo loop: the bot's
// own outbound messages sync back into chat.db as is_from_me=0 rows with
// byte-identical text. Before the unified guard, isBotSelfMessage was only
// run on OUTBOUND, so when the in-memory send-dedup missed, the bot routed
// its own message as a fresh owner query and replied to itself — the
// doubled-text loop the owner reported. These are the actual strings from
// that incident (decoded from live chat.db).

const NEVER_SENT = (_t: string) => false;
const RECENTLY_SENT = (sent: string[]) => {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const set = new Set(sent.map(norm));
  return (t: string) => set.has(norm(t));
};

describe("isBotSelfOrEcho — unified bot-self / echo guard", () => {
  it("catches bot status/confirmation strings via the prefix backstop alone", () => {
    // No send-dedup state at all (e.g. after a restart) — the prefix
    // backstop must still recognize the bot's own confirmation.
    expect(isBotSelfOrEcho('🗒 saved as a note — "Costco Order"', NEVER_SENT)).toBe(true);
    expect(isBotSelfOrEcho("📅 added to calendar — Costco order", NEVER_SENT)).toBe(true);
    expect(isBotSelfOrEcho("👍 no worries", NEVER_SENT)).toBe(true);
  });

  it("catches free-form replies that were just sent, via content dedup", () => {
    const sent = [
      "noted! enjoy the party in poolville. 🎉 i'll keep the auto-replies on till you're back.",
      "sounds good, let's save that as a note for easy access. i'll add it now.",
    ];
    const isOwn = RECENTLY_SENT(sent);
    // Echo arrives with mutated whitespace/case — still suppressed.
    expect(isBotSelfOrEcho("NOTED! enjoy the party in poolville. 🎉  i'll keep the auto-replies on till you're back.", isOwn)).toBe(true);
    expect(isBotSelfOrEcho("sounds good, let's save that as a note for easy access. i'll add it now.", isOwn)).toBe(true);
  });

  it("free-form replies are NOT caught by the prefix backstop alone (they need send-dedup)", () => {
    // Documents why the content matcher is load-bearing — the prefix list
    // can never cover free-form LLM output.
    expect(isBotSelfOrEcho("noted! enjoy the party in poolville. 🎉 i'll keep the auto-replies on till you're back.", NEVER_SENT)).toBe(false);
  });

  it("does NOT silence genuine owner input", () => {
    const isOwn = RECENTLY_SENT(["🗒 saved as a note — \"Costco Order\""]);
    expect(isBotSelfOrEcho("can you check when my passport expires?", isOwn)).toBe(false);
    expect(isBotSelfOrEcho("yes", isOwn)).toBe(false);
    expect(isBotSelfOrEcho("call mom at 6", isOwn)).toBe(false);
  });

  it("empty / whitespace bodies fall through (return false) so empty-text handling is untouched", () => {
    expect(isBotSelfOrEcho("", NEVER_SENT)).toBe(false);
    expect(isBotSelfOrEcho("   ", NEVER_SENT)).toBe(false);
  });
});
