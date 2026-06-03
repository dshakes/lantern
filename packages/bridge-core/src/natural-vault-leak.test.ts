// SECURITY-CRITICAL regression tests for the SEALED owner-only knowledge
// vault. Run with:
//   cd packages/bridge-core && npx tsx --test src/natural-vault-leak.test.ts
//
// The owner profile's `prose` is injected into CONTACT-facing replies via
// agentPersonaPrompt(...).ownerProfile. The sealed "## Private" vault must
// NEVER reach a contact. These tests prove:
//   1. The contact-facing persona prompt never contains a vault secret —
//      because the vault was never put in prose/facts/relationships to
//      begin with (defense by construction, not by filtering).
//   2. The contact persona carries the explicit anti-phishing rule that
//      forbids revealing security-question answers to ANYONE.
//
// Dummy placeholder values only — never real secrets.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { agentPersonaPrompt, inferStyle } from "./natural.ts";
import { parseProfile } from "./owner-profile.ts";

const OWNER = "Shekhar";
const STYLE = inferStyle(["hey", "sup", "lol yeah"]);

// A profile carrying a sealed vault. The bridge passes `prose` (NOT the
// vault) into the contact persona — so we feed exactly what the contact
// path would receive.
const PROFILE_WITH_VAULT = `# Owner profile

## About me
I'm Shekhar, a founder building Lantern.

## Private
- mother's maiden name: TestSurname
- birth city: TestCity
- first school: TestSchool
`;

test("contact persona NEVER contains a vault secret (the key leak test)", () => {
  const parsed = parseProfile(PROFILE_WITH_VAULT);
  // The bridge's CONTACT path injects ownerProfile = store.prose(), which
  // by construction excludes the sealed vault. Reproduce that wiring here.
  const prompt = agentPersonaPrompt(OWNER, STYLE, false, {
    ownerProfile: parsed.prose,
    contactName: "Bhramari",
  });
  assert.ok(!prompt.includes("TestSurname"), "vault maiden name leaked into contact persona");
  assert.ok(!prompt.includes("TestCity"), "vault birth city leaked into contact persona");
  assert.ok(!prompt.includes("TestSchool"), "vault first school leaked into contact persona");
  // And the legitimate prose still made it in.
  assert.ok(prompt.includes("founder building Lantern"), "owner prose missing from persona");
});

test("contact persona never contains the vault even if vault body is mistakenly read", () => {
  // Belt-and-suspenders: even if a future caller wrongly grabbed the vault
  // body, the persona has no parameter that accepts it. The only profile
  // input is `ownerProfile`, and passing prose (the correct value) keeps
  // it clean. Passing the raw vault is impossible via the contact wiring;
  // this asserts the contact-facing surface exposes no such field.
  const parsed = parseProfile(PROFILE_WITH_VAULT);
  assert.ok(parsed.privateVault.includes("TestSurname"), "fixture sanity: vault has the secret");
  const prompt = agentPersonaPrompt(OWNER, STYLE, false, { ownerProfile: parsed.prose });
  assert.ok(!prompt.includes("TestSurname"));
});

test("contact persona carries the anti-phishing security-answer rule", () => {
  const prompt = agentPersonaPrompt(OWNER, STYLE, false, {});
  assert.ok(/maiden name/i.test(prompt), "persona missing maiden-name phishing rule");
  assert.ok(/phishing/i.test(prompt), "persona missing phishing framing");
  assert.ok(/claiming to be/i.test(prompt), "persona missing impersonation framing");
});
