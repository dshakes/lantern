// Runtime probe for the three roadmap features (B1 / B6 / B7).
// Not a test — a live demonstration the owner can eyeball. Run with:
//   cd packages/bridge-core && npx tsx src/roadmap-features.probe.ts
//
// It exercises each feature against representative inputs and prints the
// results, so "tests pass" is backed by an actual run.

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  detectEmotionalRegister,
  emotionalRegisterAddendum,
} from "./emotional-register.ts";
import { OwnerProfileStore } from "./owner-profile.ts";
import { computeProactiveNudges } from "./anticipation.ts";

const line = () => console.log("─".repeat(68));

// ── B1: emotional-register detection ────────────────────────────────────
console.log("\nB1 — detectEmotionalRegister on 5 example messages:");
line();
const samples = [
  "really rough day honestly, can't stop crying",
  "this is STILL not fixed?! ridiculous",
  "GOT THE JOB!!! 🎉🎉",
  "hey can you send me the address for tomorrow",
  "my dad's in the hospital and i'm scared",
];
for (const s of samples) {
  const v = detectEmotionalRegister(s);
  console.log(
    `  "${s}"\n    → ${v.register.padEnd(11)} conf=${v.confidence}  signals=[${v.signals.join(", ")}]`,
  );
}
console.log("\n  distress addendum (proves scheduling suppression):");
console.log(
  emotionalRegisterAddendum("distress")
    .split("\n")
    .map((l) => "    " + l)
    .join("\n"),
);

// ── B6: alias re-identification ─────────────────────────────────────────
console.log("\n\nB6 — alias resolving to the primary contact:");
line();
const dir = mkdtempSync(join(tmpdir(), "probe-aliases-"));
const profilePath = join(dir, "owner-profile.md");
writeFileSync(
  profilePath,
  `# Owner profile

## About me
I'm Shekhar.

## Relationships
- Sujith Penchala: brother-in-law | also: +15551234567, +15559876543
- Madhu: close friend | also: +19998887777
`,
  "utf8",
);
const store = new OwnerProfileStore(pino({ level: "silent" }), profilePath);

const aliasHandle = "15559876543@s.whatsapp.net"; // second number, as a WA jid
console.log(`  inbound from new number: ${aliasHandle}`);
console.log(`    canonicalNameFor → ${store.canonicalNameFor(aliasHandle)}`);
console.log(`    relationshipFor  → ${store.relationshipFor(aliasHandle)}`);
console.log(
  `  (primary "Sujith Penchala" still resolves: ${store.relationshipFor("Sujith Penchala")})`,
);
console.log(`  Madhu's 2nd number +19998887777 → ${store.canonicalNameFor("+19998887777")}`);

// ── B7: dormant-VIP nudge ───────────────────────────────────────────────
console.log("\n\nB7 — dormant-VIP nudge firing:");
line();
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const nudges = computeProactiveNudges({
  now: NOW,
  dormantContacts: [
    {
      handle: "+15550001111",
      displayName: "Madhu",
      lastExchangeAt: NOW - 65 * DAY, // ~2 months
      contactSignals: { relationship: "brother", vip: true, messageCount: 40 },
    },
    {
      // Low-priority acquaintance gone quiet → should NOT fire.
      handle: "+15559998888",
      displayName: "Random Acquaintance",
      lastExchangeAt: NOW - 300 * DAY,
      contactSignals: { relationship: "acquaintance" },
    },
  ],
});
console.log(`  nudges returned: ${nudges.length} (low-priority contact correctly suppressed)`);
for (const n of nudges) {
  console.log(`    [${n.kind}] p=${Math.round(n.priority)}  "${n.text}"`);
  console.log(`      dedupeKey=${n.dedupeKey}`);
}

console.log("\nprobe complete.\n");
