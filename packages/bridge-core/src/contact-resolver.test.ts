// Phone-parsing regression tests for the contact resolver. These use the
// phone-input path only (no AddressBook / machine dependency) so they're
// deterministic in CI. Guards the call feature against mis-dialing.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { resolveContact, queryAddressBookConn } from "./contact-resolver.ts";

// Build an in-memory DB with the AddressBook-v22 schema subset the resolver
// reads, seeded with a few "Madhu" contacts so ranking is exercised.
function makeAddressBook(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE ZABCDRECORD (
      Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT,
      ZNICKNAME TEXT, ZORGANIZATION TEXT
    );
    CREATE TABLE ZABCDPHONENUMBER (
      Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT
    );
  `);
  const rec = db.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION) VALUES (?,?,?,?,?)",
  );
  const ph = db.prepare("INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?,?)");
  rec.run(1, "Pd Madhu", null, null, null); ph.run(1, "(512) 555-0001");
  rec.run(2, "Madhu", "Mudarapu", null, null); ph.run(2, "(630) 347-5128");
  rec.run(3, "Madhu", "Uncle", null, null); ph.run(3, "+15125550003");
  rec.run(4, "Madhu", "Munukutla", null, "Neodora LLC"); // no phone → JOIN drops it
  return db;
}

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

// Regression: the AddressBook query bound positional args (.get(a, b)) against
// a statement that reused a numbered marker (?1 ×3), so better-sqlite3 threw
// "Too many parameter values were provided" on EVERY call. The throw was
// swallowed, dbHit was always null, and "call Madhu" failed while a pasted
// number worked. Named params (@q / @like) fix it. This drives the exact
// extracted query against a temp DB so it can't silently regress in CI.
test("AddressBook name lookup binds + resolves (no 'Too many parameter values')", () => {
  const db = makeAddressBook();
  try {
    // Bare first name → exact-rank match wins, with a dialable phone.
    const m = queryAddressBookConn(db, "Madhu");
    assert.ok(m, "expected a hit for 'Madhu'");
    assert.equal(m!.phone, "+16303475128");
    assert.equal(m!.name, "Madhu Mudarapu");

    // Full name resolves too.
    const full = queryAddressBookConn(db, "Madhu Mudarapu");
    assert.ok(full, "expected a hit for 'Madhu Mudarapu'");
    assert.equal(full!.phone, "+16303475128");

    // A name with no phone in the book → null (JOIN drops it), not a throw.
    assert.equal(queryAddressBookConn(db, "Munukutla"), null);

    // Unknown name → null, no throw.
    assert.equal(queryAddressBookConn(db, "Nonexistent Person"), null);
  } finally {
    db.close();
  }
});
