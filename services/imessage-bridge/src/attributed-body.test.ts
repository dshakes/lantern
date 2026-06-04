// Tests for attributedBody decoding.
//
// Regression: an RCS message ("Hi fromAjay") arrived with message.text = NULL
// and the body in attributedBody, so the bridge saw an empty inbound and the
// bot stayed silent. decodeAttributedBody must extract the text.

import { test } from "vitest";
import { strict as assert } from "node:assert";
import { decodeAttributedBody } from "./attributed-body.js";

// Build a minimal typedstream-ish blob: "...NSString...+<len><utf8>".
// 1-byte length form (len < 0x80).
function blobShort(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  assert.ok(body.length < 0x80, "use blobLong for >=128 byte strings");
  return Buffer.concat([
    Buffer.from("streamtyped...NSString", "latin1"),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, body.length]),
    body,
    Buffer.from([0x86]), // trailing class-end byte (ignored)
  ]);
}

// 0x81 + u16-LE length form (len >= 128).
function blobLong(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const lenLE = Buffer.alloc(2);
  lenLE.writeUInt16LE(body.length, 0);
  return Buffer.concat([
    Buffer.from("NSString", "latin1"),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x81]),
    lenLE,
    body,
  ]);
}

test("decodes the RCS message body (1-byte length)", () => {
  assert.equal(decodeAttributedBody(blobShort("Hi fromAjay")), "Hi fromAjay");
});

test("decodes unicode + emoji", () => {
  assert.equal(
    decodeAttributedBody(blobShort("hey 👋 cá phê")),
    "hey 👋 cá phê",
  );
});

test("decodes long strings (0x81 u16 length)", () => {
  const long = "x".repeat(300);
  assert.equal(decodeAttributedBody(blobLong(long)), long);
});

test("decodes the exact byte length, not past it", () => {
  // Body "Did u start" is 11 bytes; trailing archive bytes must be excluded.
  const b = blobShort("Did u start");
  assert.equal(decodeAttributedBody(b), "Did u start");
});

test("returns null for empty / nullish / non-NSString blobs", () => {
  assert.equal(decodeAttributedBody(null), null);
  assert.equal(decodeAttributedBody(undefined), null);
  assert.equal(decodeAttributedBody(Buffer.alloc(0)), null);
  assert.equal(
    decodeAttributedBody(Buffer.from("no marker here", "latin1")),
    null,
  );
});

test("returns null when the length runs past the buffer (corrupt)", () => {
  const b = Buffer.concat([
    Buffer.from("NSString", "latin1"),
    Buffer.from([0x2b, 0x40]), // claims 64 bytes but none follow
  ]);
  assert.equal(decodeAttributedBody(b), null);
});

test("accepts a Uint8Array as well as a Buffer", () => {
  const b = blobShort("yo");
  assert.equal(decodeAttributedBody(new Uint8Array(b)), "yo");
});
