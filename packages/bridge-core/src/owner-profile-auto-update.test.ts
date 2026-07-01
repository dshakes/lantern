// Regression tests for the owner-profile auto-updater's typed routing.
//   cd packages/bridge-core && npx tsx --test src/owner-profile-auto-update.test.ts
//
// The bot told a contact "I'm not even married" because it had no
// structured owner facts, and "don't call Sujith bava" was never
// persisted. These cover the two typed routes: owner-facts → ## Facts,
// per-contact naming rules → ## Relationships line.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  maybeAutoUpdateOwnerProfile,
  applyConfirmedOwnerFacts,
  formatFactConfirmPrompt,
} from "./owner-profile-auto-update.ts";
import { parseProfile } from "./owner-profile.ts";

function tmpProfile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-update-"));
  const path = join(dir, "owner-profile.md");
  writeFileSync(path, content, "utf8");
  return path;
}

// A stub llmCall that returns a fixed JSON payload.
function stubLLM(payload: unknown): (p: string) => Promise<string> {
  return async () => JSON.stringify(payload);
}

test("owner-fact: married routes into ## Facts section (typed)", async () => {
  const path = tmpProfile(`# Owner profile\n\n## About me\nI'm Ada.\n`);
  const res = await maybeAutoUpdateOwnerProfile("remember I'm married", {
    profilePath: path,
    llmCall: stubLLM({
      facts: [
        { category: "owner-fact", line: "married", fact: { key: "married", value: "yes" } },
      ],
    }),
  });
  assert.equal(res.appended.length, 1);
  const parsed = parseProfile(readFileSync(path, "utf8"));
  assert.equal(parsed.facts?.maritalStatus, "married");
  // It must NOT have gone into the flat Auto-learned blob.
  assert.ok(!readFileSync(path, "utf8").includes("## Auto-learned"), "should not use auto-learn for typed fact");
});

test("owner-fact: spouse + anniversary land as structured facts", async () => {
  const path = tmpProfile(`# Owner profile\n\n## About me\nfounder.\n`);
  await maybeAutoUpdateOwnerProfile("remember my anniversary is June 3 2017 and my wife is Sam", {
    profilePath: path,
    llmCall: stubLLM({
      facts: [
        { category: "owner-fact", line: "spouse Sam", fact: { key: "spouse", value: "Sam" } },
        { category: "owner-fact", line: "anniversary", fact: { key: "wedding anniversary", value: "2017-06-03" } },
      ],
    }),
  });
  const parsed = parseProfile(readFileSync(path, "utf8"));
  assert.equal(parsed.facts?.spouse, "Sam");
  assert.deepEqual(parsed.facts?.keyDates, [{ label: "wedding anniversary", date: "2017-06-03" }]);
});

test("contact-rule: 'don't call Sujith bava' merges into Relationships line", async () => {
  const path = tmpProfile(
    `# Owner profile\n\n## Relationships\n- Sujith: brother-in-law\n`,
  );
  const res = await maybeAutoUpdateOwnerProfile("don't call Sujith bava", {
    profilePath: path,
    llmCall: stubLLM({
      facts: [
        {
          category: "address-form",
          line: "never call Sujith bava",
          contactRule: { contact: "Sujith", never: ["bava"] },
        },
      ],
    }),
  });
  assert.equal(res.appended.length, 1);
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes("never: bava"), text);
  const parsed = parseProfile(text);
  assert.equal(parsed.relationships.get("sujith"), "brother-in-law"); // preserved
  assert.deepEqual(parsed.addressRules.get("sujith")?.neverCall, ["bava"]);
});

test("contact-rule: address-as merges alongside an existing never", async () => {
  const path = tmpProfile(
    `# Owner profile\n\n## Relationships\n- Sujith: brother-in-law | never: bava\n`,
  );
  await maybeAutoUpdateOwnerProfile("address Sujith by his name", {
    profilePath: path,
    llmCall: stubLLM({
      facts: [
        {
          category: "address-form",
          line: "address Sujith by name",
          contactRule: { contact: "Sujith", addressAs: "Sujith" },
        },
      ],
    }),
  });
  const parsed = parseProfile(readFileSync(path, "utf8"));
  assert.equal(parsed.addressRules.get("sujith")?.addressAs, "Sujith");
  assert.deepEqual(parsed.addressRules.get("sujith")?.neverCall, ["bava"]); // preserved
});

