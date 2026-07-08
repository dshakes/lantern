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

test("stageDownloadLink posts bytes + token and returns the url", async () => {
  let seen: any = null;
  const fetchImpl = (async (url: string, init: any) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ url: "https://t/dl/tok", expiresAt: 123 }) } as any;
  }) as unknown as typeof fetch;

  const r = await stageDownloadLink({
    controlPlaneUrl: "http://127.0.0.1:8080/",
    serviceToken: "svc-tok",
    filename: "a.pdf",
    contentB64: "Zm9v",
    fetchImpl,
  });
  assert.deepEqual(r, { url: "https://t/dl/tok", expiresAt: 123 });
  assert.equal(seen.url, "http://127.0.0.1:8080/internal/dl/stage");
  assert.equal(seen.init.headers["x-lantern-service-token"], "svc-tok");
  assert.match(seen.init.body, /"contentB64":"Zm9v"/);
});

test("stageDownloadLink returns null on non-ok / missing url / throw", async () => {
  const bad = (async () => ({ ok: false, json: async () => ({}) }) as any) as unknown as typeof fetch;
  assert.equal(await stageDownloadLink({ controlPlaneUrl: "http://x", filename: "a", contentB64: "b", fetchImpl: bad }), null);
  const noUrl = (async () => ({ ok: true, json: async () => ({}) }) as any) as unknown as typeof fetch;
  assert.equal(await stageDownloadLink({ controlPlaneUrl: "http://x", filename: "a", contentB64: "b", fetchImpl: noUrl }), null);
  const thrower = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
  assert.equal(await stageDownloadLink({ controlPlaneUrl: "http://x", filename: "a", contentB64: "b", fetchImpl: thrower }), null);
});
