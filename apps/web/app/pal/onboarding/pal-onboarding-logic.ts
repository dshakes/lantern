// ---------------------------------------------------------------------------
// Pure decision logic for pal's agentic first-run (ADR 0048).
//
// The flow is a gated state machine: welcome → channels → voice → trust →
// profile → done. The persisted document (GET/PUT /v1/pal/onboarding) records
// FACTS; where to resume is DERIVED from them (palResumeStep). The control
// plane runs the same machine (internal/handlers/pal_onboarding.go) and the
// `pal setup` CLI follows the server's `resumeStep`; all three are pinned by
// services/testdata/pal_onboarding_cases.json.
//
// Golden rules encoded here:
//   - Success is never the default: every step advances on a real result
//     (a live bridge check, a 2xx, a read-back that matches).
//   - Channels are never persisted as passed; they are re-checked live.
//   - No message is sampled without the explicit voice opt-in (mayLearnVoice).
// ---------------------------------------------------------------------------

// Self-contained on purpose: the unit tests load this file through tsx's ESM
// hook only, which cannot resolve a nested extension-less .ts import.

export interface ApiFailure {
  status?: number;
  code?: string;
  message: string;
}

/** Normalize any thrown value into a human-readable, non-empty message. */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

/** Parse the dashboard client's `API <status>: <body>` errors (same shape as the Runtime onboarding). */
export function parseApiError(err: unknown): ApiFailure {
  const raw = errorMessage(err, "Something went wrong.");
  const m = /^API (\d{3}):\s*([\s\S]*)$/.exec(raw);
  if (!m) return { message: raw };
  const status = Number(m[1]);
  const body = m[2].trim();
  try {
    const j = JSON.parse(body) as { error?: string; code?: string; reason?: string };
    return { status, code: j.code, message: [j.error, j.reason].filter(Boolean).join(": ") || body || `HTTP ${status}` };
  } catch {
    return { status, message: body || `HTTP ${status}` };
  }
}

/** Bumped when what pal does with data changes; must match PalConsentVersion in Go. */
export const PAL_CONSENT_VERSION = "2026-10";

export type PalStep = "welcome" | "channels" | "voice" | "trust" | "profile" | "done";

export const PAL_STEPS: ReadonlyArray<{ id: PalStep; label: string; hint: string }> = [
  { id: "welcome", label: "Meet pal", hint: "What it does, what it touches" },
  { id: "channels", label: "Connect channels", hint: "WhatsApp and iMessage, checked live" },
  { id: "voice", label: "Learn your voice", hint: "A draft in your words, for approval" },
  { id: "trust", label: "Set trust", hint: "What pal may do on its own" },
  { id: "profile", label: "Your people", hint: "Facts pal must never get wrong" },
  { id: "done", label: "First Brief", hint: "What needs you, at a glance" },
];

export interface PalConsent {
  version: string;
  acceptedAt?: string;
  voiceSampling?: boolean;
}

export interface VoiceProfile {
  register: "very-casual" | "casual" | "direct" | "semi-formal";
  sentenceLength: "terse" | "medium" | "variable";
  languageMix: string;
  emojiUse: string;
  warmth: "warm" | "dry" | "neutral";
  patterns?: string[];
}

export interface VoicePreview {
  inbound: string;
  draft: string;
}

export interface ProfileItem {
  section: "facts" | "relationships";
  key: string;
  value: string;
  addressAs?: string;
  never?: string[];
}

export interface PalOnboardingState {
  step?: PalStep;
  consent?: PalConsent;
  channels?: { whatsapp?: string; imessage?: string };
  voice?: { profile?: VoiceProfile; preview?: VoicePreview; sampleCount?: number; approved?: boolean; skipped?: boolean };
  trust?: { prefsSaved?: boolean; holdsAcknowledged?: boolean; quietStart?: number; quietEnd?: number };
  profile?: { items?: ProfileItem[]; done?: boolean };
  completedAt?: string;
  updatedAt?: string;
  /** Server-derived; never sent back. */
  resumeStep?: PalStep;
  consentVersion?: string;
}

// ---- the state machine (mirrors palResumeStep / palCanEnter in Go) ----------

export function consented(s: PalOnboardingState | null | undefined): boolean {
  return !!s?.consent?.acceptedAt && s.consent.version === PAL_CONSENT_VERSION;
}

