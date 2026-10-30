import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PAL_CONSENT_VERSION,
  canFinishProfile,
  channelsVerified,
  decideBrief,
  decideTrustSaved,
  imessageFix,
  imessageReadiness,
  liveChannels,
  mayLearnVoice,
  mergeConfirmed,
  palCanEnter,
  palResumeStep,
  parseApiError,
  selectVoiceSamples,
  suggestPalFix,
  toSavable,
  whatsappFix,
  whatsappReadiness,
  type PalOnboardingState,
  type PalStep,
} from "./pal-onboarding-logic";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(
  readFileSync(join(here, "../../../../../services/testdata/pal_onboarding_cases.json"), "utf8"),
);

// ---- parity with the Go server + CLI ------------------------------------------

test("consent version matches the shared fixture (and so the server)", () => {
  assert.equal(cases.consentVersion, PAL_CONSENT_VERSION);
});

test("palResumeStep matches the shared fixture", () => {
  for (const c of cases.resume) assert.equal(palResumeStep(c.state), c.want, c.name);
});

test("palCanEnter matches the shared fixture", () => {
  for (const c of cases.canEnter) assert.equal(palCanEnter(c.step as PalStep, c.state, c.channelsVerified), c.want, c.name);
});

test("voice sampling consent gate matches the shared fixture", () => {
  for (const c of cases.voiceSamplingAllowed) assert.equal(mayLearnVoice(c.state), c.want, c.name);
});

test("WhatsApp readiness matches the shared fixture", () => {
  for (const c of cases.whatsapp) assert.equal(whatsappReadiness(c.input), c.want, c.name);
});

test("iMessage readiness (Full Disk Access vs Automation detected, not assumed) matches the shared fixture", () => {
  for (const c of cases.imessage) assert.equal(imessageReadiness(c.input), c.want, c.name);
});

// ---- channels -------------------------------------------------------------------

test("one live channel is enough; neither is not", () => {
  assert.equal(channelsVerified({ whatsapp: "connected", imessage: "needs_full_disk_access" }), true);
  assert.equal(channelsVerified({ whatsapp: "needs_pairing", imessage: "ready" }), true);
  assert.equal(channelsVerified({ whatsapp: "connecting", imessage: "needs_automation" }), false);
  assert.equal(channelsVerified(null), false);
  assert.deepEqual(liveChannels({ whatsapp: "connected", imessage: "ready" }), ["imessage", "whatsapp"]);
});

test("every non-ready channel state has a concrete fix; ready has none", () => {
  for (const r of ["offline", "unauthorized", "unsupported", "not_started", "starting", "needs_full_disk_access", "needs_automation", "not_set_up", "messages_unavailable", "needs_permission", "error"] as const) {
    const f = imessageFix(r);
    assert.equal(f.ok, false, r);
    assert.ok(f.steps.length > 0, `${r} has steps`);
  }
  assert.equal(imessageFix("ready").ok, true);
  assert.match(imessageFix("needs_full_disk_access").steps.join(" "), /Full Disk Access/);
  assert.match(imessageFix("needs_automation").steps.join(" "), /Automation/);
  assert.equal(whatsappFix("needs_pairing").action, "pair_whatsapp");
  assert.equal(whatsappFix("connected").ok, true);
});

// ---- consent gating on sampling -------------------------------------------------

const consentedWithVoice: PalOnboardingState = {
  consent: { version: PAL_CONSENT_VERSION, acceptedAt: "2026-10-01T00:00:00Z", voiceSampling: true },
};

test("no message is sampled without the voice opt-in, even if a caller forgets to check", () => {
  const hits = Array.from({ length: 10 }, (_, i) => ({ text: `msg ${i}`, fromMe: true, isGroup: false }));
  assert.deepEqual(selectVoiceSamples({}, hits), []);
  assert.deepEqual(
    selectVoiceSamples({ consent: { version: PAL_CONSENT_VERSION, acceptedAt: "2026-10-01T00:00:00Z", voiceSampling: false } }, hits),
    [],
  );
  assert.deepEqual(
    selectVoiceSamples({ consent: { version: "2025-01", acceptedAt: "2026-10-01T00:00:00Z", voiceSampling: true } }, hits),
    [],
  );
  assert.equal(selectVoiceSamples(consentedWithVoice, hits).length, 10);
});

