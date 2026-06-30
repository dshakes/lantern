// known-people.ts — fuse WHO the owner cares about (profile relationships) with
// WHO they actually talk to (real thread activity) into one grounding block.
//
// The intelligence the literal name-matcher lacked: a model of the owner's
// people that the LLM can reason over. So "what did <wife> say" resolves to her
// real thread, and the bot never claims a top contact went silent. Pure; no I/O.

export interface ProfilePerson {
  /** Display name as the owner refers to them ("Manasa"). */
  name: string;
  /** Short relationship label ("wife", "brother-in-law"), if clean. */
  relationship?: string;
}

// Markdown/section-note artifacts that are NOT people (the profile's
// Relationships section mixes in guidance bullets like "brothers-in-law never
// addressed as bava" and "specific address mappings: see below").
const NOTE_WORD = /\b(never|always|address|mapping|specific|see|bava)\b/i;

/**
 * Turn a raw (name, label) pair parsed from owner-profile.md into a CLEAN
 * person, or null if it's a parsing artifact / not a person. Names must look
 * like names; labels are trimmed to a short kinship term (the descriptive tail
 * — "wife — ALWAYS address as…" — is dropped). Verified against real profiles:
 * without this the block fills with markdown garbage.
 */
export function normalizeProfilePerson(name: string, rawLabel: string): ProfilePerson | null {
  const nm = (name || "").trim();
  if (!nm || nm.length > 40) return null;
  if (/[*:—|]/.test(nm)) return null; // markdown / multi-field artifact
  const toks = nm.split(/\s+/);
  if (toks.length > 3) return null; // a sentence, not a name
  if (!/^[\p{L}][\p{L} .'-]*$/u.test(nm)) return null; // letters/spaces only
  if (NOTE_WORD.test(nm)) return null;
  // Short label: take up to the first separator, keep at most 2 words, and only
  // if it reads like a relationship (not a note like "lives in Dublin").
  let label = (rawLabel || "").split(/[—:,(\n]/)[0].trim().toLowerCase().replace(/\s+/g, " ");
  if (label.split(" ").length > 2 || NOTE_WORD.test(label) || /\b(lives|currently|staying|works|based)\b/.test(label)) {
    label = "";
  }
  return { name: nm, relationship: label || undefined };
}

export interface ActiveThread {
  /** The messaging handle/jid this thread is on. */
  handle: string;
  /** Resolved display name for the handle, if known. */
  name?: string;
  /** Messages exchanged in the recency window. */
  msgs: number;
  /** Epoch ms of the most recent message. */
  lastTs: number;
}

export interface KnownPerson {
  name: string;
  relationship?: string;
  handle?: string;
  msgs?: number;
  lastTs?: number;
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/\s+/).filter(Boolean);
}

// Do a profile name and a thread name refer to the same person? Whole-word
// overlap on the first name (handles "Manasa" ↔ "Manasa Sesham"), never a
// substring ("Man" ↔ "Manish").
function sameName(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const ta = tokens(a), tb = tokens(b);
  if (a.toLowerCase() === b.toLowerCase()) return true;
  return ta.some((w) => w.length >= 2 && tb.includes(w));
}

/**
 * Merge profile people with active threads. Profile people rank first (the
 * owner explicitly told us they matter), each enriched with their most-active
 * matching thread; then any remaining active threads (named) backfill by
 * activity. Deduped by name.
 */
export function fuseKnownPeople(
  profile: ProfilePerson[],
  threads: ActiveThread[],
): KnownPerson[] {
  const out: KnownPerson[] = [];
  const usedThread = new Set<number>();
  const seenName = new Set<string>();

  for (const p of profile) {
    let bestIdx = -1;
    let bestMsgs = -1;
    threads.forEach((t, i) => {
      if (usedThread.has(i)) return;
      if (sameName(p.name, t.name) && t.msgs > bestMsgs) {
        bestMsgs = t.msgs;
        bestIdx = i;
      }
    });
    const t = bestIdx >= 0 ? threads[bestIdx] : undefined;
    if (t) usedThread.add(bestIdx);
    const key = p.name.toLowerCase();
    if (seenName.has(key)) continue;
    seenName.add(key);
    out.push({ name: p.name, relationship: p.relationship, handle: t?.handle, msgs: t?.msgs, lastTs: t?.lastTs });
  }

  const extra = threads
    .map((t, i) => ({ t, i }))
    .filter((x) => !usedThread.has(x.i) && x.t.name && !seenName.has(x.t.name!.toLowerCase()))
    .sort((a, b) => b.t.msgs - a.t.msgs);
  for (const { t } of extra) {
    seenName.add(t.name!.toLowerCase());
    out.push({ name: t.name!, handle: t.handle, msgs: t.msgs, lastTs: t.lastTs });
  }

  // Title-case profile-derived names (the profile stores them lowercased);
  // leave already-mixed-case names (from the AddressBook) untouched.
  for (const p of out) {
    if (p.name === p.name.toLowerCase()) p.name = p.name.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  }
  // Most-relevant first: people you actively message (by volume) lead — so the
  // wife (227 msgs) ranks above a friend with no recent activity — then the
  // rest (identity-only grounding) keep profile order. Stable.
  return out
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.msgs ?? 0) - (a.p.msgs ?? 0) || a.i - b.i)
    .map((x) => x.p);
}

function friendlyAgo(lastTs: number, nowMs: number): string {
  const days = Math.floor((nowMs - lastTs) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return "a while ago";
}

/**
 * Render the fused people as a compact grounding block for the owner's prompt.
 * Returns "" when there's nothing to say.
 */
export function buildKnownPeopleBlock(
  profile: ProfilePerson[],
  threads: ActiveThread[],
  opts: { nowMs: number; max?: number } = { nowMs: 0 },
): string {
  const now = opts.nowMs || 0;
  const max = opts.max ?? 12;
  const people = fuseKnownPeople(profile, threads).slice(0, max);
  if (people.length === 0) return "";
  const lines = people.map((p) => {
    const rel = p.relationship ? ` — your ${p.relationship}` : "";
    const act = p.msgs ? ` · ${p.msgs} msgs/30d, last ${friendlyAgo(p.lastTs ?? now, now)}` : "";
    const h = p.handle ? ` · ${p.handle}` : "";
    return `- ${p.name}${rel}${act}${h}`;
  });
  return [
    "# Your people (who you actually talk to — ground every name on THIS)",
    "Resolve who the owner means from this list, not guesswork. If they ask about",
    "someone listed here with a handle, that IS their thread — never claim a top",
    "contact went silent or that you can't find them; pull their handle's messages.",
    ...lines,
  ].join("\n");
}
