import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildDocLinkMessage, stageDownloadLink, chooseFileTransport } from "./doc-link.ts";

test("chooseFileTransport: the bug — a phone where iMessage failed (error 25) MUST route to link", () => {
  assert.equal(chooseFileTransport({ isPhone: true, recent: { service: "iMessage", error: 25 } }), "link");
});

test("chooseFileTransport: SMS/RCS phone → link", () => {
  assert.equal(chooseFileTransport({ isPhone: true, recent: { service: "RCS", error: 0 } }), "link");
  assert.equal(chooseFileTransport({ isPhone: true, recent: { service: "SMS", error: 0 } }), "link");
});

test("chooseFileTransport: unknown phone (no history) → link (never gamble on iMessage)", () => {
  assert.equal(chooseFileTransport({ isPhone: true, recent: null }), "link");
  assert.equal(chooseFileTransport({ isPhone: true }), "link");
});

test("chooseFileTransport: phone with proven iMessage delivery → inline", () => {
  assert.equal(chooseFileTransport({ isPhone: true, recent: { service: "iMessage", error: 0 } }), "imessage");
});

test("chooseFileTransport: non-phone Apple ID → iMessage (only channel)", () => {
  assert.equal(chooseFileTransport({ isPhone: false, recent: null }), "imessage");
});

test("link message carries the url + honest expiry, in a natural voice", () => {
  const m = buildDocLinkMessage("PAN card", "https://x.example.com/dl/abc", 60);
  assert.match(m, /here's the PAN card/);
  assert.match(m, /https:\/\/x\.example\.com\/dl\/abc/);
  assert.match(m, /expires in about an hour/);
});

test("expiry phrasing scales", () => {
  assert.match(buildDocLinkMessage("x", "u", 15), /15 minutes/);
  assert.match(buildDocLinkMessage("x", "u", 120), /2 hours/);
});

test("stageDownloadLink streams raw bytes + headers (no base64) and returns the url", async () => {
  let seen: any = null;
  const fetchImpl = (async (url: string, init: any) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ url: "https://t/dl/tok", expiresAt: 123 }) } as any;
  }) as unknown as typeof fetch;

  const bytes = new TextEncoder().encode("foo");
  const r = await stageDownloadLink({
    controlPlaneUrl: "http://127.0.0.1:8080/",
    serviceToken: "svc-tok",
    filename: "a.pdf",
    content: bytes,
    fetchImpl,
  });
  assert.deepEqual(r, { url: "https://t/dl/tok", expiresAt: 123 });
  assert.equal(seen.url, "http://127.0.0.1:8080/internal/dl/stage");
  assert.equal(seen.init.headers["x-lantern-service-token"], "svc-tok");
  assert.equal(seen.init.headers["Content-Type"], "application/octet-stream");
  assert.equal(seen.init.headers["X-Filename"], "a.pdf");
  assert.equal(seen.init.headers["Content-Length"], "3");
  assert.equal(seen.init.body, bytes); // raw bytes, not JSON
});

test("stageDownloadLink rejects an unreachable loopback/private URL (dead link guard)", async () => {
  const b = new Uint8Array([1]);
  for (const url of ["http://localhost:8080/dl/t", "http://127.0.0.1:8080/dl/t", "http://192.168.1.9/dl/t"]) {
    const f = (async () => ({ ok: true, json: async () => ({ url }) }) as any) as unknown as typeof fetch;
    assert.equal(await stageDownloadLink({ controlPlaneUrl: "http://x", filename: "a", content: b, fetchImpl: f }), null, url);
  }
});

test("stageDownloadLink returns null on non-ok / missing url / throw", async () => {
  const b = new Uint8Array([1]);
  const bad = (async () => ({ ok: false, json: async () => ({}) }) as any) as unknown as typeof fetch;
  assert.equal(await stageDownloadLink({ controlPlaneUrl: "http://x", filename: "a", content: b, fetchImpl: bad }), null);
  const noUrl = (async () => ({ ok: true, json: async () => ({}) }) as any) as unknown as typeof fetch;
  assert.equal(await stageDownloadLink({ controlPlaneUrl: "http://x", filename: "a", content: b, fetchImpl: noUrl }), null);
  const thrower = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
  assert.equal(await stageDownloadLink({ controlPlaneUrl: "http://x", filename: "a", content: b, fetchImpl: thrower }), null);
});