test("voice samples are only the owner's own 1:1 texts, deduped and capped", () => {
  const out = selectVoiceSamples(consentedWithVoice, [
    { text: "on my way", fromMe: true },
    { text: "On my way", fromMe: true }, // dupe (case)
    { text: "are you coming?", fromMe: false }, // a contact's message
    { text: "group banter", fromMe: true, isGroup: true },
    { text: "￼", fromMe: true }, // attachment placeholder
    { text: "k", fromMe: true }, // too short to carry voice
    { text: "sounds good, see you at 7", fromMe: true },
  ]);
  assert.deepEqual(out, ["on my way", "sounds good, see you at 7"]);
  const many = Array.from({ length: 200 }, (_, i) => ({ text: `text number ${i}`, fromMe: true }));
  assert.equal(selectVoiceSamples(consentedWithVoice, many).length, 80);
});

// ---- trust -------------------------------------------------------------------------

test("trust is saved only when the read-back matches every chosen mode", () => {
  const desired = { otp: "auto", bill: "ask" } as const;
  assert.deepEqual(decideTrustSaved(desired, [{ kind: "otp", mode: "auto" }, { kind: "bill", mode: "ask" }], {}), { ok: true });
  const r = decideTrustSaved(desired, [{ kind: "otp", mode: "ask" }, { kind: "bill", mode: "ask" }], {});
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /One-time codes/);
  assert.equal(decideTrustSaved(desired, null, {}).ok, false);
  assert.equal(decideTrustSaved({}, [], { start: 22 }).ok, false, "half a quiet window");
  assert.equal(decideTrustSaved({}, [], { start: 22, end: 24 }).ok, false, "hour out of range");
  assert.equal(decideTrustSaved({}, [], { start: 22, end: 7 }).ok, true);
});

// ---- profile -----------------------------------------------------------------------

test("profile can finish only when every proposal is reviewed; re-confirming replaces", () => {
  const p = { section: "facts" as const, key: "spouse", value: "Sam", quote: "married to Sam" };
  assert.equal(canFinishProfile([{ item: p, status: "pending" }]), false);
  assert.equal(canFinishProfile([{ item: p, status: "confirmed" }, { item: p, status: "rejected" }]), true);
  assert.equal(canFinishProfile([]), true);
  const merged = mergeConfirmed(
    [{ section: "facts", key: "spouse", value: "Sam" }],
    [{ section: "facts", key: "Spouse ", value: "Samantha" }, { section: "relationships", key: "Shiva", value: "brother", never: [" bro ", ""] }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].value, "Samantha");
  assert.deepEqual(merged[1].never, ["bro"]);
});

// ---- resume document hygiene -------------------------------------------------------

test("toSavable strips server-derived fields", () => {
  const s = toSavable({ step: "trust", resumeStep: "trust", consentVersion: "x", updatedAt: "t", consent: { version: "v" } });
  assert.equal("resumeStep" in s, false);
  assert.equal("consentVersion" in s, false);
  assert.equal("updatedAt" in s, false);
  assert.equal(s.step, "trust");
});

// ---- first Brief ---------------------------------------------------------------------

test("the Brief is 'waiting' until a bridge has really built one, then the newest wins", () => {
  assert.deepEqual(decideBrief([null, { generatedAt: null, channel: "whatsapp", items: [] }]), { kind: "waiting" });
  const d = decideBrief([
    { generatedAt: 100, channel: "imessage", items: [{ n: 1, icon: "⏳", label: "old" }] },
    { generatedAt: 200, channel: "whatsapp", items: [{ n: 1, icon: "⏳", label: "new" }] },
  ]);
  assert.equal(d.kind, "ready");
  assert.equal((d as { channel: string }).channel, "whatsapp");
});

// ---- errors → fixes --------------------------------------------------------------------

test("errors map to the one fix most likely to work", () => {
  const fix = (raw: string, step: PalStep = "voice") => suggestPalFix(parseApiError(new Error(raw)), step).fix.action;
  assert.equal(fix('API 403: {"error":"consent required","code":"consent_required"}'), "review_consent");
  assert.equal(fix('API 422: {"error":"need 5","code":"not_enough_samples"}'), "skip_voice");
  assert.equal(fix('API 400: {"error":"no LLM provider API key configured","code":"no_provider"}', "welcome"), "add_key");
  assert.equal(fix('API 502: {"error":"x","code":"llm_failed"}'), "add_key");
  assert.equal(fix('API 502: {"error":"x","code":"bad_voice"}'), "retry");
  assert.equal(fix('API 502: {"error":"x","code":"bad_profile"}', "profile"), "rephrase");
  assert.equal(fix("API 401: {}", "trust"), "login");
  assert.equal(fix("API 503: bridge unreachable", "channels"), "recheck_channels");
  assert.equal(fix("Failed to fetch", "welcome"), "check_api");
  assert.equal(fix("API 500: boom", "trust"), "retry");
});
