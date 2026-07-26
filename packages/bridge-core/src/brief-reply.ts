// Two-way morning brief: "done 1" / "snooze 2" / "dismiss 3".
//
// The brief numbers its items, and those numbers are the interface. Parsing is
// kept pure and deliberately STRICT: this drives a state change the owner
// cannot see the result of, so a false positive silently closes something they
// still needed. A message that is merely ABOUT being done ("I'm done for the
// day", "done with the Amex thing finally") must not match.

export type BriefAction = "done" | "snooze" | "dismiss";

export interface BriefReplyCommand {
  action: BriefAction;
  n: number;
}

/** Verbs the owner can use, mapped to the canonical action. */
const VERBS: Record<string, BriefAction> = {
  done: "done",
  did: "done",
  finished: "done",
  complete: "done",
  completed: "done",
  snooze: "snooze",
  later: "snooze",
  defer: "snooze",
  dismiss: "dismiss",
  drop: "dismiss",
  ignore: "dismiss",
};

/**
 * Parse a brief reply, or null when the text is not one.
 *
 * Accepts `done 1`, `1 done`, `done #1`, and `snooze 2` — with optional
 * surrounding whitespace and a trailing period. Nothing else: no trailing
 * prose, no multiple clauses. The whole message has to BE the command.
 */
export function parseBriefReply(text: string): BriefReplyCommand | null {
  const t = (text || "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (!t || t.length > 24) return null; // a real sentence is not a command

  // "done 1" | "done #1"
  let m = t.match(/^([a-z]+)\s+#?(\d{1,2})$/);
  if (m && VERBS[m[1]]) return mk(VERBS[m[1]], m[2]);

  // "1 done" | "#1 done"
  m = t.match(/^#?(\d{1,2})\s+([a-z]+)$/);
  if (m && VERBS[m[2]]) return mk(VERBS[m[2]], m[1]);

  return null;
}

function mk(action: BriefAction, raw: string): BriefReplyCommand | null {
  const n = Number.parseInt(raw, 10);
  // 0 is never a valid brief position, and a brief never lists 100 items.
  if (!Number.isFinite(n) || n < 1 || n > 99) return null;
  return { action, n };
}

/** Acknowledgement naming WHAT changed — the guard against acting on a typo. */
export function formatBriefAck(action: BriefAction, title: string): string {
  const verb =
    action === "done" ? "done" : action === "snooze" ? "snoozed a day" : "dismissed";
  const short = title.length > 60 ? `${title.slice(0, 57)}…` : title;
  return `✅ ${verb}: ${short}`;
}
