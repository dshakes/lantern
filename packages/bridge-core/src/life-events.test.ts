// Tests for the LIFE-EVENT ENGINE. The bar: recognize the owner's REAL dropped
// messages (GEICO bill, UPS delivery, Amex fraud, athenahealth OTP) as typed,
// field-extracted life-events and route them correctly — while still suppressing
// a true promo (DSW) and never misclassifying a normal human message.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  classifyLifeEvent,
  classifyLifeEventSync,
  suggestedActionsFor,
  proactiveDecision,
  isStaleEvent,
  applyPrefDowngrade,
  recordAccept,
  recordIgnore,
  isActionableKind,
  LIFE_EVENT_SELF_PREFIXES,
  type LifeEventPrefs,
  type LifeEvent,
} from "./life-events.ts";
import { isBotSelfMessage } from "./bot-self.ts";

// Fixed clock so due-date / urgency math is deterministic.
const NOW = new Date("2026-06-25T12:00:00Z");
const opts = { now: NOW, channel: "iMessage" as const };

describe("life-events — undated travel/appointment must NOT nudge (placeholder-nudge bug)", () => {
  // Regression: the bot surfaced "✈️ travel update. add it to your calendar?"
  // from an old flight email with no upcoming itinerary, then admitted it had
  // nothing — a placeholder nudge. An undated travel/appointment has nothing to
  // put on a calendar, so it must be suppressed, not offered.
  const ev = (over: Partial<LifeEvent>): LifeEvent => ({
    kind: "travel",
    confidence: 0.85,
    urgency: "fyi",
    channel: "email",
    fields: {},
    rawText: "✈️ trip summary — flights 2024-2025, nothing upcoming",
    ...over,
  } as LifeEvent);

  test("undated travel → no calendar action and route 'suppress'", () => {
    const e = ev({ kind: "travel", fields: {} });
    assert.equal(suggestedActionsFor(e).length, 0, "undated travel must offer no action");
    assert.equal(proactiveDecision(e, {}, NOW).route, "suppress");
  });

  test("undated appointment → route 'suppress'", () => {
    const e = ev({ kind: "appointment", fields: {}, rawText: "we got your message" });
    assert.equal(proactiveDecision(e, {}, NOW).route, "suppress");
  });

  test("DATED travel still surfaces with a calendar action", () => {
    const e = ev({ kind: "travel", urgency: "soon", fields: { time: "Jul 5 9:00 AM" }, rawText: "Flight UA123 departs Jul 5 9:00 AM" });
    const d = proactiveDecision(e, {}, NOW);
    assert.notEqual(d.route, "suppress", "a dated trip is real — it should surface");
    assert.equal(d.actions[0]?.kind, "calendar");
  });

  test("the travel gate does NOT affect otp (empty actions by design still surfaces)", () => {
    const e = ev({ kind: "otp", urgency: "now", fields: { code: "123456" }, rawText: "Your verification code is 123456" });
    assert.notEqual(proactiveDecision(e, {}, NOW).route, "suppress", "otp must still surface");
  });
});

