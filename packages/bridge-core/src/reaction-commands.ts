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

export type ReactionAction =
  | "pause-contact"
  | "resume-contact"
  | "approve-draft"
  | "discard-draft"
  | "status"
  | "mark-vip"
  | "forget";

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
  }
}
