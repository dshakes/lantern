import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The commitment gate (bridge-core/commitment-gate.ts) only protects the
// owner if it stays WIRED: it must run before the tier is logged, and both
// bridges' hold conditions must honor its verdict regardless of the
// draft-confirm opt-in. A refactor that drops `|| commitVerdict?.hold` would
// silently restore the 09-03→06 behaviour — ~60 money promises sent as MEDIUM.
const im = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
const wa = readFileSync(new URL("../../whatsapp-bridge/src/session.ts", import.meta.url), "utf8");

for (const [name, src, holdLine] of [
  ["imessage", im, /tier\.tier === "LOW" && \(IMessageSession\.DRAFT_CONFIRM_DEFAULT \|\| forceDraftCaution \|\| commitVerdict\?\.hold\)/],
  ["whatsapp", wa, /if \(WhatsAppSession\.DRAFT_HIGH_STAKES \|\| forceDraftCaution \|\| commitVerdict\?\.hold\)/],
] as const) {
  describe(`${name}: commitment gate stays wired`, () => {
    it("calls judgeCommitment on the contact reply path", () => {
      expect(src).toMatch(/commitVerdict = await judgeCommitment\(\{/);
    });
    it("runs BEFORE the tier is logged, so the log reflects the held verdict", () => {
      const gate = src.indexOf("commitVerdict = await judgeCommitment(");
      // Match the LOGGER CALL, not the bare string (it also appears in comments).
      const logged = src.indexOf(name === "imessage" ? 'tierBadge(tier) }, "reply confidence")' : 'tierBadge(tier) }, "wa reply confidence")');
      expect(gate).toBeGreaterThan(0);
      expect(gate).toBeLessThan(logged);
    });
    it("the hold path honors the verdict even when draft-confirm is OFF", () => {
      expect(src).toMatch(holdLine);
    });
    it("passes thread context — money is agreed once, then promised bare", () => {
      expect(src).toMatch(/recentTranscript/);
    });
    it("uses a purpose-keyed session, never the contact's live session", () => {
      expect(src).toMatch(/::commitgate`/);
    });
  });
}
