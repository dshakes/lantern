// Reaction commands — react to a bot reply with a specific emoji to
// trigger a command on that thread. Way faster than typing.
//
// Universe of reactions we recognize:
//
//   ⏸  (pause)          → pause auto-reply for THIS contact (1 hour)
//   🔇  (mute)           → same as ⏸ — pause this contact
//   ▶️  (resume)         → resume this contact (clear pause)
//   🟢  (resume)         → same
//   👍  (thumbs up)      → approve VIP draft (when reaction lands on the
//                         self-chat draft notification)
//   👎  (thumbs down)    → discard VIP draft
//   ❌  (cross)          → discard VIP draft (alternate)
//   📊  (chart)          → bot sends a status summary
//   ❤️   (heart)          → mark this contact as VIP
//   🗑   (trash)          → forget this contact's draft + facts
//
// What the bridge calls: each bridge translates its native reaction
// event into ReactionEvent and calls reaction-commands.handleReaction.
import type { ActionKind, BriefItem, RefKind } from "./command-center.ts";

export type ReactionAction =
  | "pause-contact"
  | "resume-contact"
  | "approve-draft"
  | "discard-draft"
  | "status"
  | "mark-vip"
  | "forget"
  // Self-eval signals on bot REPLIES (owner self-chat).
  //   - feedback-good: positive signal, logged for offline tuning.
  //   - feedback-bad-retry: re-prompt the LLM with critique + send a
  //     better version. Replaces the prior reply on the surface that
  //     supports edit (WhatsApp); appends a new reply on iMessage.
  | "feedback-good"
  | "feedback-bad-retry";

const EMOJI_MAP: Record<string, ReactionAction> = {
  // Pause variants
  "⏸": "pause-contact",
  "⏸️": "pause-contact",
  "🔇": "pause-contact",
  "🤫": "pause-contact",
  // Resume variants
  "▶️": "resume-contact",
  "▶": "resume-contact",
  "🟢": "resume-contact",
  "🔊": "resume-contact",
  // Approve / discard
  "👍": "approve-draft",
  "👎": "discard-draft",
  "❌": "discard-draft",
  // Status
  "📊": "status",
  "📈": "status",
  // VIP / forget
  "❤️": "mark-vip",
  "♥️": "mark-vip",
  "❤": "mark-vip",
  "🗑": "forget",
  "🗑️": "forget",
  // Self-eval reactions on bot replies. Distinct from 👍/👎 (which
  // are the VIP-draft approve/discard) so the user can both manage
  // drafts AND rate a reply on the same surface without ambiguity.
  "👏": "feedback-good",
  "⭐": "feedback-good",
  "🌟": "feedback-good",
  "💯": "feedback-good",
  "🔁": "feedback-bad-retry",
  "🔄": "feedback-bad-retry",
  "🤦": "feedback-bad-retry",
  "🤦‍♂️": "feedback-bad-retry",
  "🤦‍♀️": "feedback-bad-retry",
};

export function reactionToAction(emoji: string): ReactionAction | null {
  if (!emoji) return null;
  return EMOJI_MAP[emoji.trim()] ?? null;
}

export interface ReactionContext {
  // The action interpreted from the emoji.
  action: ReactionAction;
  // The contact thread the reaction was made in.
  threadJid: string;
  // Whether this reaction was on a message the BRIDGE sent (versus a
  // message from the contact). Most actions only make sense on bot
  // replies (pause/resume/approve/discard). Reacting to a contact's
  // own inbound is generally a no-op except for `mark-vip`.
  onBotReply: boolean;
  // Optional draftId — set when the reaction is on a VIP-draft
  // notification in self-chat. Routes approve/discard via the
  // control-plane draft endpoint.
  draftId?: string;
  // The bridge-message-id of the message the user reacted to. Required
  // for feedback-* actions so the bridge can look up which inbound
  // generated this reply and retry with critique.
  targetMsgId?: string;
}

export interface ReactionCallbacks {
  pauseContact: (jid: string) => Promise<void> | void;
  resumeContact: (jid: string) => Promise<void> | void;
  markVIP: (jid: string) => Promise<void> | void;
  forgetContact: (jid: string) => Promise<void> | void;
  sendStatus: (toJid: string) => Promise<void> | void;
  approveDraft: (draftId: string) => Promise<void> | void;
  discardDraft: (draftId: string) => Promise<void> | void;
  // Used to react back with a confirmation emoji on the reaction's
  // target message so the user gets visual feedback.
  acknowledge?: (targetThread: string, emoji: string) => Promise<void> | void;
  // Self-eval feedback. The bridge implements one or both; when not
  // implemented dispatchReaction returns {handled:false} and the
  // reaction is silently ignored.
  feedbackGood?: (threadJid: string, targetMsgId: string | undefined) => Promise<void> | void;
  feedbackBadRetry?: (threadJid: string, targetMsgId: string | undefined) => Promise<void> | void;
}

