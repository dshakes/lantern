// Tests for the AUTO-ACT LADDER built on the LIFE-EVENT ENGINE.
//
// The bar:
//   * autoActDecision returns 'auto' for the safe-reversible kinds (delivery,
//     appointment, travel) by default — and NEVER 'auto' for money (bill),
//     judgment (fraud_alert), secrets (otp), or fyi (receipt/promo).
//   * the idempotencyKey is STABLE for the same package across repeated/varied
//     carrier updates, and DIFFERENT for a different package — so repeated UPS
//     updates never double-book.
//   * the trust ladder downgrades auto → suggest → none after enough undos.
//   * the kill switch (enabled:false) forces suggest, never auto.
//   * the idempotency STORE (hasActed/markActed) round-trips + is bounded.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyLifeEventSync,
  autoActDecision,
  idempotencyKeyFor,
  eventStartIso,
  type LifeEventPrefs,
  type LifeEvent,
} from "./life-events.ts";
import {
  hasActed,
  markActed,
  unmarkActed,
  isAutoActPaused,
  setAutoActPaused,
} from "./life-events-store.ts";
import { parseNLCommand } from "./nl-commands.ts";
import { looksLikeUndo, looksLikeRejection } from "./humanize.ts";
import { isBotSelfMessage } from "./bot-self.ts";

const NOW = new Date("2026-06-25T12:00:00Z");
const opts = { now: NOW, channel: "iMessage" as const };

// Build a delivery LifeEvent straight from carrier-update text.
function delivery(text: string): LifeEvent {
  return classifyLifeEventSync(text, opts);
}

describe("autoActDecision — SAFE-AUTO matrix", () => {
  test("delivery → auto (default-on, trusted)", () => {
    const e = delivery("UPS: Your package 1Z999AA10123456784 is out for delivery, arriving tomorrow 10:30 AM - 12:30 PM.");
    assert.equal(e.kind, "delivery");
    const d = autoActDecision(e, {});
    assert.equal(d.mode, "auto");
    assert.ok(d.action, "auto carries an action");
    assert.ok(d.idempotencyKey.startsWith("lev_delivery_"));
  });

  test("appointment → auto", () => {
    const e = classifyLifeEventSync("Reminder: your appointment is confirmed for tomorrow 3:00 PM at the dental office.", opts);
    assert.equal(e.kind, "appointment");
    assert.equal(autoActDecision(e, {}).mode, "auto");
  });

  test("travel → auto", () => {
    const e = classifyLifeEventSync("Your flight AA123 departure is tomorrow 6:10 PM from gate 22, seat 14C.", opts);
    assert.equal(e.kind, "travel");
    assert.equal(autoActDecision(e, {}).mode, "auto");
  });

  test("bill (money) → NEVER auto — suggest", () => {
    const e = classifyLifeEventSync("GEICO Policy: Your payment of $1,989.85 is due Jun 30.", opts);
    assert.equal(e.kind, "bill");
    const d = autoActDecision(e, {});
    assert.equal(d.mode, "suggest");
    assert.notEqual(d.mode, "auto");
  });

  test("fraud_alert (judgment) → NEVER auto — suggest", () => {
    const e = classifyLifeEventSync("Amex: We declined a suspicious charge of $420. Was this you?", opts);
    assert.equal(e.kind, "fraud_alert");
    const d = autoActDecision(e, {});
    assert.equal(d.mode, "suggest");
    assert.notEqual(d.mode, "auto");
  });

  test("otp (secret) → NEVER auto — surface only (suggest/none, not auto)", () => {
    const e = classifyLifeEventSync("Your verification code is 611586. Do not share it.", opts);
    assert.equal(e.kind, "otp");
    const d = autoActDecision(e, {});
    assert.notEqual(d.mode, "auto");
  });

  test("receipt (fyi) → NEVER auto", () => {
    const e = classifyLifeEventSync("Amazon: Thank you for your order. Order #112-3334445.", opts);
    assert.equal(e.kind, "receipt");
    assert.notEqual(autoActDecision(e, {}).mode, "auto");
  });

  test("promo → none, never auto", () => {
    const e = classifyLifeEventSync("DSW: 30% off sale! Shop now. Limited time. Reply STOP to unsubscribe.", opts);
    assert.equal(e.kind, "promo");
    const d = autoActDecision(e, {});
    assert.equal(d.mode, "none");
  });

  test("EXHAUSTIVE: money/fraud/otp/receipt/promo/personal/other are NEVER auto", () => {
    const cases = [
      "GEICO Policy: Your payment of $1,989.85 is due Jun 30.",          // bill
      "Amex: We declined a suspicious charge. Was this you?",            // fraud
      "Your one-time passcode is 224488.",                              // otp
      "Thank you for your order. Order #998.",                          // receipt
      "Macy's: 40% off clearance — shop now! unsubscribe",             // promo
      "hey are you free for lunch?",                                    // personal
      "ok",                                                            // other
    ];
    for (const text of cases) {
      const e = classifyLifeEventSync(text, opts);
      assert.notEqual(autoActDecision(e, {}).mode, "auto", `must not auto: "${text}" (${e.kind})`);
    }
  });
});

