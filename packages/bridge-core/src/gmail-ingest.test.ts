// Tests for GMAIL INGESTION — the email poller that feeds the OWNER's mailbox
// into the SAME channel-agnostic life-event engine the texts use.
//
// The bar:
//   * dedup: a message id is processed AT MOST once, across ticks + restarts.
//   * state roundtrip: last-seen high-water mark + bounded dedup set persist and
//     reload from a tmp 0600 file.
//   * classification: a BILL email and a DELIVERY email (From/Subject/snippet
//     shape) classify to the right typed life-event, with fields extracted.
//   * cross-channel idempotency: a UPS *email* and a UPS *SMS* for the SAME
//     tracking number hash to ONE acted key — so the package is auto-acted once,
//     not once per channel.
//   * expired-token (401) is detected as auth_expired, NOT a generic error, and
//     does NOT advance state.
//
// No live Gmail / LLM — the connector call is mocked, state goes to tmpdir.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pollGmailOnce,
  loadPollState,
  savePollState,
  buildPollQuery,
  normalizeMessage,
  emailToLifeEventText,
  isAuthExpiredError,
  type GmailConnectorExecute,
  type GmailPollState,
} from "./gmail-ingest.ts";
import {
  classifyLifeEventSync,
  idempotencyKeyFor,
  isActionableKind,
} from "./life-events.ts";

const NOW = new Date("2026-06-25T12:00:00Z");

// A mock connector that returns a canned `list_recent` response. Records the
// queries it was asked with so we can assert the high-water query advances.
function mockExecute(messages: unknown[], opts: { error?: string; throw?: boolean } = {}): {
  execute: GmailConnectorExecute;
  calls: Array<{ action: string; params: Record<string, string | number> }>;
} {
  const calls: Array<{ action: string; params: Record<string, string | number> }> = [];
  const execute: GmailConnectorExecute = async (_connectorId, action, params) => {
    calls.push({ action, params });
    if (opts.throw) throw new Error("network down");
    if (opts.error) return { error: opts.error };
    return { messages, count: messages.length, source: "api" };
  };
  return { execute, calls };
}

function email(id: string, internalDate: string, from: string, subject: string, snippet: string) {
  return { id, internalDate, from, subject, snippet };
}

describe("gmail-ingest: state roundtrip", () => {
  test("save then load preserves high-water mark + seen ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-state-"));
    const path = join(dir, "gmail-poll-state.json");
    try {
      const state: GmailPollState = { lastInternalDate: "1719316800000", seenIds: ["a", "b", "c"] };
      savePollState(state, path);
      assert.ok(existsSync(path));
      // 0600 — owner-only (it lists subjects/senders of the owner's mail).
      const mode = statSync(path).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
      const loaded = loadPollState(path);
      assert.equal(loaded.lastInternalDate, "1719316800000");
      assert.deepEqual(loaded.seenIds, ["a", "b", "c"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file loads empty state", () => {
    const loaded = loadPollState(join(tmpdir(), "does-not-exist-gmail.json"));
    assert.deepEqual(loaded, { seenIds: [] });
  });

  test("buildPollQuery: first run uses window, later uses after:<epoch-1s>", () => {
    assert.equal(buildPollQuery({ seenIds: [] }), "newer_than:1d");
    // 1719316800000 ms → 1719316800 s, minus 1 = 1719316799
    assert.equal(buildPollQuery({ lastInternalDate: "1719316800000", seenIds: [] }), "after:1719316799");
  });
});

