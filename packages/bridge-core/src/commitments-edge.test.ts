// commitments-edge.test.ts — pure-function unit tests (node:test via tsx).
// No network. Covers: detectTaskCapture (pos/neg), renderNudge (w/wo plan),
// resolveReply (each action + no-match).

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  detectTaskCapture,
  renderNudge,
  resolveReply,
  type Commitment,
  type PendingCommitmentNudge,
} from "./commitments-edge.ts";

// ── Shared fixture ────────────────────────────────────────────────────────────

const PENDING: PendingCommitmentNudge = {
  id: "cmt-001",
  title: "Apply for naturalization",
  assignedBy: "Manu",
  issuedAt: Date.now(),
};

const NOW = 1_700_000_000_000; // fixed epoch for snooze tests

// ── detectTaskCapture ─────────────────────────────────────────────────────────

describe("detectTaskCapture — positive", () => {
  const positives: string[] = [
    "Can you apply for the naturalization certificate this week?",
    "Could you please call the doctor and schedule an appointment?",
    "Don't forget to submit the tax return by April 15.",
    "Remember to pick up the passport photos tomorrow.",
    "Make sure to send Raju the deck before Thursday.",
    "You need to renew your driver's license before it expires.",
    "I need you to book the tickets for the conference.",
    "Please schedule the dentist appointment for next week.",
    "You should really look into the mortgage refinancing options.",
    "Make sure to file the FAFSA before the deadline.",
  ];

  for (const text of positives) {
    test(text.slice(0, 60), () => {
      const result = detectTaskCapture(text);
      assert.ok(result !== null, `expected capture for: "${text}"`);
      assert.ok((result?.title.length ?? 0) >= 5, `title too short: "${result?.title}"`);
    });
  }
});

describe("detectTaskCapture — negative (no false captures)", () => {
  const negatives: string[] = [
    "Hello, how are you?",
    "I love you!",
    "Where are you right now?",
    "Can you believe it?",
    "Could you imagine that happening?",
    "Can you tell me what time it is?",
    "Could you let me know when you're free?",
    "Please tell me more about that.",
    "What's the weather like today?",
    "I'm on my way.",
    "Thanks!",
    "ok",
    "",
    "Can you?",                               // body too short
    "Please.",                                // body too short
    "Could you please?",                      // body too short
  ];

  for (const text of negatives) {
    test(`no capture: "${text.slice(0, 50)}"`, () => {
      const result = detectTaskCapture(text);
      assert.equal(result, null, `unexpected capture for: "${text}"`);
    });
  }
});

describe("detectTaskCapture — urgency", () => {
  test("URGENT flags now urgency", () => {
    const r = detectTaskCapture("Can you please send the email URGENT, it's an emergency!");
    assert.ok(r != null, "expected capture");
    assert.equal(r?.urgency, "now");
  });

  test("today flags soon urgency", () => {
    const r = detectTaskCapture("Remember to call the bank today before they close.");
    assert.ok(r != null, "expected capture");
    assert.equal(r?.urgency, "soon");
  });

  test("normal urgency for undated task", () => {
    const r = detectTaskCapture("Don't forget to renew the car insurance.");
    assert.ok(r != null, "expected capture");
    assert.equal(r?.urgency, "normal");
  });
});

// ── renderNudge ───────────────────────────────────────────────────────────────

describe("renderNudge — without action_plan", () => {
  const c: Commitment = {
    id: "cmt-001",
    title: "Apply for naturalization",
    assignedBy: "Manu",
    status: "open",
  };

  test("contains 📌 emoji prefix", () => {
    assert.ok(renderNudge(c).startsWith("📌 "));
  });

  test("contains title", () => {
    assert.ok(renderNudge(c).includes("Apply for naturalization"));
  });

  test("contains assignedBy", () => {
    assert.ok(renderNudge(c).includes("from Manu"));
  });

  test("contains all 3 quick-reply keywords", () => {
    const line = renderNudge(c);
    assert.ok(line.includes("research"), "missing research");
    assert.ok(line.includes("snooze"), "missing snooze");
    assert.ok(line.includes("done"), "missing done");
  });

  test("no assignedBy omitted gracefully", () => {
    const c2: Commitment = { id: "c2", title: "Renew passport", status: "open" };
    const line = renderNudge(c2);
    assert.ok(line.startsWith("📌 Renew passport"));
    assert.ok(!line.includes("from "));
  });
});

