// Parity gate: the reply pipeline + owner loops must be wired into BOTH bridges.
// Every gate this repo has shipped to one bridge only (mute-drafts, grounding…)
// has bitten us live. Adding a gate to one session.ts without the other fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (svc: string) =>
  readFileSync(fileURLToPath(new URL(`../../../services/${svc}/src/session.ts`, import.meta.url)), "utf8");
const IM = read("imessage-bridge");
const WA = read("whatsapp-bridge");

/** Symbols that MUST be referenced by both bridges' session.ts. */
export const REQUIRED_BOTH = [
  "detectBotTells", // bot-tell guard, last pass before send
  "judgeCommitment", // commitment gate (money/promises HOLD)
  "commitmentHoldPage",
  "judgeGrounding", // grounding gate
  "groundingHoldPage",
  "voiceDelta", // voice-score authorship floor
  "fitVoiceModel",
  "buildRefinePrompt", // voice-refine (critique-refine)
  "parseRefine",
  "verifyClaims",
  "-muted-draft-for-owner", // mute = draft for owner (iMessage wraps it in resolveHeldReply; WA inlines it)
  "rankAttention",
  "computeProactiveNudges",
  "maybeRunSkills",
  "maybeHandleRecap",
  "proactivePaused",
];

/** Intentionally iMessage-only modules. Must stay absent from WhatsApp; if WA adopts one, drop it here. */
export const IMESSAGE_ONLY: Record<string, string> = {
  // WA imports only the pure waHistoryEvidence reader; the mail/calendar refresh (parseWorldModel) is Mac-local.
  "world-model": "reads Apple Mail + device calendar, which only exist on the Mac the iMessage bridge runs on",
  "gmail-ingest": "Gmail ingestion rides the iMessage bridge's Mac-local mail access",
  "mail-index": "Apple Mail Envelope Index SQLite is macOS-local",
  "mac-usage": "knowledgeC.db is macOS-local",
  "screen-context": "macOS screen capture",
  "attributed-body": "decodes chat.db attributedBody typedstream (iMessage/RCS only)",
  "call-commitments": "outbound-call commitments are only wired from the iMessage owner flow",
  "brief-reply": "Brief reply handling currently lives in the iMessage owner path only",
};

for (const sym of REQUIRED_BOTH) {
  test(`parity: ${sym} referenced in both bridges`, () => {
    assert.ok(IM.includes(sym), `iMessage session.ts is missing ${sym}`);
    assert.ok(WA.includes(sym), `WhatsApp session.ts is missing ${sym}`);
  });
}

for (const [mod, why] of Object.entries(IMESSAGE_ONLY)) {
  test(`parity allowlist: ${mod} is iMessage-only (${why})`, () => {
    const probe = mod === "world-model" ? "parseWorldModel" : `/${mod}"`;
    assert.ok(!WA.includes(probe), `WhatsApp now uses ${mod}: remove it from IMESSAGE_ONLY`);
  });
}
