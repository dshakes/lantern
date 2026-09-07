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
  ["imessage", im, /tier\.tier === "LOW" && \(mutedHold \|\| IMessageSession\.DRAFT_CONFIRM_DEFAULT \|\| forceDraftCaution \|\| commitVerdict\?\.hold\)/],
  ["whatsapp", wa, /if \(opts\.mutedHold \|\| WhatsAppSession\.DRAFT_HIGH_STAKES \|\| forceDraftCaution \|\| commitVerdict\?\.hold\)/],
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

import { resolveHeldReply } from "./session.js";

// Behavioural, per the cross-audit: when the owner hand-off FAILS, a
// commitment hold must fail CLOSED. Before this, only the injection caution
// suppressed; a money promise fell through to hold-then-send with no owner
// warning — the one failure mode where the owner cannot intervene.
describe("resolveHeldReply — a safety hold never falls through to send", () => {
  it("hands off to the owner when the hand-off worked", () => {
    expect(resolveHeldReply({ held: true, forceDraftCaution: false, commitHold: true })).toBe("handed-to-owner");
  });
  it("commitment hold + failed hand-off → suppress (the audited bug)", () => {
    expect(resolveHeldReply({ held: false, forceDraftCaution: false, commitHold: true })).toBe("suppress");
  });
  it("injection caution + failed hand-off → suppress (already true, must stay true)", () => {
    expect(resolveHeldReply({ held: false, forceDraftCaution: true, commitHold: false })).toBe("suppress");
  });
  it("ordinary LOW with no safety hold may still fall through to hold-then-send", () => {
    expect(resolveHeldReply({ held: false, forceDraftCaution: false, commitHold: false })).toBe("fallthrough-send");
  });
});

describe("group sends are blocked at the boundary, not just in the pipeline", () => {
  it("whatsapp: sendMessage() blocks @g.us before any send", () => {
    const start = wa.indexOf("async sendMessage(");
    const block = wa.indexOf("isBlockedGroupSend(to)", start);
    const send = wa.indexOf("this.socket.sendMessage(jid, { text }, sendOpts)", start);
    expect(start).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(start);
    expect(send).toBeGreaterThan(block);
  });
  it("whatsapp: the voice-note ack itself skips groups", () => {
    expect(wa).toMatch(/annotation\.kind === "voice" && !\(msg\.key\.remoteJid \|\| ""\)\.endsWith\("@g\.us"\)/);
  });
  it("imessage: the voice-note ack skips group rows", () => {
    expect(im).toMatch(/annotation\.kind === "voice" && row\.handle && !isGroup/);
  });
});

