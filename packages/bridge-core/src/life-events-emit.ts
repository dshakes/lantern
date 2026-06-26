// life-events-emit.ts — best-effort POST to /v1/life-events when the bridge
// surfaces a life-event (suggest/ping/digest/auto-act/undo). Wires the
// Automations dashboard to reality without blocking or breaking the reply path.
//
// Design rules:
//   * Pure-ish: caller injects the poster (authedFetch-backed or a mock).
//   * NEVER throws. Every error is swallowed + logged at debug level.
//   * NEVER blocks the reply/auto-act path — caller fire-and-forgets.
//   * Suppressed events (promo/personal/other) are NOT emitted (signal-only feed).

import type { LifeEvent } from "./life-events.js";

// --- Contract types ----------------------------------------------------------

// Status values accepted by POST /v1/life-events.
export type LifeEventEmitStatus =
  | "suggested"
  | "auto_acted"
  | "undone"
  | "dismissed"
  | "done";

export interface LifeEventPayload {
  kind: string;
  channel: string;
  status: LifeEventEmitStatus;
  urgency: string;
  summary: string;
  fields: Record<string, unknown>;
  idempotencyKey?: string;
  actionTaken?: string;
  sourcePreview?: string;
}

// Minimal logger interface — both bridges pass a pino child logger.
export interface EmitLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
}

// The poster is authedFetch (or a test mock). Receives the path + RequestInit.
export type LifeEventPoster = (
  path: string,
  init?: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status?: number }>;

// --- Helpers -----------------------------------------------------------------

function fieldsToRecord(f: LifeEvent["fields"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.amount !== undefined) out.amount = f.amount;
  if (f.currency !== undefined) out.currency = f.currency;
  if (f.dueDate !== undefined) out.dueDate = f.dueDate;
  if (f.payee !== undefined) out.payee = f.payee;
  if (f.merchant !== undefined) out.merchant = f.merchant;
  if (f.trackingNo !== undefined) out.trackingNo = f.trackingNo;
  if (f.carrier !== undefined) out.carrier = f.carrier;
  if (f.eta !== undefined) out.eta = f.eta;
  if (f.code !== undefined) out.code = f.code;
  if (f.place !== undefined) out.place = f.place;
  if (f.time !== undefined) out.time = f.time;
  return out;
}

// --- Core emitter ------------------------------------------------------------

/**
 * Emit a life-event to the control-plane Automations feed. Best-effort:
 * wraps everything in try/catch, never throws, never blocks.
 *
 * Call this fire-and-forget: `void emitLifeEvent(...)`.
 */
export async function emitLifeEvent(
  event: LifeEvent,
  status: LifeEventEmitStatus,
  opts: {
    idempotencyKey?: string;
    actionTaken?: string;
    summary: string;
    poster: LifeEventPoster;
    log?: EmitLogger;
  },
): Promise<void> {
  try {
    const payload: LifeEventPayload = {
      kind: event.kind,
      channel: event.channel || "unknown",
      status,
      urgency: event.urgency,
      summary: opts.summary,
      fields: fieldsToRecord(event.fields),
      idempotencyKey: opts.idempotencyKey,
      actionTaken: opts.actionTaken,
      // Truncate rawText to 200 chars so the feed preview is readable.
      sourcePreview: (event.rawText || "").slice(0, 200) || undefined,
    };

    const res = await opts.poster("/v1/life-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      opts.log?.debug(
        { status: res.status, kind: event.kind, emitStatus: status },
        "life-event emit non-2xx (best-effort, ignoring)",
      );
    }
  } catch (err) {
    // Best-effort: swallow and log at debug; never throw, never block.
    opts.log?.debug(
      { err: String(err), kind: event.kind, emitStatus: status },
      "life-event emit failed (best-effort, swallowed)",
    );
  }
}