describe("autoActDecision — kill switch", () => {
  test("enabled:false → safe kinds become suggest, never auto", () => {
    const e = delivery("FedEx: package 770123456789 out for delivery tomorrow 2:00 PM.");
    assert.equal(autoActDecision(e, {}, { enabled: true }).mode, "auto");
    assert.equal(autoActDecision(e, {}, { enabled: false }).mode, "suggest");
  });

  test("default (no opts) is enabled — owner asked for on-by-default", () => {
    const e = delivery("UPS: 1Z999AA10123456784 arriving tomorrow 9:00 AM.");
    assert.equal(autoActDecision(e).mode, "auto");
  });
});

describe("autoActDecision — earned-trust downgrade", () => {
  test("net autoUndo >= 2 → downgrade auto → suggest", () => {
    const e = delivery("UPS: 1Z999AA10123456784 out for delivery tomorrow 10:00 AM.");
    const prefs: LifeEventPrefs = { delivery: { accepts: 0, ignores: 0, autoUndo: 2 } };
    assert.equal(autoActDecision(e, prefs).mode, "suggest");
  });

  test("net autoUndo >= 4 → suggest → none (silenced)", () => {
    const e = delivery("UPS: 1Z999AA10123456784 out for delivery tomorrow 10:00 AM.");
    const prefs: LifeEventPrefs = { delivery: { accepts: 0, ignores: 0, autoUndo: 4 } };
    assert.equal(autoActDecision(e, prefs).mode, "none");
  });

  test("auto-accepts offset undos — trust restored", () => {
    const e = delivery("UPS: 1Z999AA10123456784 out for delivery tomorrow 10:00 AM.");
    // 3 undos but 3 auto-accepts → net 0 → still auto.
    const prefs: LifeEventPrefs = { delivery: { accepts: 0, ignores: 0, autoUndo: 3, autoAccept: 3 } };
    assert.equal(autoActDecision(e, prefs).mode, "auto");
  });

  test("one undo (net 1) is tolerated — still auto", () => {
    const e = delivery("UPS: 1Z999AA10123456784 out for delivery tomorrow 10:00 AM.");
    const prefs: LifeEventPrefs = { delivery: { accepts: 0, ignores: 0, autoUndo: 1 } };
    assert.equal(autoActDecision(e, prefs).mode, "auto");
  });
});

describe("idempotencyKeyFor — repeated UPS updates do NOT double-book", () => {
  test("same package across shipped → out-for-delivery → delivered → ONE key", () => {
    const shipped = delivery("UPS: Your package 1Z999AA10123456784 has shipped.");
    const out = delivery("UPS: 1Z999AA10123456784 is out for delivery, arriving tomorrow 10:30 AM.");
    const delivered = delivery("UPS: Your package 1Z999AA10123456784 was delivered.");
    const k1 = idempotencyKeyFor(shipped);
    const k2 = idempotencyKeyFor(out);
    const k3 = idempotencyKeyFor(delivered);
    assert.equal(k1, k2, "shipped == out-for-delivery key (same tracking #)");
    assert.equal(k2, k3, "out-for-delivery == delivered key (same tracking #)");
  });

  test("a DIFFERENT package gets a DIFFERENT key", () => {
    const a = delivery("UPS: 1Z999AA10123456784 out for delivery tomorrow.");
    const b = delivery("UPS: 1Z888BB20987654321 out for delivery tomorrow.");
    assert.notEqual(idempotencyKeyFor(a), idempotencyKeyFor(b));
  });

  test("key stable regardless of whitespace / case formatting drift", () => {
    const a = delivery("UPS:   1Z999AA10123456784  OUT  FOR  DELIVERY");
    const b = delivery("UPS: 1Z999AA10123456784 out for delivery");
    assert.equal(idempotencyKeyFor(a), idempotencyKeyFor(b));
  });

  test("appointment key combines place + time + dueDate", () => {
    const e = classifyLifeEventSync("Appointment confirmed for tomorrow 3:00 PM.", opts);
    const k = idempotencyKeyFor(e);
    assert.ok(k.startsWith("lev_appointment_"));
    // Stable across two classifications of the same text.
    assert.equal(k, idempotencyKeyFor(classifyLifeEventSync("Appointment confirmed for tomorrow 3:00 PM.", opts)));
  });
});

