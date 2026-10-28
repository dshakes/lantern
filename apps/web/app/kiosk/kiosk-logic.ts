// Pure kiosk helpers (ADR 0029) — no React, unit-tested in kiosk-logic.test.mts.

export const KIOSK_STORAGE_KEY = "lantern_kiosk";
export const IDLE_LIMIT_MS = 120_000;

export interface KioskMeta {
  expiresAt: string; // RFC3339, from POST /v1/kiosk/session
  mode: "replay";
}

export interface TourStep {
  id: string;
  title: string;
  href: string;
  body: string;
}

// Five steps over real pages. The copy says "replay" wherever an LLM answer
// appears: the kiosk has no provider key, answers are recorded, not live.
export const TOUR_STEPS: TourStep[] = [
  { id: "inbox", title: "Your inbox", href: "/inbox",
    body: "Every agent's recent runs land here. These were seeded for your private demo workspace." },
  { id: "run", title: "Run an agent", href: "/agents/support-triage",
    body: "Open the Run tab and send a ticket. Watch the step waterfall stream in. Answers are recorded (replay), not live." },
  { id: "budget", title: "Budgets stop runaway spend", href: "/agents/budget-capped",
    body: "This agent is already over its daily cap. Try to run it: the platform answers HTTP 402 before any model is called." },
  { id: "receipt", title: "Verify a receipt", href: "/proof",
    body: "Every completed run can issue an Ed25519-signed receipt. Paste one here to verify it without logging in." },
  { id: "sandbox", title: "Sandboxed execution", href: "/runtime",
    body: "Untrusted code runs in a microVM with an egress allow-list. Nothing here can reach your host." },
];

export function parseMeta(raw: string | null): KioskMeta | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Partial<KioskMeta>;
    if (typeof m.expiresAt === "string" && !Number.isNaN(Date.parse(m.expiresAt))) {
      return { expiresAt: m.expiresAt, mode: "replay" };
    }
  } catch {
    /* corrupt entry: treated as no session */
  }
  return null;
}

export function msLeft(meta: KioskMeta, now: number): number {
  return Math.max(0, Date.parse(meta.expiresAt) - now);
}

export function formatClock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function isIdle(lastInputAt: number, now: number): boolean {
  return now - lastInputAt >= IDLE_LIMIT_MS;
}

export function nextStep(i: number): number {
  return Math.min(i + 1, TOUR_STEPS.length - 1);
}
