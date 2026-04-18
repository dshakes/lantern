// Pure validation + security helpers used by the REST + WS layer.
// Split out from index.ts so tests can exercise them without spinning up
// an Express server on module load.

// WhatsApp JID servers we accept. `@lid` is the newer privacy-safe form used
// in groups; `@g.us` is groups; `@s.whatsapp.net` is standard DMs.
const JID_SUFFIXES = ["@s.whatsapp.net", "@g.us", "@lid"] as const;

/**
 * Validate a WhatsApp JID as it arrives from an HTTP request.
 *
 * We enforce:
 *  - `typeof raw === "string"`
 *  - length between 1 and 128 chars
 *  - no whitespace or C0 control characters
 *  - one of the known WhatsApp server suffixes
 *
 * We deliberately do *not* enforce a phone-number shape on the localpart:
 * the `@lid` IDs WhatsApp now uses for group mentions are opaque and we'd
 * reject legitimate traffic if we tried.
 */
export function isValidJid(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  if (raw.length === 0 || raw.length > 128) return false;
  if (/[\s\x00-\x1f]/.test(raw)) return false;
  return JID_SUFFIXES.some((s) => raw.endsWith(s));
}

/**
 * True iff `raw` is a valid JID *and* is a group JID (`@g.us`). Used on the
 * /bot/group/* endpoints so a caller can't accidentally or intentionally
 * opt a DM into group monitoring.
 */
export function isValidGroupJid(raw: unknown): raw is string {
  return isValidJid(raw) && (raw as string).endsWith("@g.us");
}

/**
 * Constant-time string equality. Used to compare the shared bridge token
 * without leaking length or content via timing.
 *
 * Correctness note: we still short-circuit on length mismatch because
 * there's nothing useful to hide — the attacker already knows the correct
 * length by observing any past success, and an early return here is safer
 * than pretending to compare against garbage bytes.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