describe("contact sharing goes through the deterministic policy on both bridges", () => {
  for (const [name, src] of [["imessage", im], ["whatsapp", wa]] as const) {
    it(`${name}: a share is sent only after isConfidentContactShare says so`, () => {
      const call = src.indexOf("isConfidentContactShare({");
      expect(call).toBeGreaterThan(0);
      // The direct send of the numbers sits inside that decision's block.
      const sendAfter = src.indexOf(name === "imessage" ? "await this.send(row.handle, numbers)" : "await this.sendMessage(from, numbers)", call);
      expect(sendAfter).toBeGreaterThan(call);
      expect(sendAfter - call).toBeLessThan(900);
    });
    it(`${name}: the share exit is fed the hold reason and the resolver's own uniqueness proof`, () => {
      expect(src).toMatch(/holdReason: commitVerdict\.reason, boundToNumber: promiseIsAboutNumber\(text, draft\)/);
      expect(src).toMatch(/requesterInnerCircle: isInnerCircle\(relationship\)/);
      expect(src).toMatch(/ambiguous: !r\.unique/);
      expect(src).not.toMatch(/ambiguous: \(this\.lastResolveSuggestions/);
    });
    it(`${name}: the owner is told after an auto-share`, () => {
      expect(src).toMatch(/📇 shared \$\{resolved/);
    });
  }
});

describe("voice floor (ADR 0024 W4) is wired on both bridges", () => {
  for (const [name, src] of [["imessage", im], ["whatsapp", wa]] as const) {
    it(`${name}: contact drafts are scored against the owner corpus, never the owner channel or a group`, () => {
      expect(src).toMatch(/voiceModel: isOwnerChan \|\| (opts\.)?isGroup \? null : this\.getVoiceModel\(\)/);
      expect(src).toMatch(/"voice score"/);
      expect(src).toMatch(/LANTERN_VOICE_FLOOR/);
    });
  }
});

describe("critique-refine (ADR 0024 W3.4) is wired on both bridges", () => {
  for (const [name, src] of [["imessage", im], ["whatsapp", wa]] as const) {
    it(`${name}: MEDIUM/LOW contact drafts are refined against the owner's own messages, purpose-keyed, accepted only when not further from the voice and clean`, () => {
      expect(src).toMatch(/if \(tier\.tier !== "HIGH" && !(opts\.)?isGroup && !isOwnerChan\) \{\s*draft = await this\.refineToOwnerVoice\(/);
      expect(src).toMatch(/::refine`/);
      expect(src).toMatch(/after <= before/);
      expect(src).toMatch(/detectBotTells\(refined, inbound, botTellCtx\)\.ok/);
      expect(src).toMatch(/LANTERN_VOICE_REFINE/);
    });
  }
});

describe("W1.3 + W5 parity", () => {
  for (const [name, src] of [["imessage", im], ["whatsapp", wa]] as const) {
    it(`${name}: the contact reply sees the assistant's own actions about that contact, never in a group`, () => {
      expect(src).toMatch(/(opts\.)?isGroup \? "" : contactActionsBlock\(recentActions\(\), /);
    });
    it(`${name}: a periodic LIVENESS line reports mute / kill switch / paused suppression`, () => {
      expect(src).toMatch(/private reportSilentDrops\(\)/);
      expect(src).toMatch(/LIVENESS: auto-reply is MUTED/);
      expect(src).toMatch(/setInterval\([\s\S]{0,80}?reportSilentDrops/);
    });
  }
});

describe("W2.1: a strict, exemplar-grounded third attempt precedes the static greeting table", () => {
  for (const [name, src] of [["imessage", im], ["whatsapp", wa]] as const) {
    it(`${name}: third attempt is guarded and continues into the normal gates`, () => {
      expect(src).toMatch(/strictRegenHint\(\{ ownerName, reasons: \[tellCheck\.reason/);
      expect(src).toMatch(/thirdCheck = third \? detectBotTells\(third, text, botTellCtx\)/);
      expect(src).toMatch(/else if \(third && thirdCheck\.ok\) \{/);
      const accept = src.indexOf("strict third regeneration accepted");
      const greeting = src.indexOf("sendGreetingFallback(", accept);
      expect(accept).toBeGreaterThan(0);
      expect(greeting).toBeGreaterThan(accept);
    });
  }
});

describe("W2.4: reasoned emotional register on both bridges", () => {
  for (const [name, src] of [["imessage", im], ["whatsapp", wa]] as const) {
    it(`${name}: uses resolveEmotionalRegister with a purpose-keyed, time-boxed call`, () => {
      expect(src).toMatch(/resolveEmotionalRegister\(text, \(prompt\) => this\.agent\.respondTo\(`\$\{[a-z.]+\}::register`, prompt, undefined, \{ withTools: false, timeoutMs: 10_000 \}\)\)/);
      expect(src).not.toMatch(/\bdetectEmotionalRegister\(text\)/);
    });
  }
});

describe("W2.5: a weak romanized language guess is confirmed before a reply mode engages (iMessage contact path)", () => {
  it("wraps detectLanguageHints in confirmLanguageHint with a purpose-keyed, time-boxed call", () => {
    expect(im).toMatch(/const langHint = await confirmLanguageHint\(text, detectLanguageHints\(text\), \(prompt\) =>\s*this\.agent\.respondTo\(`\$\{row\.handle\}::lang`, prompt, undefined, \{ withTools: false, timeoutMs: 8_000 \}\)\)/);
  });
});

describe("W2.3 + W1.4 on both bridges", () => {
  for (const [name, src] of [["imessage", im], ["whatsapp", wa]] as const) {
    it(`${name}: cross-thread recall keys on the semantic index first, local topic graph fills`, () => {
      expect(src).toMatch(/this\.personal\.searchMemory\(text, \{ excludeChannel: "(whatsapp|imessage)", excludeHandle: [a-z.]+, limit: 4, windowDays: 7 \}\)/);
      expect(src).toMatch(/formatRelatedBlock\(mergeRelated\(semanticRelated, related, 5\)\)/);
    });
    it(`${name}: an inferred relationship reaches the persona only, never a security gate`, () => {
      expect(src).toMatch(/relationship: relationship \?\? inferredRelationshipLabel\(inferredRelationship\)/);
      expect(src).toMatch(/isInnerCircle\(relationship\)/);
      expect(src).not.toMatch(/isInnerCircle\(inferred/);
      expect(src).toMatch(/::relationship`/);
    });
  }
});

describe("only resolver-proven matches are staged in the hold page", () => {
  for (const [name, src] of [["imessage", im], ["whatsapp", wa]] as const) {
    it(`${name}: a fuzzy/ambiguous hit is never one 'send' away`, () => {
      expect(src).toMatch(/const staged = resolved\.filter\(\(r\) => !r\.ambiguous\);\s*if \(staged\.length > 0 && staged\.length === resolved\.length\) \{/);
    });
  }
});

describe("a pause only ever extends (live 2026-09-07: a takeover pause clobbered a year-long one)", () => {
  it("whatsapp: pauseContact takes the max of the existing and the new expiry", () => {
    expect(wa).toMatch(/until: Math\.max\(prev\?\.until \?\? 0, Date\.now\(\) \+ ttlMs\)/);
  });
  it("imessage: both pause sites take the max", () => {
    expect(im.match(/pausedUntil\.set\([a-z.]+, Math\.max\(this\.pausedUntil\.get\([a-z.]+\) \?\? 0, Date\.now\(\) \+ [A-Za-z_]+\)\)/g)?.length).toBe(2);
  });
});

describe("mute drafts for the owner instead of dropping (owner, 2026-09-07)", () => {
  it("a muted hold never falls through to send when the owner hand-off fails", () => {
    expect(resolveHeldReply({ held: false, forceDraftCaution: false, commitHold: false, mutedHold: true })).toBe("suppress");
    expect(resolveHeldReply({ held: true, forceDraftCaution: false, commitHold: false, mutedHold: true })).toBe("handed-to-owner");
    // Unmuted, no other hold → the ordinary hold-then-send path is unchanged.
    expect(resolveHeldReply({ held: false, forceDraftCaution: false, commitHold: false, mutedHold: false })).toBe("fallthrough-send");
    expect(resolveHeldReply({ held: false, forceDraftCaution: false, commitHold: false })).toBe("fallthrough-send");
  });

  for (const [name, src] of [["imessage", im], ["whatsapp", wa]] as const) {
    it(`${name}: muted forces the draft tier and the draft branch, and never returns early`, () => {
      // The reply pipeline runs while muted — the old `return`/`continue` is gone.
      expect(src).toMatch(/tier\.reasons\.push\("-muted-draft-for-owner"\)/);
      expect(src).toMatch(/(mutedHold \|\| IMessageSession\.DRAFT_CONFIRM_DEFAULT|opts\.mutedHold \|\| WhatsAppSession\.DRAFT_HIGH_STAKES)/);
      expect(src).toMatch(/MUTED — reply will be drafted for the owner, not sent/);
      expect(src).not.toMatch(/contact reply suppressed — auto-reply is MUTED/);
    });
    it(`${name}: the kill switch, not mute, is the do-nothing switch`, () => {
      expect(src).toMatch(/killSwitch/);
    });
    // Reviewers on #250: routing muted replies to the draft queue is intent,
    // not an invariant — the draft block is !isGroup-gated and several paths
    // send on their own. The guarantee has to live at the send boundary.
    it(`${name}: while muted, the SEND BOUNDARY lets nothing reach anyone but the owner`, () => {
      expect(src).toMatch(/MUTED — send BLOCKED at boundary/);
      expect(src).toMatch(/this\.muted && !this\.(isOwnerChat|isOwnerTarget)\(to\)/);
      // it sits in the shared send function, alongside the other boundary guards
      const boundary = src.indexOf("MUTED — send BLOCKED at boundary");
      const sentinel = src.indexOf("abstain sentinel reached");
      expect(boundary).toBeGreaterThan(sentinel);
    });
    it(`${name}: a muted GROUP reply is drafted for the owner, never sent`, () => {
      expect(src).toMatch(/(\(!isGroup \|\| mutedHold\)|\(!opts\.isGroup \|\| opts\.mutedHold\))/);
    });
    it(`${name}: the confident contact-share shortcut cannot fire while muted`, () => {
      expect(src).toMatch(/!(opts\.)?mutedHold && isConfidentContactShare\(/);
    });
  }
});