test("re-teaching the same fact is idempotent (skipped, no dupe)", async () => {
  const path = tmpProfile(`# Owner profile\n\n## Facts\n- married: yes\n`);
  const res = await maybeAutoUpdateOwnerProfile("remember I'm married", {
    profilePath: path,
    llmCall: stubLLM({
      facts: [{ category: "owner-fact", line: "married", fact: { key: "married", value: "yes" } }],
    }),
  });
  assert.equal(res.appended.length, 0);
  assert.equal(res.skipped.length, 1);
});

test("invalidate callback fires after a successful write", async () => {
  const path = tmpProfile(`# Owner profile\n\n## About me\nx.\n`);
  let invalidated = false;
  await maybeAutoUpdateOwnerProfile("remember I'm married", {
    profilePath: path,
    invalidate: () => {
      invalidated = true;
    },
    llmCall: stubLLM({
      facts: [{ category: "owner-fact", line: "married", fact: { key: "married", value: "yes" } }],
    }),
  });
  assert.equal(invalidated, true);
});

test("deferTypedFacts: typed fact is NOT written, returns pendingTyped instead", async () => {
  const path = tmpProfile(`# Owner profile\n\n## About me\nfounder.\n`);
  const res = await maybeAutoUpdateOwnerProfile("remember my wife is Mae", {
    profilePath: path,
    deferTypedFacts: true,
    llmCall: stubLLM({
      facts: [{ category: "owner-fact", line: "spouse Mae", fact: { key: "spouse", value: "Mae" } }],
    }),
  });
  // Nothing authoritative written yet.
  assert.equal(res.appended.length, 0);
  assert.equal(res.pendingTyped?.length, 1);
  const parsed = parseProfile(readFileSync(path, "utf8"));
  assert.equal(parsed.facts?.spouse, undefined, "must not persist before confirm");
  // The confirm DM names the fact.
  assert.ok(formatFactConfirmPrompt(res.pendingTyped!).includes("spouse: Mae"));
});

test("deferTypedFacts: generic facts still write; typed still deferred", async () => {
  const path = tmpProfile(`# Owner profile\n\n## About me\nfounder.\n`);
  const res = await maybeAutoUpdateOwnerProfile("Raju moved to Poolville MD and my wife is Mae", {
    profilePath: path,
    deferTypedFacts: true,
    llmCall: stubLLM({
      facts: [
        { category: "location", line: "Raju lives in Poolville, MD" },
        { category: "owner-fact", line: "spouse Mae", fact: { key: "spouse", value: "Mae" } },
      ],
    }),
  });
  assert.equal(res.pendingTyped?.length, 1);
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes("Raju lives in Poolville, MD"), "generic writes immediately");
  assert.ok(!parseProfile(text).facts?.spouse, "typed fact deferred");
});

test("applyConfirmedOwnerFacts: persists the pending fact on a yes", async () => {
  const path = tmpProfile(`# Owner profile\n\n## About me\nfounder.\n`);
  const res = await maybeAutoUpdateOwnerProfile("remember my wife is Mae", {
    profilePath: path,
    deferTypedFacts: true,
    llmCall: stubLLM({
      facts: [{ category: "owner-fact", line: "spouse Mae", fact: { key: "spouse", value: "Mae" } }],
    }),
  });
  let invalidated = false;
  const applied = await applyConfirmedOwnerFacts(res.pendingTyped!, {
    profilePath: path,
    invalidate: () => { invalidated = true; },
  });
  assert.equal(applied.appended.length, 1);
  assert.equal(invalidated, true);
  assert.equal(parseProfile(readFileSync(path, "utf8")).facts?.spouse, "Mae");
});

test("generic auto-learn still works for non-typed facts", async () => {
  const path = tmpProfile(`# Owner profile\n\n## About me\nx.\n`);
  await maybeAutoUpdateOwnerProfile("Raju moved to Poolville MD", {
    profilePath: path,
    llmCall: stubLLM({
      facts: [{ category: "location", line: "Raju lives in Poolville, MD" }],
    }),
  });
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes("## Auto-learned"), "generic should still use auto-learn");
  assert.ok(text.includes("Raju lives in Poolville, MD"));
});