describe("life-events — recency gate: only surface RECENT + actionable (stale-Gmail-nudge bug)", () => {
  // Gmail ingestion pulls recently-RECEIVED mail whose CONTENT may be PAST.
  // An event that already happened isn't actionable and must be suppressed —
  // WITHOUT suppressing valid future/recent events (high precision).
  const evt = (over: Partial<LifeEvent>): LifeEvent => ({
    kind: "travel", confidence: 0.85, urgency: "soon", channel: "email", fields: {}, rawText: "", ...over,
  } as LifeEvent);

  test("travel with an EXPLICIT past date → stale → suppress", () => {
    const e = evt({ kind: "travel", fields: { time: "Jun 5, 2024 9:00 AM" }, rawText: "Flight UA10 departed Jun 5, 2024 9:00 AM" });
    assert.equal(isStaleEvent(e, NOW), true);
    assert.equal(proactiveDecision(e, {}, NOW).route, "suppress");
  });

  test("travel with a FUTURE date → not stale → surfaces", () => {
    const e = evt({ kind: "travel", fields: { time: "Aug 12, 2026 6:00 AM" }, rawText: "Flight UA10 departs Aug 12, 2026 6:00 AM" });
    assert.equal(isStaleEvent(e, NOW), false);
    assert.notEqual(proactiveDecision(e, {}, NOW).route, "suppress");
  });

  test("bare (year-less) future-ish date is NOT suppressed (rolls forward — precision guard)", () => {
    // "Jul 5" with no year → parseDueDate rolls to the next occurrence → future.
    const e = evt({ kind: "appointment", fields: { time: "Jul 5 2:00 PM" }, rawText: "Your appointment is Jul 5 at 2:00 PM" });
    assert.equal(isStaleEvent(e, NOW), false);
  });

  test("bill with an explicit past due date → stale → suppress", () => {
    const e = classifyLifeEventSync("Acme Power: your payment of $84.20 was due Jan 15, 2024.", opts);
    assert.equal(e.kind, "bill");
    assert.equal(e.fields.dueDate, "2024-01-15");
    assert.equal(proactiveDecision(e, {}, NOW).route, "suppress");
  });

  test("already-DELIVERED package → nothing to schedule → suppress", () => {
    const e = classifyLifeEventSync("UPS: Your package 1Z999AA10123456784 was delivered to your front door.", opts);
    assert.equal(e.kind, "delivery");
    assert.equal(isStaleEvent(e, NOW), true);
    assert.equal(proactiveDecision(e, {}, NOW).route, "suppress");
  });

  test("out-for-delivery (in transit) is NOT stale → still surfaces", () => {
    const e = classifyLifeEventSync("UPS: 1Z999AA10123456784 is out for delivery, arriving tomorrow.", opts);
    assert.equal(e.kind, "delivery");
    assert.equal(isStaleEvent(e, NOW), false);
  });

  test("recency gate never touches fraud/otp (always surface)", () => {
    const fraud = classifyLifeEventSync("Amex Fraud Alert: declined $420 charge — was this you? call 1-800-528-4800.", opts);
    assert.equal(isStaleEvent(fraud, NOW), false);
    const otp = classifyLifeEventSync("Your one-time code is 884213", opts);
    assert.equal(isStaleEvent(otp, NOW), false);
  });
});

describe("classifyLifeEvent — REAL owner examples", () => {
  test("GEICO → bill with amount + payee + due date", () => {
    const e = classifyLifeEventSync(
      "GEICO Policy: Your payment of $1,989.85 for policy 1234 is due Jun 30.",
      opts,
    );
    assert.equal(e.kind, "bill");
    assert.equal(e.fields.amount, 1989.85);
    assert.equal(e.fields.currency, "USD");
    assert.equal(e.fields.payee, "GEICO");
    assert.equal(e.fields.dueDate, "2026-06-30");
    assert.equal(e.urgency, "soon"); // due in 5 days
    assert.ok(e.confidence >= 0.55);
  });

  test("GEICO due within 3 days → urgency 'now' → ping with reminder + pay link", () => {
    const e = classifyLifeEventSync(
      "GEICO Policy: Your payment of $1,989.85 is due Jun 27.",
      opts,
    );
    assert.equal(e.kind, "bill");
    assert.equal(e.urgency, "now");
    const d = proactiveDecision(e, {}, NOW);
    assert.equal(d.route, "ping");
    assert.ok(d.ownerMessage.includes("GEICO"));
    assert.ok(d.ownerMessage.includes("$1,989.85"));
    assert.ok(d.ownerMessage.toLowerCase().includes("reminder"));
    assert.ok(d.ownerMessage.toLowerCase().includes("pay link"));
  });

  test("UPS → delivery with carrier + eta + tracking", () => {
    const e = classifyLifeEventSync(
      "UPS: 1Z825E7A0312345678 is out for delivery, delivering tomorrow 10:30 AM - 12:30 PM.",
      opts,
    );
    assert.equal(e.kind, "delivery");
    assert.equal(e.fields.carrier, "UPS");
    assert.match(e.fields.eta || "", /tomorrow 10:30 AM/i);
    assert.equal(e.fields.trackingNo, "1Z825E7A0312345678");
    assert.equal(e.urgency, "soon");
  });

  test("Amex Fraud Alert → fraud_alert, urgency now, callback number surfaced", () => {
    const e = classifyLifeEventSync(
      "Amex Fraud Alert: Purchase Declined. Did you make a $420 charge? Reply YES or call 1-800-528-4800.",
      opts,
    );
    assert.equal(e.kind, "fraud_alert");
    assert.equal(e.urgency, "now");
    const d = proactiveDecision(e, {}, NOW);
    assert.equal(d.route, "ping");
    assert.ok(d.ownerMessage.includes("⚠️"));
    assert.match(d.ownerMessage, /800/);
    assert.equal(d.actions[0].kind, "flag-urgent");
    assert.ok(d.actions[0].phone);
  });

  test("athenahealth → otp with code extracted, ping, no action", () => {
    const e = classifyLifeEventSync(
      "611586 is your athenahealth verification code.",
      opts,
    );
    assert.equal(e.kind, "otp");
    assert.equal(e.fields.code, "611586");
    assert.equal(e.urgency, "now");
    const d = proactiveDecision(e, {}, NOW);
    assert.equal(d.route, "ping");
    assert.ok(d.ownerMessage.includes("611586"));
    assert.equal(d.actions.length, 0);
  });

  test("BlinkRx → delivery (prescription ready to ship)", () => {
    const e = classifyLifeEventSync("BlinkRx: Your order is ready to be shipped.", opts);
    assert.equal(e.kind, "delivery");
    assert.equal(e.fields.merchant, "BlinkRx");
  });

  test("DSW promo → promo → suppress", () => {
    const e = classifyLifeEventSync(
      "DSW: Sandals. 40% off. Shop now! Reply STOP to unsubscribe.",
      opts,
    );
    assert.equal(e.kind, "promo");
    assert.equal(proactiveDecision(e, {}, NOW).route, "suppress");
  });

  test("normal human message → personal/other, NOT misclassified", () => {
    const e = classifyLifeEventSync("hey are we still on for dinner saturday? lmk", opts);
    assert.ok(["personal", "other"].includes(e.kind));
    assert.equal(isActionableKind(e.kind), false);
    assert.equal(proactiveDecision(e, {}, NOW).route, "suppress");
  });
});

