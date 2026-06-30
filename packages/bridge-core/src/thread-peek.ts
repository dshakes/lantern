/**
 * thread-peek.ts — detect owner intent to review a specific contact's recent messages.
 *
 * Pure function; no I/O, no side-effects.
 */

// Verb phrases that mean "send/compose" — exclude these even when the
// sentence otherwise resembles a peek.
const SEND_VERB_RE =
  /^(?:send|message|text|dm|reply\s+to|write\s+to|tell|ask|remind|ping|forward)\b/i;

// ponytail: explicit per-family patterns — readable and testable over one mega-regex.
type Extractor = (q: string) => string | null;

const EXTRACTORS: Extractor[] = [
  // "messages from X" / "texts with X" — anywhere in the sentence (after see/show/get/…)
  (q) => {
    const m =
      /(?:^|\s)(?:messages?|texts?|thread|chat)\s+(?:from|with)\s+(.+?)$/i.exec(
        q
      );
    return m ? m[1].trim() : null;
  },

  // "catch me up on X" / "catch me up on X's messages"
  (q) => {
    const m =
      /^catch\s+me\s+up\s+on\s+(.+?)(?:'s\s+(?:messages?|texts?|thread|chat))?$/i.exec(
        q
      );
    return m ? m[1].trim() : null;
  },

  // "latest from X" (optionally prefixed with read/see/check/get/pull up + "the")
  (q) => {
    const m =
      /^(?:(?:read|see|check|get|pull\s+up)\s+)?(?:the\s+)?latest?\s+from\s+(.+)$/i.exec(
        q
      );
    return m ? m[1].trim() : null;
  },

  // "show me what X said/wrote/sent" or "what X said/wrote/sent"
  (q) => {
    const m =
      /^(?:show\s+(?:me\s+)?)?what\s+(.+?)\s+(?:said|wrote|sent|messaged|replied)$/i.exec(
        q
      );
    return m ? m[1].trim() : null;
  },

  // "what did X say/write/send/message/text/reply" — comm verbs only, not "cover"
  (q) => {
    const m =
      /^what\s+did\s+(.+?)\s+(?:say|write|send|message|text|reply)$/i.exec(q);
    return m ? m[1].trim() : null;
  },

  // "see/show/read/check/get/pull up X's messages|texts|thread"
  (q) => {
    const m =
      /^(?:see|show(?:\s+me)?|read|check|get|pull\s+up)\s+(.+?)'s\s+(?:messages?|texts?|thread|chat)$/i.exec(
        q
      );
    return m ? m[1].trim() : null;
  },
];

export function looksLikeThreadPeek(
  query: string
): { contact: string } | null {
  const q = query.trim();
  if (!q) return null;
  if (SEND_VERB_RE.test(q)) return null;

  for (const extract of EXTRACTORS) {
    const contact = extract(q);
    if (contact) return { contact };
  }
  return null;
}