/** The consent gate: messages may be sampled only after the explicit voice opt-in. */
export function mayLearnVoice(s: PalOnboardingState | null | undefined): boolean {
  return consented(s) && s!.consent!.voiceSampling === true;
}

export function voiceDone(s: PalOnboardingState): boolean {
  return !!s.voice && (!!s.voice.skipped || (!!s.voice.approved && !!s.voice.profile));
}

export function trustDone(s: PalOnboardingState): boolean {
  return !!s.trust?.prefsSaved && !!s.trust?.holdsAcknowledged;
}

export function profileDone(s: PalOnboardingState): boolean {
  return !!s.profile?.done;
}

export function palResumeStep(s: PalOnboardingState | null | undefined): PalStep {
  if (!s || !consented(s)) return "welcome";
  if (s.completedAt && voiceDone(s) && trustDone(s) && profileDone(s)) return "done";
  if (!voiceDone(s)) return "channels";
  if (!trustDone(s)) return "trust";
  if (!profileDone(s)) return "profile";
  return "done";
}

export function palCanEnter(step: PalStep, s: PalOnboardingState, channelsVerified: boolean): boolean {
  switch (step) {
    case "welcome":
      return true;
    case "channels":
      return consented(s);
    case "voice":
      return consented(s) && channelsVerified;
    case "trust":
      return consented(s) && voiceDone(s);
    case "profile":
      return consented(s) && voiceDone(s) && trustDone(s);
    case "done":
      return consented(s) && voiceDone(s) && trustDone(s) && profileDone(s);
  }
}

export function palStepIndex(step: PalStep): number {
  return PAL_STEPS.findIndex((x) => x.id === step);
}

export type PalStepStatus = "done" | "current" | "todo";

export function palStepStatus(step: PalStep, current: PalStep): PalStepStatus {
  const a = palStepIndex(step);
  const b = palStepIndex(current);
  if (a < b) return "done";
  return a === b ? "current" : "todo";
}

/** The document to PUT: server-derived fields stripped. */
export function toSavable(s: PalOnboardingState): PalOnboardingState {
  const out: PalOnboardingState = { ...s };
  delete out.resumeStep;
  delete out.consentVersion;
  delete out.updatedAt;
  return out;
}

// ---- channels: live bridge readings → readiness ------------------------------

export interface BridgeProbe<T> {
  reachable: boolean;
  httpStatus?: number;
  status?: T;
  diagnostics?: T;
}

export type WhatsAppReadiness = "offline" | "unauthorized" | "needs_pairing" | "connecting" | "connected";

export function whatsappReadiness(p: BridgeProbe<{ status?: string; paired?: boolean }>): WhatsAppReadiness {
  if (!p.reachable || p.httpStatus === 503 || p.httpStatus === 502) return "offline";
  if (p.httpStatus === 401 || p.httpStatus === 403) return "unauthorized";
  const st = p.status;
  if (st?.paired && st.status === "connected") return "connected";
  if (st?.paired) return "connecting";
  return "needs_pairing";
}

export type IMessageReadiness =
  | "offline"
  | "unauthorized"
  | "unsupported"
  | "not_started"
  | "starting"
  | "ready"
  | "needs_full_disk_access"
  | "needs_automation"
  | "not_set_up"
  | "messages_unavailable"
  | "needs_permission"
  | "error";

/**
 * Map the iMessage bridge's own diagnostics to what is missing. The reason
 * strings come from the bridge (chat-db.ts open(), applescript.ts checkAccess)
 * — this is a fixed diagnostic table, not judgment.
 */
export function imessageReadiness(p: BridgeProbe<{ state?: string; reason?: string | null }>): IMessageReadiness {
  if (!p.reachable || p.httpStatus === 503 || p.httpStatus === 502) return "offline";
  if (p.httpStatus === 401 || p.httpStatus === 403) return "unauthorized";
  if (p.httpStatus === 501) return "unsupported";
  if (p.httpStatus !== undefined && (p.httpStatus < 200 || p.httpStatus >= 300)) return "error";
  const state = p.diagnostics?.state ?? "idle";
  const reason = (p.diagnostics?.reason ?? "").toLowerCase();
  if (state === "ready") return "ready";
  if (state === "idle") return "not_started";
  if (state === "starting") return "starting";
  if (state === "messages_not_running" || /not available or not logged|not running/.test(reason)) return "messages_unavailable";
  if (state === "permission_required") {
    if (/full disk access|permission denied reading chat\.db/.test(reason)) return "needs_full_disk_access";
    if (/automation/.test(reason)) return "needs_automation";
    if (/chat\.db not found/.test(reason)) return "not_set_up";
    return "needs_permission";
  }
  return "error";
}

