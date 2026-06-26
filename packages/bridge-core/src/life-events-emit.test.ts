// Tests for life-events-emit.ts.
//
// Contracts verified:
//   1. 'suggested'  → correct payload shape for a ping/digest event.
//   2. 'auto_acted' → carries actionTaken + idempotencyKey.
//   3. 'undone'     → carries idempotencyKey, no actionTaken.
//   4. Poster failure (network throw) → swallowed, no rethrow.
//   5. Poster non-2xx → swallowed, no rethrow.
//   6. Fields are mapped correctly (amount, carrier, code, etc.).
//   7. sourcePreview is truncated to 200 chars.
//   8. channel is preserved from the LifeEvent.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { emitLifeEvent, type LifeEventPayload, type LifeEventPoster } from "./life-events-emit.ts";
import { classifyLifeEventSync } from "./life-events.ts";

const NOW = new Date("2026-06-25T12:00:00Z");

// Capture the last payload posted without hitting the network.
function mockPoster(
  store: { calls: Array<{ path: string; payload: LifeEventPayload }> },
  opts: { ok?: boolean; throw?: boolean } = {},
): LifeEventPoster {
  return async (path, init) => {
    if (opts.throw) throw new Error("network error");
    const payload = JSON.parse(init?.body ?? "{}") as LifeEventPayload;
    store.calls.push({ path, payload });
    return { ok: opts.ok ?? true, status: opts.ok === false ? 500 : 200 };
  };
}

