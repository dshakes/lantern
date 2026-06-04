// Regression tests for profile-derived timezone (single source of truth).
//   cd packages/bridge-core && npx tsx --test src/owner-profile-timezone.test.ts
//
// The bot's timezone (quiet hours, digests, calendar, pacing) drifted from
// what the owner wrote in "## My world" (Chantilly, VA /EST) because the
// env was the only source and was wrong/unset. The profile is now
// authoritative: parseProfile derives an IANA zone, and the store mirrors
// it into LANTERN_OWNER_TIMEZONE when the operator didn't pin one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { parseTimezone, parseProfile, OwnerProfileStore } from "./owner-profile.js";

const logger = pino({ level: "silent" });

// ── parseTimezone ──

test("parseTimezone: the reported case — 'Chantilly, VA /EST' → Eastern", () => {
  assert.equal(parseTimezone("Chantilly, VA /EST"), "America/New_York");
});

test("parseTimezone: zone words + abbreviations", () => {
  assert.equal(parseTimezone("Austin, TX — Central time"), "America/Chicago");
  assert.equal(parseTimezone("SF, PST"), "America/Los_Angeles");
  assert.equal(parseTimezone("Denver MST"), "America/Denver");
  assert.equal(parseTimezone("Hyderabad, IST"), "Asia/Kolkata");
});

test("parseTimezone: explicit IANA zone wins verbatim", () => {
  assert.equal(parseTimezone("based in Asia/Kolkata these days"), "Asia/Kolkata");
});

test("parseTimezone: no recognizable token → empty (safe)", () => {
  assert.equal(parseTimezone("Chantilly, Virginia"), "");
  assert.equal(parseTimezone(""), "");
  // Must NOT false-match inside ordinary words ("best"/"crest" ≠ EST).
  assert.equal(parseTimezone("the best coast"), "");
});

// ── parseProfile: My world wins over nativity ──

test("parseProfile: timezone derived from '## My world', not nativity origin", () => {
  const raw = [
    "# Owner profile",
    "## My world",
    "- Chantilly, VA /EST",
    "## Nativity",
    "- From Karimnagar, Telangana, India",
  ].join("\n");
  const p = parseProfile(raw);
  assert.equal(p.timezone, "America/New_York", "should use VA/EST residence, not India origin");
});

// ── Store: mirrors into env when operator didn't pin one ──

function writeProfile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lantern-tz-"));
  const path = join(dir, "owner-profile.md");
  writeFileSync(path, body);
  return path;
}

test("store.timezone() exposes the parsed zone", () => {
  const path = writeProfile("# Owner profile\n## My world\n- Chantilly, VA /EST\n");
  const store = new OwnerProfileStore(logger, path);
  assert.equal(store.timezone(), "America/New_York");
});

test("store mirrors profile timezone into LANTERN_OWNER_TIMEZONE when env unset", () => {
  // NOTE: OWNER_TZ_ENV_EXPLICIT is captured at module import; this process
  // imported with the env unset, so the mirror path is active here.
  const before = process.env.LANTERN_OWNER_TIMEZONE;
  delete process.env.LANTERN_OWNER_TIMEZONE;
  try {
    const path = writeProfile("# Owner profile\n## My world\n- Chantilly, VA /EST\n");
    const store = new OwnerProfileStore(logger, path);
    store.get(); // triggers parse + mirror
    assert.equal(process.env.LANTERN_OWNER_TIMEZONE, "America/New_York");
  } finally {
    if (before === undefined) delete process.env.LANTERN_OWNER_TIMEZONE;
    else process.env.LANTERN_OWNER_TIMEZONE = before;
  }
});
