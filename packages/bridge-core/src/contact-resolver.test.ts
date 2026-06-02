// Phone-parsing regression tests for the contact resolver. These use the
// phone-input path only (no AddressBook / machine dependency) so they're
// deterministic in CI. Guards the call feature against mis-dialing.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveContact } from "./contact-resolver.ts";

async function phone(input: string): Promise<string | null> {
  const r = await resolveContact(input, {});
  return r.resolved?.source === "phone-input" ? r.resolved.phone : null;
}

test("US 10-digit → +1 E.164", async () => {
  assert.equal(await phone("6303475128"), "+16303475128");
  assert.equal(await phone("(630) 347-5128"), "+16303475128");
});

test("US 11-digit with leading 1 → +1 E.164", async () => {
  assert.equal(await phone("16303475128"), "+16303475128");
});

test("already-E.164 international preserved", async () => {
  assert.equal(await phone("+919493678486"), "+919493678486");
  assert.equal(await phone("+91 94936 78486"), "+919493678486");
});

test("international WITHOUT + (AddressBook style) gets + prefix", async () => {
  // 12-digit India number stored without '+' — was dropped before the fix.
  assert.equal(await phone("919493678486"), "+919493678486");
  // UK 12-digit
  assert.equal(await phone("447700900000"), "+447700900000");
});

test("garbage / too-short is not treated as a phone", async () => {
  assert.equal(await phone("123"), null);
  assert.equal(await phone("call me later"), null);
});