describe("emitLifeEvent — payload shape", () => {
  test("suggested: correct kind/status/summary/idempotencyKey/fields", async () => {
    const event = classifyLifeEventSync(
      "UPS: 1Z825E7A0312345678 is out for delivery, arriving tomorrow 10:30 AM - 12:30 PM.",
      { now: NOW, channel: "iMessage" },
    );
    const store: { calls: Array<{ path: string; payload: LifeEventPayload }> } = { calls: [] };
    const poster = mockPoster(store);

    await emitLifeEvent(event, "suggested", {
      idempotencyKey: "lev_delivery_abc12345",
      summary: "📦 UPS — tomorrow 10:30 AM - 12:30 PM. want it on your calendar?",
      poster,
    });

    assert.equal(store.calls.length, 1);
    const { path, payload } = store.calls[0];
    assert.equal(path, "/v1/life-events");
    assert.equal(payload.kind, "delivery");
    assert.equal(payload.status, "suggested");
    assert.equal(payload.channel, "iMessage");
    assert.equal(payload.urgency, "soon");
    assert.equal(payload.idempotencyKey, "lev_delivery_abc12345");
    assert.ok(payload.summary.includes("UPS"));
    assert.equal(payload.fields.carrier, "UPS");
    assert.equal(payload.fields.trackingNo, "1Z825E7A0312345678");
    assert.ok(!payload.actionTaken, "suggested has no actionTaken");
    assert.ok((payload.sourcePreview ?? "").length > 0, "sourcePreview populated");
  });

  test("auto_acted: carries actionTaken", async () => {
    const event = classifyLifeEventSync(
      "UPS: 1Z825E7A0312345678 is out for delivery, arriving tomorrow 10:30 AM.",
      { now: NOW, channel: "WhatsApp" },
    );
    const store: { calls: Array<{ path: string; payload: LifeEventPayload }> } = { calls: [] };
    await emitLifeEvent(event, "auto_acted", {
      idempotencyKey: "lev_delivery_abc12345",
      actionTaken: "logged in Deliveries note",
      summary: "📦 logged delivery — UPS tomorrow 10:30 am (Deliveries note) · reply 'undo' to remove",
      poster: mockPoster(store),
    });

    const { payload } = store.calls[0];
    assert.equal(payload.status, "auto_acted");
    assert.equal(payload.channel, "WhatsApp");
    assert.equal(payload.actionTaken, "logged in Deliveries note");
    assert.equal(payload.idempotencyKey, "lev_delivery_abc12345");
  });

  test("undone: carries idempotencyKey, no actionTaken", async () => {
    const event = classifyLifeEventSync(
      "Reminder: appointment tomorrow 3:00 PM",
      { now: NOW, channel: "iMessage" },
    );
    const store: { calls: Array<{ path: string; payload: LifeEventPayload }> } = { calls: [] };
    await emitLifeEvent(event, "undone", {
      idempotencyKey: "lev_appointment_def45678",
      summary: "↩️ undone — removed it.",
      poster: mockPoster(store),
    });

    const { payload } = store.calls[0];
    assert.equal(payload.status, "undone");
    assert.equal(payload.idempotencyKey, "lev_appointment_def45678");
    assert.ok(!payload.actionTaken, "undone has no actionTaken");
  });

  test("bill fields: amount, currency, dueDate, payee", async () => {
    const event = classifyLifeEventSync(
      "GEICO Policy: Your payment of $1,989.85 for policy 1234 is due Jun 30.",
      { now: NOW, channel: "iMessage" },
    );
    const store: { calls: Array<{ path: string; payload: LifeEventPayload }> } = { calls: [] };
    await emitLifeEvent(event, "suggested", {
      summary: "💸 GEICO $1,989.85 due Jun 30. reminder + pay link?",
      poster: mockPoster(store),
    });

    const { payload } = store.calls[0];
    assert.equal(payload.kind, "bill");
    assert.equal(payload.fields.amount, 1989.85);
    assert.equal(payload.fields.currency, "USD");
    assert.equal(payload.fields.payee, "GEICO");
    assert.equal(payload.fields.dueDate, "2026-06-30");
  });

  test("otp fields: code extracted", async () => {
    const event = classifyLifeEventSync(
      "611586 is your athenahealth verification code.",
      { now: NOW, channel: "WhatsApp" },
    );
    const store: { calls: Array<{ path: string; payload: LifeEventPayload }> } = { calls: [] };
    await emitLifeEvent(event, "suggested", {
      summary: "🔑 your code is 611586",
      poster: mockPoster(store),
    });

    const { payload } = store.calls[0];
    assert.equal(payload.kind, "otp");
    assert.equal(payload.fields.code, "611586");
  });

  test("sourcePreview truncated to 200 chars", async () => {
    const longText = "A".repeat(300);
    const event = classifyLifeEventSync(longText, { now: NOW, channel: "iMessage" });
    const store: { calls: Array<{ path: string; payload: LifeEventPayload }> } = { calls: [] };
    await emitLifeEvent(event, "suggested", {
      summary: "test",
      poster: mockPoster(store),
    });
    const preview = store.calls[0]?.payload.sourcePreview ?? "";
    assert.ok(preview.length <= 200, `sourcePreview too long: ${preview.length}`);
  });
});

describe("emitLifeEvent — failure is non-fatal", () => {
  test("poster throws (network error) → does NOT rethrow", async () => {
    const event = classifyLifeEventSync(
      "UPS: package arriving tomorrow.",
      { now: NOW, channel: "iMessage" },
    );
    // This must NOT throw — the test itself is the assertion.
    await assert.doesNotReject(
      emitLifeEvent(event, "suggested", {
        summary: "📦 UPS",
        poster: mockPoster({ calls: [] }, { throw: true }),
      }),
    );
  });

  test("poster returns non-2xx → does NOT throw", async () => {
    const event = classifyLifeEventSync(
      "GEICO payment of $1,989.85 due Jun 30.",
      { now: NOW, channel: "iMessage" },
    );
    await assert.doesNotReject(
      emitLifeEvent(event, "suggested", {
        summary: "💸 GEICO",
        poster: mockPoster({ calls: [] }, { ok: false }),
      }),
    );
  });

  test("logger is optional — no crash when omitted", async () => {
    const event = classifyLifeEventSync(
      "UPS: package out for delivery.",
      { now: NOW, channel: "WhatsApp" },
    );
    // poster throws, no logger provided — must not crash
    await assert.doesNotReject(
      emitLifeEvent(event, "suggested", {
        summary: "📦 UPS",
        poster: mockPoster({ calls: [] }, { throw: true }),
        // log intentionally omitted
      }),
    );
  });
});
