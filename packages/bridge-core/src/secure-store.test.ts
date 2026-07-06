import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateStateKey,
  encryptLine,
  decryptLine,
  appendSecureLine,
  readSecureLines,
} from "./secure-store.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "secure-store-"));
}

describe("secure-store crypto", () => {
  const key = loadOrCreateStateKey(tmp());

  test("round-trips encrypt → decrypt", () => {
    const plain = "his passport number is X1234567, expires 2031";
    const env = encryptLine(plain, key);
    assert.ok(env.startsWith("enc1:"), "envelope is prefixed");
    assert.ok(!env.includes("passport"), "ciphertext hides the plaintext");
    assert.equal(decryptLine(env, key), plain);
  });

  test("fresh IV per line — same plaintext, different ciphertext", () => {
    const a = encryptLine("same", key);
    const b = encryptLine("same", key);
    assert.notEqual(a, b);
    assert.equal(decryptLine(a, key), "same");
    assert.equal(decryptLine(b, key), "same");
  });

  test("tamper → null", () => {
    const env = encryptLine("secret", key);
    // Flip a byte in the ciphertext at the decoded level. A char-substitution
    // in the base64 text is unreliable: it can be a no-op (the char already
    // equals its replacement) or a base64 alias near padding that decodes to
    // the same bytes — both leave the ciphertext intact and decryption
    // succeeds. Mutating the decoded buffer always breaks the GCM tag.
    const [prefix, ivB64, ctB64] = env.split(":");
    const ct = Buffer.from(ctB64, "base64");
    ct[0] ^= 0xff;
    const tampered = `${prefix}:${ivB64}:${ct.toString("base64")}`;
    assert.notEqual(tampered, env, "tamper must actually change the envelope");
    assert.equal(decryptLine(tampered, key), null);
  });

  test("garbage enc1 line → null (never throws)", () => {
    assert.equal(decryptLine("enc1:not-base64:@@@", key), null);
    assert.equal(decryptLine("enc1:onlyonepart", key), null);
    assert.equal(decryptLine("enc1:", key), null);
  });

  test("wrong key → null", () => {
    const env = encryptLine("secret", key);
    const other = loadOrCreateStateKey(tmp());
    assert.equal(decryptLine(env, other), null);
  });

  test("plaintext passthrough (backward compat)", () => {
    const line = '{"jid":"a","topic":"refi"}';
    assert.equal(decryptLine(line, key), line);
  });
});

describe("secure-store key file", () => {
  test("creates state.key with mode 0600, stable across calls", () => {
    const dir = tmp();
    const k1 = loadOrCreateStateKey(dir);
    assert.equal(k1.length, 32);
    const mode = statSync(join(dir, "state.key")).mode & 0o777;
    assert.equal(mode, 0o600);
    const k2 = loadOrCreateStateKey(dir);
    assert.deepEqual(k1, k2, "same key returned on second call");
  });
});

describe("secure-store file helpers", () => {
  test("append is encrypted on disk, read returns plaintext", async () => {
    const dir = tmp();
    const key = loadOrCreateStateKey(dir);
    const file = join(dir, "state.jsonl");
    await appendSecureLine(file, "line one PII", key);
    await appendSecureLine(file, "line two PII", key);

    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("PII"), "raw file has no plaintext");
    assert.ok(raw.split("\n").filter(Boolean).every((l) => l.startsWith("enc1:")));
    assert.equal((statSync(file).mode & 0o777), 0o600);

    assert.deepEqual(await readSecureLines(file, key), ["line one PII", "line two PII"]);
  });

  test("missing file → []", async () => {
    const dir = tmp();
    const key = loadOrCreateStateKey(dir);
    assert.deepEqual(await readSecureLines(join(dir, "nope.jsonl"), key), []);
  });

  test("mixed plaintext + encrypted lines both read", async () => {
    const dir = tmp();
    const key = loadOrCreateStateKey(dir);
    const file = join(dir, "state.jsonl");
    // Simulate a legacy plaintext line already on disk, then append encrypted.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, "legacy plaintext line\n");
    await appendSecureLine(file, "new encrypted line", key);
    assert.deepEqual(await readSecureLines(file, key), [
      "legacy plaintext line",
      "new encrypted line",
    ]);
  });

  test("maxBytes tail-caps (drops truncated first line)", async () => {
    const dir = tmp();
    const key = loadOrCreateStateKey(dir);
    const file = join(dir, "state.jsonl");
    for (let i = 0; i < 50; i++) await appendSecureLine(file, `line ${i}`, key);
    const capped = await readSecureLines(file, key, 200);
    const all = await readSecureLines(file, key);
    assert.ok(capped.length > 0 && capped.length < all.length, "tail-cap kept a bounded suffix");
    // Whatever survived is intact (no half-decrypted garbage).
    assert.ok(capped.every((l) => /^line \d+$/.test(l)));
  });
});