export async function dispatchReaction(
  ctx: ReactionContext,
  cb: ReactionCallbacks,
): Promise<{ handled: boolean; reason?: string }> {
  switch (ctx.action) {
    case "pause-contact":
      if (!ctx.onBotReply && !ctx.threadJid) return { handled: false, reason: "no target" };
      await cb.pauseContact(ctx.threadJid);
      await cb.acknowledge?.(ctx.threadJid, "✅");
      return { handled: true };
    case "resume-contact":
      await cb.resumeContact(ctx.threadJid);
      await cb.acknowledge?.(ctx.threadJid, "✅");
      return { handled: true };
    case "approve-draft":
      if (!ctx.draftId) return { handled: false, reason: "no draftId" };
      await cb.approveDraft(ctx.draftId);
      return { handled: true };
    case "discard-draft":
      if (!ctx.draftId) return { handled: false, reason: "no draftId" };
      await cb.discardDraft(ctx.draftId);
      return { handled: true };
    case "status":
      await cb.sendStatus(ctx.threadJid);
      return { handled: true };
    case "mark-vip":
      await cb.markVIP(ctx.threadJid);
      await cb.acknowledge?.(ctx.threadJid, "👑");
      return { handled: true };
    case "forget":
      await cb.forgetContact(ctx.threadJid);
      await cb.acknowledge?.(ctx.threadJid, "🗑");
      return { handled: true };
    case "feedback-good":
      if (!ctx.onBotReply) return { handled: false, reason: "feedback only on bot replies" };
      if (!cb.feedbackGood) return { handled: false, reason: "feedbackGood not implemented" };
      await cb.feedbackGood(ctx.threadJid, ctx.targetMsgId);
      await cb.acknowledge?.(ctx.threadJid, "🙏");
      return { handled: true };
    case "feedback-bad-retry":
      if (!ctx.onBotReply) return { handled: false, reason: "feedback only on bot replies" };
      if (!cb.feedbackBadRetry) return { handled: false, reason: "feedbackBadRetry not implemented" };
      await cb.feedbackBadRetry(ctx.threadJid, ctx.targetMsgId);
      // No ack — the retried reply itself is the acknowledgment.
      return { handled: true };
  }
}

// ── Brief reactions (Attention Engine one-tap layer) ─────────────────────────
//
// Reacting to the owner Brief (`?` / `whats up`) with an emoji is a one-tap
// accelerator for the numbered-reply grammar: 👍 on the Brief = act on the top
// item, ❌ = skip it, ❓ = peek, etc. Reactions are accelerators only — the LLM
// ranking that built the Brief is untouched; these maps add no keyword logic.
//
// PRECEDENCE: when a reaction's target message is a Brief tracked in a
// `ReactableLog`, brief semantics WIN over the legacy EMOJI_MAP above (❤️ on a
// Brief = confirm the top item, NOT mark-vip). The bridge only falls through to
// the legacy `dispatchReaction` when `ReactableLog.resolve()` misses, so legacy
// behavior is otherwise unchanged.

/** iMessage tapback association codes → the emoji they represent.
 *  2000 love, 2001 like, 2002 dislike, 2005 question. Laugh (2003),
 *  emphasize (2004), and every removal code (3xxx) → null (not actionable). */
export function tapbackToEmoji(associatedMessageType: number): string | null {
  switch (associatedMessageType) {
    case 2000:
      return "❤️";
    case 2001:
      return "👍";
    case 2002:
      return "👎";
    case 2005:
      return "❓";
    default:
      return null;
  }
}

const BRIEF_CONFIRM = new Set(["👍", "❤️", "✅", "🫡", "💯"]);
const BRIEF_REJECT = new Set(["👎", "❌", "🚫"]);
const BRIEF_SNOOZE = new Set(["⏰", "😴", "💤", "🕐"]);
const BRIEF_PEEK = new Set(["❓", "❔", "👀"]);
const BRIEF_FIRE = new Set(["🔥", "🚀", "⚡"]);

/** Map a reaction emoji to the ActionKind for a Brief item, aware of the item's
 *  kind. `auto_action` ALWAYS returns null — undoing an already-taken action
 *  needs a typed word, never a one-tap. Returns null for any emoji with no
 *  brief meaning. */
