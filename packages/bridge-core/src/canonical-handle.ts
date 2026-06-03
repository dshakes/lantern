// Canonical handle key — collapses a contact's per-channel address into a
// single stable bucket key so the SAME human is ONE bucket across channels.
//
// The local memory stores (episodic-memory, social-graph, dislike-memory)
// historically bucketed by the RAW channel handle. That siloed the same
// person: a WhatsApp jid ("15125551234@s.whatsapp.net" / "...@lid") and an
// iMessage handle ("+15125551234") for the same human landed in different
// buckets, so a lesson learned on one channel never surfaced on the other.
//
// This helper mirrors the control-plane's identity.go canonicalization so
// the on-disk bucketing matches the server-side person graph:
//   - phone-like → DIGITS ONLY (jid suffix stripped, '+' / spaces dropped)
//   - email (incl. iMessage email handles) → lowercased, kept as-is
//   - WhatsApp "@lid" (privacy id) and "@g.us" (group) are NOT
//     phone-canonicalizable — keep them verbatim so a group/lid bucket is
//     never mangled into a bogus phone bucket.
//
// Pure + dependency-free + total: never throws, never does I/O. Safe to call
// on every record/read in the hot path.

// US/E.164-ish phone shapes, applied to the digit string AFTER any jid
// suffix is stripped. Matches contact-resolver.tryParsePhone semantics:
//   - 10 digits → US national (canonicalized to 1XXXXXXXXXX so a bare
//     10-digit handle and its +1-prefixed twin share a bucket)
//   - 11 digits starting with 1 → US with country code
//   - 8..15 digits → already country-coded international
// Anything outside these shapes is treated as a non-phone (opaque) handle.

/** Reduce a string to its decimal digits only (drops '+', spaces, dashes). */
function digitsOnly(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) out += s[i];
  }
  return out;
}

/**
 * Normalize a digit string to a canonical phone key, or null when the shape
 * isn't phone-like. Returns digits only (no leading '+'), with US numbers
 * promoted to include the "1" country code so the bare-10-digit and
 * +1-prefixed variants of the same number collapse to one bucket.
 */
function canonicalPhone(digits: string): string | null {
  if (!digits) return null;
  if (/^\d{10}$/.test(digits)) return "1" + digits; // US national → +1 form
  if (/^1\d{10}$/.test(digits)) return digits; // US with country code
  if (/^\d{8,15}$/.test(digits)) return digits; // already country-coded intl
  return null;
}

/**
 * Canonicalize a raw channel handle into a stable cross-channel bucket key.
 *
 * Semantics:
 *   - "15125551234@s.whatsapp.net" → "15125551234"
 *   - "5125551234@c.us"            → "15125551234"   (US national promoted)
 *   - "+1 (512) 555-1234"          → "15125551234"
 *   - "919493678486"               → "919493678486"  (intl, kept)
 *   - "alice@example.com"          → "alice@example.com" (lowercased)
 *   - "8472913@lid"                → "8472913@lid"   (privacy id — NOT phone)
 *   - "120363...@g.us"             → "120363...@g.us" (group — NOT phone)
 *
 * Total: any input that isn't recognizably a phone or email falls through to
 * a trimmed, lowercased verbatim key — so the worst case is no-merge (today's
 * behavior), never a wrong merge or a crash.
 */
export function canonicalHandle(handle: string): string {
  const raw = (handle || "").trim();
  if (!raw) return raw;

  const at = raw.indexOf("@");
  if (at >= 0) {
    const suffix = raw.slice(at).toLowerCase();
    // Privacy ids and groups are NEVER phone-canonicalizable — verbatim.
    if (suffix === "@lid" || suffix === "@g.us") {
      return raw.slice(0, at) + suffix;
    }
    const local = raw.slice(0, at);
    // WhatsApp / iMessage phone jids carry a dialable number on the left.
    if (/^\+?\d[\d\s().-]*$/.test(local)) {
      const phone = canonicalPhone(digitsOnly(local));
      if (phone) return phone;
    }
    // Otherwise it's an email-style handle (iMessage email, gmail, etc.).
    return raw.toLowerCase();
  }

  // No '@' — either a bare phone or an opaque token.
  if (/^\+?[\d\s().-]+$/.test(raw)) {
    const phone = canonicalPhone(digitsOnly(raw));
    if (phone) return phone;
  }
  return raw.toLowerCase();
}
