// Tests for the natural communication layer.
//
// The layer has three primary surfaces:
//   1. shouldRespond  — decides reply vs. reaction vs. silence
//   2. inferStyle     — observes recent inbound to estimate the recipient's register
//   3. naturalize     — cleans + paces + splits a draft into a burst
//
// These are pure functions of their inputs (no I/O, no LLM), so we can
// assert behavior deterministically. The pacing helper outputs include
// jitter — we assert ranges, not exact values.

import { describe, it, expect } from "vitest";
import {
  agentPersonaPrompt,
  inferStyle,
  naturalize,
  shouldRespond,
} from "../src/natural.js";

describe("shouldRespond", () => {
  it("suppresses on bare ack tokens and suggests a reaction", () => {
    for (const ack of ["k", "ok", "kk", "yeah", "lol", "haha", "thanks", "ty"]) {
      const v = shouldRespond(ack);
      expect(v.respond).toBe(false);
      if (!v.respond) expect(v.reaction).toBeTruthy();
    }
  });

  it("suppresses on case-insensitive acks", () => {
    expect(shouldRespond("OK").respond).toBe(false);
    expect(shouldRespond("KK").respond).toBe(false);
    expect(shouldRespond("Lol").respond).toBe(false);
  });

  it("suppresses on ack with trailing punctuation", () => {
    expect(shouldRespond("k.").respond).toBe(false);
    expect(shouldRespond("ok!").respond).toBe(false);
    expect(shouldRespond("thanks!!").respond).toBe(false);
  });

  it("mirrors a familiar single emoji as the same reaction", () => {
    const v = shouldRespond("👍");
    expect(v.respond).toBe(false);
    if (!v.respond) expect(v.reaction).toBe("👍");
  });

  it("falls back to a heart for unfamiliar single emojis", () => {
    const v = shouldRespond("🦄");
    expect(v.respond).toBe(false);
    if (!v.respond) expect(v.reaction).toBe("❤️");
  });

  it("replies on multi-word substantive messages", () => {
    expect(shouldRespond("are you home").respond).toBe(true);
    expect(shouldRespond("what time tomorrow?").respond).toBe(true);
    expect(shouldRespond("hey, can you grab milk on the way back?").respond).toBe(true);
  });

  it("replies even when the message contains an emoji + words", () => {
    expect(shouldRespond("ok cool 👍 see you later").respond).toBe(true);
    expect(shouldRespond("👋 hey").respond).toBe(true);
  });

  it("treats empty / whitespace as no-reply with no reaction", () => {
    const v = shouldRespond("   ");
    expect(v.respond).toBe(false);
    if (!v.respond) expect(v.reaction).toBeUndefined();
  });
});

describe("inferStyle", () => {
  it("returns neutral defaults for an empty history", () => {
    const s = inferStyle([]);
    expect(s.formality).toBe("neutral");
    expect(s.usesEmojis).toBe(false);
  });

  it("flags casual on lowercase + abbreviations", () => {
    const s = inferStyle([
      "hey what u up to",
      "lol that's wild",
      "ngl i havent decided yet",
      "btw the place is closed rn",
    ]);
    expect(s.formality).toBe("casual");
    expect(s.mostlyLowercase).toBe(true);
    expect(s.usesAbbreviations).toBe(true);
  });

  it("flags formal on punctuated, capitalized prose", () => {
    const s = inferStyle([
      "Good afternoon. I hope this message finds you well.",
      "Please let me know your availability for next week.",
      "Sincerely, the latest report is attached. Furthermore, please review.",
      "Therefore, we should proceed with caution.",
    ]);
    expect(s.formality).toBe("formal");
    expect(s.mostlyLowercase).toBe(false);
  });

  it("tracks emoji usage", () => {
    const s = inferStyle([
      "great work today 🙌",
      "i'll be there at 6 🚗",
      "feeling good about it ✨",
    ]);
    expect(s.usesEmojis).toBe(true);
  });

  it("reports short-message register", () => {
    const s = inferStyle(["ok", "sure", "yeah", "see you", "later"]);
    expect(s.avgWordsPerMessage).toBeLessThan(3);
  });
});