export function mapBriefReactionToAction(
  emoji: string,
  target: Pick<BriefItem, "ref">,
): ActionKind | null {
  const e = (emoji || "").trim();
  const ref = target.ref;
  if (ref === "auto_action") return null;

  if (BRIEF_REJECT.has(e)) return "skip";
  if (BRIEF_SNOOZE.has(e)) return "snooze";
  if (BRIEF_PEEK.has(e)) return "review";

  if (BRIEF_CONFIRM.has(e)) {
    switch (ref) {
      case "draft":
        return "send";
      case "commitment":
        return "done";
      case "thread":
        return "draft";
      case "life_event":
      case "news_item":
        return "act";
      default:
        return null;
    }
  }
  if (BRIEF_FIRE.has(e)) {
    switch (ref) {
      case "draft":
        return "send";
      case "commitment":
        return "act";
      case "thread":
        return "draft";
      case "life_event":
      case "news_item":
        return "act";
      default:
        return null;
    }
  }
  return null;
}

export interface BriefReactionHit {
  item: BriefItem;
  action: ActionKind;
}

const REACTABLE_MAX = 20;
const REACTABLE_TTL_MS = 60 * 60 * 1000; // 60 min

/** Ring buffer of recently-sent Briefs, keyed by the sent message id, so a
 *  reaction on a Brief resolves to a one-tap action on its top item. Reacting
 *  to a list means "the top thing" — resolve always targets items[0]. */
export class ReactableLog {
  private entries: Array<{ messageId: string; sentAt: number; items: BriefItem[] }> = [];

  remember(messageId: string, items: BriefItem[], now: number = Date.now()): void {
    if (!messageId || !items?.length) return;
    this.entries = this.entries.filter((e) => e.messageId !== messageId);
    this.entries.push({ messageId, sentAt: now, items });
    if (this.entries.length > REACTABLE_MAX) this.entries = this.entries.slice(-REACTABLE_MAX);
  }

  resolve(messageId: string, emoji: string, now: number = Date.now()): BriefReactionHit | null {
    if (!messageId) return null;
    const entry = this.entries.find((e) => e.messageId === messageId);
    if (!entry) return null;
    if (now - entry.sentAt > REACTABLE_TTL_MS) return null;
    const item = entry.items[0]; // top pick — reacting to a list means "the top thing"
    if (!item) return null;
    const action = mapBriefReactionToAction(emoji, item);
    if (!action) return null;
    return { item, action };
  }
}

// ── Attention snapshot ───────────────────────────────────────────────────────
// The last built Brief, flattened for the `/session/:tenantId/attention` HTTP
// endpoint (dashboard / external readers). `why` is merged in from the ranking.

export interface AttentionItem {
  n: number;
  ref: RefKind;
  id: string;
  icon: string;
  label: string;
  why?: string;
  defaultAction: ActionKind;
}

export interface AttentionSnapshot {
  generatedAt: number;
  items: AttentionItem[];
  counts: { waiting: number; drafts: number; commitments: number };
}

/** Flatten the Brief's items + ranking whys into a serializable snapshot. Pure.
 *  whys are keyed by `${ref}:${id}` (the attention ranker's key). */
export function buildAttentionSnapshot(
  items: BriefItem[],
  whys: Record<string, string> | undefined,
  now: number,
): AttentionSnapshot {
  return {
    generatedAt: now,
    items: items.map((it) => ({
      n: it.n,
      ref: it.ref,
      id: it.id,
      icon: it.icon,
      label: it.label,
      why: whys?.[`${it.ref}:${it.id}`],
      defaultAction: it.defaultAction,
    })),
    counts: {
      waiting: items.filter((i) => i.ref === "thread").length,
      drafts: items.filter((i) => i.ref === "draft").length,
      commitments: items.filter((i) => i.ref === "commitment").length,
    },
  };
}

/** Wrap the numbered Brief lines whose leading number is in `resolvedNumbers`
 *  with WhatsApp strikethrough (`~…~`). Header/`fyi:`/agents lines have no
 *  leading digit and are left untouched. Pure — for the WhatsApp living Brief. */
export function strikeBriefLines(text: string, resolvedNumbers: Set<number>): string {
  if (!resolvedNumbers.size) return text;
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(/^\s*(\d{1,2})\s/);
      if (m && resolvedNumbers.has(Number(m[1])) && !line.includes("~")) return `~${line.trim()}~`;
      return line;
    })
    .join("\n");
}