describe("proactiveDecision routing", () => {
  test("fraud → ping", () => {
    const e = classifyLifeEventSync("Chase: suspicious unusual activity detected. Was this you?", opts);
    assert.equal(e.kind, "fraud_alert");
    assert.equal(proactiveDecision(e, {}, NOW).route, "ping");
  });

  test("otp → ping", () => {
    const e = classifyLifeEventSync("Your one-time code is 884213", opts);
    assert.equal(e.kind, "otp");
    assert.equal(proactiveDecision(e, {}, NOW).route, "ping");
  });

  test("delivery → digest (soon, batched)", () => {
    const e = classifyLifeEventSync("FedEx: your package shipped and is arriving Friday.", opts);
    assert.equal(e.kind, "delivery");
    assert.equal(proactiveDecision(e, {}, NOW).route, "digest");
  });

  test("far-out bill → digest", () => {
    const e = classifyLifeEventSync("AT&T: your bill of $84.20 is due Jul 30.", opts);
    assert.equal(e.kind, "bill");
    assert.equal(proactiveDecision(e, {}, NOW).route, "digest"); // ~35 days → fyi
  });

  test("promo → suppress", () => {
    const e = classifyLifeEventSync("Limited time deal! 50% off, buy now.", opts);
    assert.equal(proactiveDecision(e, {}, NOW).route, "suppress");
  });

  test("receipt → digest", () => {
    const e = classifyLifeEventSync("Amazon: Thank you for your order #112-9. Total $35.99.", opts);
    assert.equal(e.kind, "receipt");
    assert.equal(proactiveDecision(e, {}, NOW).route, "digest");
  });
});

describe("suggestedActionsFor", () => {
  test("bill → set reminder + pull pay link + snooze; pay link → payee site", () => {
    const e = classifyLifeEventSync("GEICO payment of $1,989.85 due Jun 30.", opts);
    const actions = suggestedActionsFor(e);
    assert.deepEqual(actions.map((a) => a.label), ["set reminder", "pull pay link", "snooze"]);
    const payLink = actions.find((a) => a.kind === "pay-link");
    assert.ok(payLink?.url?.includes("geico.com"));
  });

  test("delivery → add to calendar + track; track URL carries tracking no", () => {
    const e = classifyLifeEventSync("UPS: 1Z825E7A0312345678 delivering tomorrow.", opts);
    const actions = suggestedActionsFor(e);
    assert.deepEqual(actions.map((a) => a.kind), ["calendar", "track"]);
    const track = actions.find((a) => a.kind === "track");
    assert.ok(track?.url?.includes("ups.com"));
    assert.ok(track?.url?.includes("1Z825E7A0312345678"));
  });

  test("fraud → flag-urgent with phone", () => {
    const e = classifyLifeEventSync("Amex fraud alert: declined. Call 1-800-528-4800.", opts);
    const actions = suggestedActionsFor(e);
    assert.equal(actions[0].kind, "flag-urgent");
    assert.match(actions[0].phone || "", /800/);
  });

  test("otp → no actions", () => {
    const e = classifyLifeEventSync("123456 is your verification code", opts);
    assert.equal(suggestedActionsFor(e).length, 0);
  });
});