describe("naturalize", () => {
  const baseStyle = inferStyle(["hey what time", "sounds good", "ok cool"]);

  it("strips assistant openers", () => {
    const out = naturalize("Certainly! I can help with that. The answer is 42.", {
      inbound: "what is the answer?",
      style: baseStyle,
    });
    const joined = out.map((m) => m.text).join(" ");
    expect(joined.toLowerCase()).not.toContain("certainly");
    expect(joined).toContain("42");
  });

  it("strips assistant closers", () => {
    const out = naturalize(
      "the meeting is at 3pm. Let me know if you need anything else.",
      { inbound: "when is the meeting?", style: baseStyle }
    );
    const joined = out.map((m) => m.text).join(" ");
    expect(joined.toLowerCase()).not.toContain("let me know if");
  });

  it("returns a single message for short drafts", () => {
    const out = naturalize("yeah sounds good", {
      inbound: "wanna grab lunch?",
      style: baseStyle,
    });
    expect(out.length).toBe(1);
  });

  it("splits long drafts into 2-3 burst messages", () => {
    const long =
      "Sure, I can pick you up at 6pm from your office. The traffic should be light by then. After that we can swing by the grocery store. Anything specific you need from there?";
    const out = naturalize(long, {
      inbound: "can you pick me up tonight and stop by the store?",
      style: baseStyle,
    });
    expect(out.length).toBeGreaterThan(1);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("paces messages: first has read delay, subsequent have shorter gaps", () => {
    const out = naturalize(
      "yeah I'll be there at 6. Want me to bring anything? Maybe ice cream.",
      { inbound: "are you coming tonight?", style: baseStyle }
    );
    if (out.length >= 2) {
      // First message includes "read + think" lag; subsequent are gaps only.
      expect(out[0].delayBeforeMs).toBeGreaterThan(out[1].delayBeforeMs);
    }
    // Every message must have a positive typing duration so the recipient
    // sees the indicator. No instant-bot replies.
    for (const m of out) {
      expect(m.typingMs).toBeGreaterThanOrEqual(700);
    }
  });

  it("applies lowercase styling when the recipient is mostly lowercase", () => {
    const casual = inferStyle([
      "hey what u up to",
      "lol fair",
      "ngl im tired",
      "btw the place is closed",
    ]);
    const out = naturalize(
      "Yes, I will be there. Bring your coat.",
      { inbound: "u coming?", style: casual }
    );
    const first = out[0].text;
    // First letter of the sentence should be lowercased.
    expect(first[0]).toBe(first[0].toLowerCase());
  });

  it("does NOT lowercase when recipient is formal", () => {
    const formal = inferStyle([
      "Good morning. Please review the document.",
      "Sincerely, the report is ready.",
      "Furthermore, kindly confirm receipt.",
    ]);
    const out = naturalize("Yes, I will be there. Bring your coat.", {
      inbound: "Will you attend?",
      style: formal,
    });
    expect(out[0].text[0]).toBe("Y");
  });

  it("returns empty array when the draft is only assistantisms", () => {
    // "Certainly! Let me know if you need anything else." is pure noise —
    // opener + closer cancel out. The naturalizer should refuse to send
    // anything at all (better silent than the bot showing through).
    const stripped = naturalize(
      "Certainly! Let me know if you need anything else.",
      { inbound: "test", style: baseStyle }
    );
    expect(stripped).toEqual([]);
    expect(naturalize("", { inbound: "test", style: baseStyle })).toEqual([]);
  });
});

describe("agentPersonaPrompt", () => {
  const style = inferStyle(["hey", "u around?", "lol ok", "ngl tired"]);

  it("names the owner and forbids assistant-ish phrasing", () => {
    const p = agentPersonaPrompt("Shekhar", style, false);
    expect(p).toContain("Shekhar");
    expect(p).toContain("Never identify yourself as an AI");
    expect(p).toContain("Never say");
    expect(p).toContain("How can I help you today?");
  });

  it("includes group-mode hint when isGroup is true", () => {
    const p = agentPersonaPrompt("Shekhar", style, true);
    expect(p).toContain("group chat");
  });

  it("includes 1-on-1 framing when isGroup is false", () => {
    const p = agentPersonaPrompt("Shekhar", style, false);
    expect(p).toContain("1-on-1");
  });

  it("includes style cues derived from the recipient's history", () => {
    const casual = inferStyle(["hey u", "lol ok", "ngl tired"]);
    const p = agentPersonaPrompt("Shekhar", casual, false);
    expect(p.toLowerCase()).toContain("lowercase");
  });
});