describe("renderNudge — with action_plan", () => {
  const c: Commitment = {
    id: "cmt-002",
    title: "File FAFSA",
    assignedBy: "Manu",
    status: "suggested",
    action_plan: {
      summary: "Check studentaid.gov, gather tax docs, submit by deadline",
      steps: [
        { title: "Log in to studentaid.gov", oneClick: "open studentaid.gov" },
        { title: "Import IRS info", oneClick: "use IRS Data Retrieval Tool" },
        { title: "Submit application", detail: "Review and submit" },
      ],
      sources: [{ title: "StudentAid.gov", url: "https://studentaid.gov" }],
    },
  };

  test("includes action_plan summary", () => {
    assert.ok(renderNudge(c).includes("Check studentaid.gov"));
  });

  test("includes up to 3 step oneClicks", () => {
    const out = renderNudge(c);
    assert.ok(out.includes("open studentaid.gov"), "missing step 1 oneClick");
    assert.ok(out.includes("use IRS Data Retrieval Tool"), "missing step 2 oneClick");
  });

  test("omits steps without oneClick", () => {
    const out = renderNudge(c);
    // Step 3 has no oneClick, should not appear as a bullet
    assert.ok(!out.includes("Review and submit"));
  });
});

// ── resolveReply ──────────────────────────────────────────────────────────────

describe("resolveReply — recognized actions", () => {
  test("'research' → type research", () => {
    const r = resolveReply("research", PENDING, NOW);
    assert.deepEqual(r, { type: "research" });
  });

  test("'r' shortcut → type research", () => {
    const r = resolveReply("r", PENDING, NOW);
    assert.deepEqual(r, { type: "research" });
  });

  test("'RESEARCH' (case-insensitive) → type research", () => {
    const r = resolveReply("RESEARCH", PENDING, NOW);
    assert.deepEqual(r, { type: "research" });
  });

  test("'done' → type done", () => {
    const r = resolveReply("done", PENDING, NOW);
    assert.deepEqual(r, { type: "done" });
  });

  test("'✅' → type done", () => {
    const r = resolveReply("✅", PENDING, NOW);
    assert.deepEqual(r, { type: "done" });
  });

  test("'dismiss' → type dismiss", () => {
    const r = resolveReply("dismiss", PENDING, NOW);
    assert.deepEqual(r, { type: "dismiss" });
  });

  test("'skip' → type dismiss", () => {
    const r = resolveReply("skip", PENDING, NOW);
    assert.deepEqual(r, { type: "dismiss" });
  });

  test("'snooze' alone → snooze with default 3h", () => {
    const r = resolveReply("snooze", PENDING, NOW);
    assert.ok(r != null, "expected CommitmentAction");
    assert.equal(r?.type, "snooze");
    const expected = NOW + 3 * 60 * 60_000;
    const actual = new Date(r?.snoozeUntil ?? "").getTime();
    assert.ok(Math.abs(actual - expected) < 1000, "snooze should be ~3h from now");
  });

  test("'snooze 2h' → snooze 2 hours", () => {
    const r = resolveReply("snooze 2h", PENDING, NOW);
    assert.equal(r?.type, "snooze");
    const expected = NOW + 2 * 60 * 60_000;
    assert.ok(Math.abs(new Date(r?.snoozeUntil ?? "").getTime() - expected) < 1000);
  });

  test("'snooze 30m' → snooze 30 minutes", () => {
    const r = resolveReply("snooze 30m", PENDING, NOW);
    assert.equal(r?.type, "snooze");
    const expected = NOW + 30 * 60_000;
    assert.ok(Math.abs(new Date(r?.snoozeUntil ?? "").getTime() - expected) < 1000);
  });

  test("'snooze 1d' → snooze 1 day", () => {
    const r = resolveReply("snooze 1d", PENDING, NOW);
    assert.equal(r?.type, "snooze");
    const expected = NOW + 24 * 60 * 60_000;
    assert.ok(Math.abs(new Date(r?.snoozeUntil ?? "").getTime() - expected) < 1000);
  });

  test("'snooze tomorrow' → next day 9am", () => {
    const r = resolveReply("snooze tomorrow", PENDING, NOW);
    assert.equal(r?.type, "snooze");
    const d = new Date(r?.snoozeUntil ?? "");
    assert.equal(d.getHours(), 9, "snooze-tomorrow should be at 9am");
  });
});

describe("resolveReply — no match", () => {
  const noMatches = [
    "hello",
    "what does this mean?",
    "maybe",
    "let me think",
    "ok great",
    "",
    "   ",
  ];

  for (const text of noMatches) {
    test(`no match for: "${text}"`, () => {
      assert.equal(resolveReply(text, PENDING, NOW), null);
    });
  }
});