export interface ChannelReport {
  whatsapp: WhatsAppReadiness;
  imessage: IMessageReadiness;
}

/** At least one channel live — the gate into the voice step. */
export function channelsVerified(r: ChannelReport | null | undefined): boolean {
  return !!r && (r.whatsapp === "connected" || r.imessage === "ready");
}

export function liveChannels(r: ChannelReport | null | undefined): Array<"whatsapp" | "imessage"> {
  const out: Array<"whatsapp" | "imessage"> = [];
  if (r?.imessage === "ready") out.push("imessage");
  if (r?.whatsapp === "connected") out.push("whatsapp");
  return out;
}

export interface ChannelFix {
  ok: boolean;
  title: string;
  /** Concrete steps, in order. Empty when ok. */
  steps: string[];
  action?: "start_imessage" | "pair_whatsapp" | "recheck";
}

const FDA_STEP =
  "Open System Settings → Privacy & Security → Full Disk Access, and turn it on for the app that runs the iMessage bridge (Terminal, or the node binary under launchd).";
const AUTOMATION_STEP =
  "Open System Settings → Privacy & Security → Automation, find the app that runs the bridge, and turn on Messages.";
const BRIDGE_START = "Start the bridge on your Mac (`pal dev`, or `make run-imessage-bridge` / `make run-whatsapp-bridge`), then check again.";

export function imessageFix(r: IMessageReadiness): ChannelFix {
  switch (r) {
    case "ready":
      return { ok: true, title: "iMessage is connected.", steps: [] };
    case "offline":
      return { ok: false, title: "The iMessage bridge isn't running on this Mac.", steps: [BRIDGE_START], action: "recheck" };
    case "unauthorized":
      return { ok: false, title: "The dashboard's bridge token doesn't match the iMessage bridge.", steps: ["Set the same PAL_IMESSAGE_BRIDGE_TOKEN for the dashboard and the iMessage bridge, then restart both."], action: "recheck" };
    case "unsupported":
      return { ok: false, title: "iMessage needs a Mac — this bridge isn't running on macOS.", steps: ["Run the iMessage bridge on the Mac signed in to your Apple ID, or use WhatsApp."] };
    case "not_started":
      return { ok: false, title: "The iMessage bridge is up but hasn't started your session.", steps: ["Start it — I'll check both permissions as it boots."], action: "start_imessage" };
    case "starting":
      return { ok: false, title: "iMessage is starting.", steps: ["Give it a few seconds."], action: "recheck" };
    case "needs_full_disk_access":
      return { ok: false, title: "Full Disk Access is off, so pal can't read your Messages database.", steps: [FDA_STEP, "Restart the bridge after granting it — macOS applies this permission at launch."], action: "start_imessage" };
    case "needs_automation":
      return { ok: false, title: "Full Disk Access works, but Automation for Messages is off, so pal can't send.", steps: [AUTOMATION_STEP], action: "start_imessage" };
    case "not_set_up":
      return { ok: false, title: "iMessage isn't set up on this Mac account.", steps: ["Open Messages, sign in with your Apple ID, and turn on iMessage."], action: "start_imessage" };
    case "messages_unavailable":
      return { ok: false, title: "Messages isn't available or isn't signed in.", steps: ["Open Messages and make sure it's signed in to iMessage."], action: "start_imessage" };
    case "needs_permission":
      return { ok: false, title: "macOS refused a permission the bridge needs.", steps: [FDA_STEP, AUTOMATION_STEP], action: "start_imessage" };
    case "error":
      return { ok: false, title: "The iMessage bridge returned an error.", steps: ["Check the bridge log, then check again."], action: "recheck" };
  }
}