describe("gmail-ingest: dedup", () => {
  test("a message id is processed at most once across ticks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-dedup-"));
    const path = join(dir, "state.json");
    try {
      const msgs = [
        email("m1", "1719316800000", "GEICO <noreply@geico.com>", "Your payment is due", "Amount due $182.40 due Jul 2"),
        email("m2", "1719316900000", "UPS <mcinfo@ups.com>", "Your package is out for delivery", "UPS out for delivery tomorrow 10:30 AM - 12:30 PM 1Z999AA10123456784"),
      ];
      const { execute } = mockExecute(msgs);

      // Tick 1: both are new.
      const r1 = await pollGmailOnce(execute, { statePath: path });
      assert.equal(r1.status, "ok");
      assert.equal(r1.newMessages.length, 2);

      // Tick 2: same connector returns the same messages — none should be new.
      const r2 = await pollGmailOnce(execute, { statePath: path });
      assert.equal(r2.status, "ok");
      assert.equal(r2.newMessages.length, 0, "already-seen ids must not re-process");

      // State persisted both ids + the max internalDate.
      const persisted = loadPollState(path);
      assert.deepEqual(persisted.seenIds.sort(), ["m1", "m2"]);
      assert.equal(persisted.lastInternalDate, "1719316900000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a brand-new id arriving later IS processed; the high-water query advances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-new-"));
    const path = join(dir, "state.json");
    try {
      const first = mockExecute([email("m1", "1719316800000", "a@b.com", "hi", "Amount due $10 due Jul 5")]);
      const r1 = await pollGmailOnce(first.execute, { statePath: path });
      assert.equal(r1.newMessages.length, 1);
      assert.equal(first.calls[0].params.query, "newer_than:1d");

      const second = mockExecute([
        email("m1", "1719316800000", "a@b.com", "hi", "Amount due $10 due Jul 5"), // dup
        email("m2", "1719320400000", "c@d.com", "FedEx shipped", "Your FedEx package shipped, arriving Friday"),
      ]);
      const r2 = await pollGmailOnce(second.execute, { statePath: path });
      assert.equal(r2.newMessages.length, 1);
      assert.equal(r2.newMessages[0].message.id, "m2");
      // The second tick used the after:<epoch> high-water query, not the window.
      assert.match(String(second.calls[0].params.query), /^after:\d+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gmail-ingest: classification of email shapes", () => {
  test("a BILL email classifies to kind=bill with amount + payee", () => {
    const msg = normalizeMessage(
      email("e1", "1719316800000", "GEICO <noreply@geico.com>", "Your auto policy payment is due", "Your payment of $182.40 is due Jul 2. Autopay is on."),
    )!;
    const text = emailToLifeEventText(msg);
    assert.match(text, /^From: GEICO/);
    const ev = classifyLifeEventSync(text, { channel: "email", now: NOW });
    assert.equal(ev.kind, "bill");
    assert.equal(ev.channel, "email");
    assert.equal(ev.fields.amount, 182.4);
    assert.equal(ev.fields.payee, "GEICO");
    assert.ok(isActionableKind(ev.kind));
  });

  test("a DELIVERY email classifies to kind=delivery with carrier + tracking", () => {
    const msg = normalizeMessage(
      email("e2", "1719316900000", "UPS <mcinfo@ups.com>", "Your package is out for delivery", "UPS: out for delivery, tomorrow 10:30 AM - 12:30 PM. Tracking 1Z999AA10123456784"),
    )!;
    const ev = classifyLifeEventSync(emailToLifeEventText(msg), { channel: "email", now: NOW });
    assert.equal(ev.kind, "delivery");
    assert.equal(ev.fields.carrier, "UPS");
    assert.equal(ev.fields.trackingNo, "1Z999AA10123456784");
  });
});

describe("gmail-ingest: cross-channel idempotency", () => {
  test("a UPS email + a UPS SMS for the SAME tracking number → ONE acted key", () => {
    // Same package, two channels, different verbatim text.
    const emailEv = classifyLifeEventSync(
      emailToLifeEventText(
        normalizeMessage(email("e3", "1719316900000", "UPS <auto@ups.com>", "Out for delivery", "Your UPS package 1Z999AA10123456784 is out for delivery tomorrow"))!,
      ),
      { channel: "email", now: NOW },
    );
    const smsEv = classifyLifeEventSync(
      "UPS: Your package 1Z999AA10123456784 is out for delivery and will arrive tomorrow 10:30 AM - 12:30 PM",
      { channel: "iMessage", now: NOW },
    );

    assert.equal(emailEv.kind, "delivery");
    assert.equal(smsEv.kind, "delivery");
    // The idempotency key keys off carrier+tracking, NOT channel → identical.
    assert.equal(idempotencyKeyFor(emailEv), idempotencyKeyFor(smsEv));
  });

  test("a DIFFERENT package gets a DIFFERENT key", () => {
    const a = classifyLifeEventSync("UPS package 1Z999AA10123456784 out for delivery tomorrow", { channel: "email", now: NOW });
    const b = classifyLifeEventSync("UPS package 1Z111BB22233344455 out for delivery tomorrow", { channel: "iMessage", now: NOW });
    assert.notEqual(idempotencyKeyFor(a), idempotencyKeyFor(b));
  });
});

describe("gmail-ingest: expired token + errors", () => {
  test("isAuthExpiredError detects 401 / invalid credentials / missing oauth", () => {
    assert.ok(isAuthExpiredError("Gmail API error 401: Invalid Credentials"));
    assert.ok(isAuthExpiredError("list_recent requires an OAuth access token (re-auth Google)"));
    assert.ok(!isAuthExpiredError("Gmail API error 500: backend error"));
  });

  test("a 401 connector error returns auth_expired and does NOT advance state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-401-"));
    const path = join(dir, "state.json");
    try {
      const { execute } = mockExecute([], { error: "Gmail list_recent failed: Gmail API error 401: Invalid Credentials" });
      const r = await pollGmailOnce(execute, { statePath: path });
      assert.equal(r.status, "auth_expired");
      assert.equal(r.newMessages.length, 0);
      // No state file written — the high-water mark must not move on a failed poll.
      assert.ok(!existsSync(path), "state must not be written on auth failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a transport throw returns error, not a crash", async () => {
    const { execute } = mockExecute([], { throw: true });
    const r = await pollGmailOnce(execute, { persist: false, state: { seenIds: [] } });
    assert.equal(r.status, "error");
    assert.match(String(r.error), /network down/);
  });

  test("a null connector result (transport error) returns error", async () => {
    const execute: GmailConnectorExecute = async () => null;
    const r = await pollGmailOnce(execute, { persist: false, state: { seenIds: [] } });
    assert.equal(r.status, "error");
  });
});
