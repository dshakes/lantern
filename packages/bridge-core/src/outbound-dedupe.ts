// Outbound duplicate-send guard.
//
// The same auto-reply went out twice in the field ("can we chat after 6 PM
// today?" sent back-to-back). The reply pipeline has several paths that can
// dispatch a generated reply — the live handler, the overnight/quiet-hours
// replay drain, and burst sends — and the existing dedup is time-based and
// checked at the wrong layer, leaving a race window.
//
// This is a last-line, path-independent backstop applied at the lowest send
// call: if the EXACT same text was just sent to the same recipient inside a
// short window, drop the duplicate. It deliberately lives below all the
// generation paths so it catches a double-send no matter which path produced
// it (live+replay, retry, double-dispatch).
//
// Scope is intentionally narrow: trivial acks ("ok", "yeah", "👍") are
// exempt because a human genuinely might fire two in a row, and they're
// cheap. Anything substantive that repeats verbatim within the window is
// almost certainly a bug, not intent.

/** Normalize for comparison: trim, collapse whitespace, lowercase. */
function normalizeForDup(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface LastSend {
  text: string;
  at: number;
}

/**
 * Decide whether `text` to `key` is a duplicate of the immediately-previous
 * send within `windowMs`. Pure — the caller owns the per-recipient `prev`
 * record and updates it after a real send. Trivial/short texts (< minLen
 * normalized chars) are never treated as duplicates.
 */
export function isDuplicateSend(
  prev: LastSend | undefined,
  text: string,
  now: number,
  windowMs: number,
  minLen = 6,
): boolean {
  const norm = normalizeForDup(text);
  if (norm.length < minLen) return false;
  if (!prev) return false;
  if (now - prev.at >= windowMs) return false;
  return normalizeForDup(prev.text) === norm;
}

/**
 * Stateful convenience wrapper around isDuplicateSend. Keeps the
 * last-sent record per recipient in a bounded Map. `check` returns true when
 * the send should be SUPPRESSED as a duplicate; when it returns false it has
 * already recorded the send, so the caller just proceeds to transmit.
 */
export class OutboundDedupe {
  private readonly last = new Map<string, LastSend>();
  constructor(
    private readonly windowMs = 90_000,
    private readonly maxKeys = 2000,
    private readonly minLen = 6,
  ) {}

  /** True → suppress (duplicate). False → recorded; caller should send. */
  check(key: string, text: string, now: number): boolean {
    if (isDuplicateSend(this.last.get(key), text, now, this.windowMs, this.minLen)) {
      return true;
    }
    this.last.set(key, { text, at: now });
    if (this.last.size > this.maxKeys) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }
    return false;
  }
}