export function whatsappFix(r: WhatsAppReadiness): ChannelFix {
  switch (r) {
    case "connected":
      return { ok: true, title: "WhatsApp is connected.", steps: [] };
    case "offline":
      return { ok: false, title: "The WhatsApp bridge isn't running.", steps: [BRIDGE_START], action: "recheck" };
    case "unauthorized":
      return { ok: false, title: "The dashboard's bridge token doesn't match the WhatsApp bridge.", steps: ["Set the same PAL_BRIDGE_TOKEN for the dashboard and the WhatsApp bridge, then restart both."], action: "recheck" };
    case "needs_pairing":
      return { ok: false, title: "WhatsApp isn't linked yet.", steps: ["On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan the QR code."], action: "pair_whatsapp" };
    case "connecting":
      return { ok: false, title: "WhatsApp is linked and reconnecting.", steps: ["Keep your phone online for a moment."], action: "recheck" };
  }
}

// ---- voice: choose samples (only the owner's own 1:1 sent messages) ----------

export interface HistoryHit {
  text?: string;
  fromMe?: boolean;
  isGroup?: boolean;
}

export const VOICE_MIN_SAMPLES = 5;
export const VOICE_MAX_SAMPLES = 80;

/**
 * Keep only what the owner sent, in 1:1 threads (groups are a different
 * register), with real text; dedupe; cap. Returns [] when sampling is not
 * allowed — the consent gate holds even if a caller forgets to check.
 */
export function selectVoiceSamples(state: PalOnboardingState, hits: HistoryHit[]): string[] {
  if (!mayLearnVoice(state)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (!h.fromMe || h.isGroup) continue;
    const t = (h.text ?? "").trim();
    if (t.length < 2 || t.length > 400 || seen.has(t.toLowerCase())) continue;
    // Attachments / reactions surface as placeholder text; they carry no voice.
    if (/^(￼|\[(image|attachment|sticker|audio|video)[^\]]*\])$/i.test(t)) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === VOICE_MAX_SAMPLES) break;
  }
  return out;
}

// ---- trust ---------------------------------------------------------------------

export type TrustMode = "auto" | "ask" | "off";

export const LIFE_EVENT_KINDS = ["bill", "delivery", "appointment", "fraud_alert", "otp", "travel", "receipt", "promo"] as const;
export type LifeEventKind = (typeof LIFE_EVENT_KINDS)[number];

export const KIND_LABELS: Record<LifeEventKind, string> = {
  bill: "Bills",
  delivery: "Deliveries",
  appointment: "Appointments",
  fraud_alert: "Fraud alerts",
  otp: "One-time codes",
  travel: "Travel",
  receipt: "Receipts",
  promo: "Promotions",
};

/**
 * Trust is saved only when a read-back of /v1/life-events/prefs matches every
 * mode the owner chose — a 2xx on each PUT is not enough on its own.
 */
export function decideTrustSaved(
  desired: Partial<Record<string, TrustMode>>,
  readback: Array<{ kind: string; mode: string }> | null,
  quiet: { start?: number; end?: number },
): { ok: true } | { ok: false; error: string } {
  if (!readback) return { ok: false, error: "Couldn't read your settings back to confirm they saved." };
  const got = new Map(readback.map((p) => [p.kind, p.mode]));
  const wrong = Object.entries(desired).filter(([k, m]) => got.get(k) !== m);
  if (wrong.length) return { ok: false, error: `These didn't save: ${wrong.map(([k]) => KIND_LABELS[k as LifeEventKind] ?? k).join(", ")}.` };
  const { start, end } = quiet;
  if ((start === undefined) !== (end === undefined)) return { ok: false, error: "Set both ends of quiet hours, or neither." };
  for (const h of [start, end]) {
    if (h !== undefined && (!Number.isInteger(h) || h < 0 || h > 23)) return { ok: false, error: "Quiet hours are whole hours from 0 to 23." };
  }
  return { ok: true };
}

// ---- profile review ------------------------------------------------------------

export interface ProfileProposal extends ProfileItem {
  quote: string;
}

export type ProposalStatus = "pending" | "confirmed" | "rejected";

export interface ReviewedProposal {
  item: ProfileProposal;
  status: ProposalStatus;
}

export function itemKey(it: ProfileItem): string {
  return `${it.section}:${it.key.trim().toLowerCase()}`;
}

/**
 * Merge confirmed items into the profile: a re-confirmed key replaces the old
 * value (the owner just said it), never duplicates it.
 */
export function mergeConfirmed(existing: ProfileItem[], confirmed: ProfileItem[]): ProfileItem[] {
  const map = new Map(existing.map((it) => [itemKey(it), it]));
  for (const it of confirmed) {
    const clean: ProfileItem = { section: it.section, key: it.key.trim(), value: it.value.trim() };
    if (it.addressAs?.trim()) clean.addressAs = it.addressAs.trim();
    if (it.never?.length) clean.never = it.never.map((n) => n.trim()).filter(Boolean);
    map.set(itemKey(clean), clean);
  }
  return [...map.values()];
}