describe("owner-model-lite preference downgrade", () => {
  test("no pref → route unchanged", () => {
    assert.equal(applyPrefDowngrade("ping", undefined), "ping");
  });

  test("net 3+ ignores → one notch (ping→digest)", () => {
    assert.equal(applyPrefDowngrade("ping", { accepts: 0, ignores: 3 }), "digest");
  });

  test("net 6+ ignores → two notches (ping→suppress)", () => {
    assert.equal(applyPrefDowngrade("ping", { accepts: 0, ignores: 6 }), "suppress");
  });

  test("accepts offset ignores → no downgrade", () => {
    assert.equal(applyPrefDowngrade("ping", { accepts: 3, ignores: 4 }), "ping");
  });

  test("digest with sustained ignores → suppress", () => {
    assert.equal(applyPrefDowngrade("digest", { accepts: 0, ignores: 3 }), "suppress");
  });

  test("proactiveDecision applies the downgrade for the kind", () => {
    const e = classifyLifeEventSync("FedEx package arriving Friday.", opts);
    assert.equal(e.kind, "delivery");
    const prefs: LifeEventPrefs = { delivery: { accepts: 0, ignores: 3 } };
    assert.equal(proactiveDecision(e, prefs, NOW).route, "suppress");
  });

  test("recordAccept / recordIgnore are pure increments", () => {
    let prefs: LifeEventPrefs = {};
    prefs = recordIgnore(prefs, "bill");
    prefs = recordIgnore(prefs, "bill");
    prefs = recordAccept(prefs, "bill");
    assert.deepEqual(prefs.bill, { accepts: 1, ignores: 2 });
    assert.deepEqual(recordAccept({}, "otp"), { otp: { accepts: 1, ignores: 0 } });
  });
});

describe("LLM fallback (injected hook)", () => {
  test("ambiguous text consults the LLM and uses its verdict", async () => {
    const e = await classifyLifeEvent("re: the thing from earlier", {
      ...opts,
      llmCall: async () => ({ kind: "bill", confidence: 0.7, urgency: "soon", fields: { amount: 50, currency: "USD" } }),
    });
    assert.equal(e.kind, "bill");
    assert.equal(e.fields.amount, 50);
  });

  test("rules-confident text does NOT consult the LLM", async () => {
    let called = false;
    const e = await classifyLifeEvent("GEICO payment of $1,989.85 due Jun 30.", {
      ...opts,
      llmCall: async () => { called = true; return { kind: "promo" }; },
    });
    assert.equal(called, false);
    assert.equal(e.kind, "bill");
  });

  test("LLM throwing falls back to rules verdict", async () => {
    const e = await classifyLifeEvent("re: the thing", {
      ...opts,
      llmCall: async () => { throw new Error("boom"); },
    });
    assert.ok(["personal", "other"].includes(e.kind));
  });
});

describe("self-chat prefixes", () => {
  test("ping owner messages start with a registered prefix", () => {
    const cases = [
      "GEICO payment of $1,989.85 due Jun 27.",
      "611586 is your verification code",
      "Amex fraud alert: declined. Call 1-800-528-4800.",
    ];
    for (const text of cases) {
      const d = proactiveDecision(classifyLifeEventSync(text, opts), {}, NOW);
      const matched = LIFE_EVENT_SELF_PREFIXES.some((p) => d.ownerMessage.startsWith(p.trim()));
      assert.ok(matched, `"${d.ownerMessage}" should match a registered self-prefix`);
    }
  });

  test("every life-event self-prefix is recognized by isBotSelfMessage (no echo loop)", () => {
    for (const p of LIFE_EVENT_SELF_PREFIXES) {
      assert.ok(
        isBotSelfMessage(p + "test surface line"),
        `bot-self.ts BOT_SELF_PREFIXES missing life-event prefix "${p}"`,
      );
    }
  });

  test("real ping messages are caught by the bot-self guard", () => {
    const cases = [
      "GEICO payment of $1,989.85 due Jun 27.",
      "611586 is your verification code",
      "Amex fraud alert: declined. Call 1-800-528-4800.",
    ];
    for (const text of cases) {
      const d = proactiveDecision(classifyLifeEventSync(text, opts), {}, NOW);
      assert.ok(isBotSelfMessage(d.ownerMessage), `ping "${d.ownerMessage}" must be bot-self`);
    }
  });
});
