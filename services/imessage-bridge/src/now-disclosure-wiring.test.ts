import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const here = __dirname;
const im = readFileSync(join(here, "session.ts"), "utf8");
const wa = readFileSync(join(here, "..", "..", "whatsapp-bridge", "src", "session.ts"), "utf8");
describe("## Now reaches a contact only through the inner-circle gate (ADR 0024 W1, review on #239)", () => {
  for (const [name, src] of [["imessage", im], ["whatsapp", wa]] as const) {
    it(`${name}: ownerNow is gated on isOwnerChan || isInnerCircle(relationship)`, () => {
      expect(src).toMatch(/ownerNow: isOwnerChan \|\| isInnerCircle\(relationship\) \? this\.ownerProfileStore\.nowBlock\(\) : ""/);
      expect(src).not.toMatch(/ownerNow: this\.ownerProfileStore\.nowBlock\(\),/);
    });
  }
});