/** The profile step can finish only when nothing is left unreviewed. */
export function canFinishProfile(review: ReviewedProposal[]): boolean {
  return review.every((r) => r.status !== "pending");
}

export function describeItem(it: ProfileItem): string {
  if (it.section === "facts") return `${it.key}: ${it.value}`;
  let s = `${it.key} — ${it.value}`;
  if (it.addressAs) s += ` (call them “${it.addressAs}”)`;
  if (it.never?.length) s += `; never “${it.never.join("”, “")}”`;
  return s;
}

// ---- the first Brief -------------------------------------------------------------

export interface BriefSnapshot {
  generatedAt: number | null;
  channel: string;
  items: Array<{ n: number; icon: string; label: string; why?: string }>;
}

export type BriefDisplay =
  | { kind: "ready"; channel: string; items: BriefSnapshot["items"] }
  | { kind: "waiting" };

/** The newest real Brief across channels; "waiting" until a bridge has built one. */
export function decideBrief(snaps: Array<BriefSnapshot | null>): BriefDisplay {
  const real = snaps.filter((s): s is BriefSnapshot => !!s && typeof s.generatedAt === "number");
  if (!real.length) return { kind: "waiting" };
  real.sort((a, b) => (b.generatedAt ?? 0) - (a.generatedAt ?? 0));
  return { kind: "ready", channel: real[0].channel, items: real[0].items ?? [] };
}

// ---- errors → one-click fixes (deterministic floor) ------------------------------

export type PalFixAction =
  | "add_key"
  | "retry"
  | "login"
  | "review_consent"
  | "recheck_channels"
  | "skip_voice"
  | "rephrase"
  | "check_api";

export interface PalFix {
  summary: string;
  detail?: string;
  fix: { label: string; action: PalFixAction };
}

/**
 * Map a real failure to what went wrong and the one action most likely to fix
 * it. Deterministic on purpose: it must work when the failure IS the model.
 */
export function suggestPalFix(f: ApiFailure, step: PalStep): PalFix {
  const msg = f.message.toLowerCase();
  if (f.status === undefined && /fetch|network|econnrefused|load failed/.test(msg)) {
    return { summary: "The pal API isn't reachable. Start it with `pal dev` (or `make run-api`), then try again.", fix: { label: "Try again", action: "check_api" } };
  }
  if (f.status === 401) return { summary: "Your session expired. Sign in again to pick up where you left off.", fix: { label: "Sign in", action: "login" } };
  if (f.code === "consent_required") {
    return { summary: "pal only learns from your messages after you opt in. Review the consent step to turn that on, or skip voice learning.", fix: { label: "Review consent", action: "review_consent" } };
  }
  if (f.code === "not_enough_samples") {
    return { summary: "I couldn't find enough messages you've sent recently to learn your voice. Connect another channel, or skip — pal will learn as you text.", detail: f.message, fix: { label: "Skip for now", action: "skip_voice" } };
  }
  if (f.code === "no_provider" || /no (llm )?provider|no api key|api key configured/.test(msg)) {
    return { summary: "pal needs a model key to think. Add an OpenAI or Anthropic key in Settings, then come back — your progress is saved.", fix: { label: "Add a model key", action: "add_key" } };
  }
  if (f.code === "llm_failed" || /invalid.*key|incorrect api key|authentication|rejected/.test(msg)) {
    return { summary: "The model provider rejected the call. The key is likely wrong, revoked, or out of credit.", detail: f.message, fix: { label: "Replace the key", action: "add_key" } };
  }
  if (f.code === "bad_voice" || f.code === "bad_profile" || f.code === "bad_trust") {
    return { summary: "That answer came back unusable. Try again, or say it a different way.", fix: { label: step === "voice" ? "Try again" : "Rephrase", action: step === "voice" ? "retry" : "rephrase" } };
  }
  if (f.status === 503 && (step === "channels" || step === "voice" || step === "done")) {
    return { summary: "A bridge stopped answering. Make sure it's running, then check again.", detail: f.message, fix: { label: "Check again", action: "recheck_channels" } };
  }
  return { summary: f.message, fix: { label: "Try again", action: "retry" } };
}