describe("eventStartIso — deterministic calendar datetime (no LLM)", () => {
  test("tomorrow + time → concrete local ISO", () => {
    const e = classifyLifeEventSync("Appointment confirmed tomorrow 3:00 PM.", opts);
    const iso = eventStartIso(e, new Date("2026-06-25T12:00:00"));
    assert.ok(iso && /^2026-06-26T15:00:00$/.test(iso), `got ${iso}`);
  });

  test("vague (no time) → undefined → bridge falls back to suggest", () => {
    const e = classifyLifeEventSync("You're booked with Dr. Lee soon.", opts);
    assert.equal(eventStartIso(e, NOW), undefined);
  });
});

describe("idempotency store — hasActed / markActed round-trip + bounded", () => {
  function withTempActed<T>(fn: (path: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "lev-acted-"));
    const path = join(dir, "acted.json");
    try {
      return fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("markActed then hasActed → true; unknown key → false", () => {
    withTempActed((path) => {
      assert.equal(hasActed("lev_delivery_abc", path), false);
      assert.equal(markActed("lev_delivery_abc", path), true);
      assert.equal(hasActed("lev_delivery_abc", path), true);
    });
  });

  test("markActed is idempotent — second call returns false, no duplicate", () => {
    withTempActed((path) => {
      assert.equal(markActed("k1", path), true);
      assert.equal(markActed("k1", path), false);
    });
  });

  test("unmarkActed lets a key be re-acted later", () => {
    withTempActed((path) => {
      markActed("k1", path);
      unmarkActed("k1", path);
      assert.equal(hasActed("k1", path), false);
      assert.equal(markActed("k1", path), true);
    });
  });

  test("bounded — oldest keys roll off after the cap (500)", () => {
    withTempActed((path) => {
      for (let i = 0; i < 520; i++) markActed(`k${i}`, path);
      // The earliest 20 should have rolled off; the latest are retained.
      assert.equal(hasActed("k0", path), false, "oldest rolled off");
      assert.equal(hasActed("k519", path), true, "newest retained");
    });
  });

  test("empty key is a no-op", () => {
    withTempActed((path) => {
      assert.equal(markActed("", path), false);
      assert.equal(hasActed("", path), false);
    });
  });
});

describe("auto-act pause flag — persists across reads", () => {
  function withTempState<T>(fn: (path: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "lev-state-"));
    const path = join(dir, "autoact.json");
    try {
      return fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("default (absent file) → not paused", () => {
    withTempState((path) => assert.equal(isAutoActPaused(path), false));
  });

  test("setAutoActPaused(true) → isAutoActPaused true; resume → false", () => {
    withTempState((path) => {
      setAutoActPaused(true, path);
      assert.equal(isAutoActPaused(path), true);
      setAutoActPaused(false, path);
      assert.equal(isAutoActPaused(path), false);
    });
  });
});

describe("owner controls — pause/resume automation NL commands", () => {
  test("'pause automation' → autoact-off (not a plain mute)", () => {
    assert.equal(parseNLCommand("pause automation")?.action, "autoact-off");
    assert.equal(parseNLCommand("stop auto")?.action, "autoact-off");
    assert.equal(parseNLCommand("turn off automation")?.action, "autoact-off");
  });

  test("'resume automation' → autoact-on", () => {
    assert.equal(parseNLCommand("resume automation")?.action, "autoact-on");
    assert.equal(parseNLCommand("turn on automation")?.action, "autoact-on");
  });

  test("'what did you do today' → autoact-recap", () => {
    assert.equal(parseNLCommand("what did you do today")?.action, "autoact-recap");
  });

  test("bare 'pause' still mutes (automation toggle requires the word)", () => {
    assert.equal(parseNLCommand("pause")?.action, "mute");
  });
});

describe("undo detection + bot-self registration", () => {
  test("looksLikeUndo fires on undo/remove/take it off, not on chat", () => {
    assert.ok(looksLikeUndo("undo"));
    assert.ok(looksLikeUndo("remove it"));
    assert.ok(looksLikeUndo("take it off"));
    assert.ok(!looksLikeUndo("let's undo our lunch plans next week sometime maybe"));
  });

  test("plain 'no' still reverts an auto-act-undo offer (rejection path)", () => {
    assert.ok(looksLikeRejection("no"));
  });

  test("auto-act self-chat log lines are recognized as bot-self (no self-reply loop)", () => {
    assert.ok(isBotSelfMessage("📅 added to your calendar — Appointment Jun 26, 3:00 PM · reply 'undo' to remove"));
    assert.ok(isBotSelfMessage("📦 logged delivery — UPS tomorrow 10:30 am (Deliveries note) · reply 'undo' to remove"));
    assert.ok(isBotSelfMessage("↩️ undone — removed it."));
    assert.ok(isBotSelfMessage("🤖 today i auto-handled 2:"));
  });
});
