// Shared command executor.
//
// Bridges parse incoming owner-typed text via parseNLCommand() and pass
// the result here with a callback bag. We dispatch on action and call
// the right callback. This way both bridges (WhatsApp + iMessage) speak
// the same command vocabulary — natural language OR slash — without
// duplicating the dispatch logic.
//
// The bridge keeps ownership of:
//   - The current bot state (muted, paused contacts, monitored chats)
//   - The way to reply in the thread the command came from
//   - The auto-resume timer for time-bounded mutes
//
// This module is pure dispatch — no state, no async beyond the
// callbacks the bridge supplies.

import type { ParsedCommand } from "./nl-commands.js";
import { renderHelp } from "./nl-commands.js";

export interface CommandContext {
  // Where to reply. The bridge resolves this to its own send-self
  // or send-to-thread path.
  reply: (text: string) => Promise<void> | void;
  // Mute the bot. durationMs undefined = indefinite; otherwise the
  // bridge sets an auto-resume timer.
  mute: (durationMs?: number) => Promise<void> | void;
  unmute: () => Promise<void> | void;
  // Status / list callbacks return their own formatted bodies so the
  // bridge can include channel-specific data (chat.db rowid for
  // iMessage, paired phone number for WhatsApp).
  statusBody: () => Promise<string> | string;
  listPaused: () => Promise<string> | string;
  listChats: () => Promise<string> | string;
  resumeAll: () => Promise<void> | void;
  // Personal-docs toggle. enabled=true allows local-file Q&A in the
  // owner's self-chat. Default ON. The bridge persists the bool.
  setDocsEnabled?: (enabled: boolean) => Promise<void> | void;
  // Master kill switch — when true the bridge MUST refuse to do
  // anything except listen for the off command. Survives restarts.
  setKillSwitch?: (engaged: boolean) => Promise<void> | void;
  // Draft-approval queue toggle. When ON, VIPs + unfamiliar contacts
  // queue drafts for the owner to approve. Persisted by the bridge.
  setApprovals?: (enabled: boolean) => Promise<void> | void;
  // VIP list management. listVips returns a formatted body; clearVips
  // removes every entry.
  listVips?: () => Promise<string> | string;
  clearVips?: () => Promise<number> | number;
  // Master switch for panic channels (Pushover/Twilio voice/macOS
  // notification). Primary alerts (WA/iM/email) always fire regardless.
  setEscalation?: (enabled: boolean) => Promise<void> | void;
  // Just the Pushover siren channel toggle.
  setPushover?: (enabled: boolean) => Promise<void> | void;
  // Outbound-call dispatcher. Receives the parsed intent (target +
  // optional message + reason) and is responsible for: resolving the
  // contact name → phone, classifying risk tier, drafting the
  // pre-flight summary, getting owner ack via pendingOffers, and
  // placing the actual Twilio call. Bridges implement this with their
  // own contact-resolution + pendingOffers cache.
  placeOutboundCall?: (req: {
    intent: "conference" | "voicemail" | "task";
    target: string;
    message?: string;
    reason?: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
  // Channel name shown in human replies ("iMessage" or "WhatsApp").
  channelLabel: string;
}

export async function executeCommand(cmd: ParsedCommand, ctx: CommandContext): Promise<void> {
  switch (cmd.action) {
    case "mute": {
      await ctx.mute(cmd.durationMs);
      // For time-bounded mutes, the echo already includes the
      // duration ("auto-reply paused for 2 hours"). For indefinite
      // mutes, append a how-to-resume hint.
      const suffix = cmd.durationMs
        ? " — i'll auto-resume."
        : " — say *resume* when ready.";
      await ctx.reply(`⏸ ${cmd.echo}${suffix}`);
      return;
    }
    case "unmute": {
      await ctx.unmute();
      await ctx.reply(`✅ ${cmd.echo}`);
      return;
    }
    case "status": {
      const body = await ctx.statusBody();
      await ctx.reply(body);
      return;
    }
    case "list-paused": {
      const body = await ctx.listPaused();
      await ctx.reply(body);
      return;
    }
    case "list-chats": {
      const body = await ctx.listChats();
      await ctx.reply(body);
      return;
    }
    case "resume-all": {
      await ctx.resumeAll();
      await ctx.reply(`▶️ ${cmd.echo}`);
      return;
    }
    case "ping": {
      await ctx.reply(`🏓 pong — ${ctx.channelLabel} bridge alive`);
      return;
    }
    case "help": {
      await ctx.reply(renderHelp());
      return;
    }
    case "docs-on": {
      if (ctx.setDocsEnabled) await ctx.setDocsEnabled(true);
      await ctx.reply(`${cmd.echo}\nask in your self-chat: "what's my passport number?" / "find my I-485 receipt"`);
      return;
    }
    case "docs-off": {
      if (ctx.setDocsEnabled) await ctx.setDocsEnabled(false);
      await ctx.reply(`${cmd.echo}\nfile-search is paused. send "docs on" to re-enable.`);
      return;
    }
    case "killswitch-on": {
      if (ctx.setKillSwitch) await ctx.setKillSwitch(true);
      // We still acknowledge this ONE message so the user has a
      // confirmation the killswitch took effect. After this, no
      // outbound activity until "kill switch off".
      await ctx.reply(`${cmd.echo}\nbot will ignore ALL messages until you send: *kill switch off*`);
      return;
    }
    case "killswitch-off": {
      if (ctx.setKillSwitch) await ctx.setKillSwitch(false);
      await ctx.reply(`${cmd.echo}\nauto-reply + docs are back online.`);
      return;
    }
    case "approvals-on": {
      if (ctx.setApprovals) await ctx.setApprovals(true);
      await ctx.reply(`${cmd.echo}\nVIP + unfamiliar inbound now queues a draft. approve in the dashboard at /personal/drafts.`);
      return;
    }
    case "approvals-off": {
      if (ctx.setApprovals) await ctx.setApprovals(false);
      await ctx.reply(`${cmd.echo}\nVIPs stay silent (you handle them); unfamiliar contacts get an authentic auto-reply.`);
      return;
    }
    case "vip-list": {
      const body = ctx.listVips ? await ctx.listVips() : "VIP listing not available on this channel";
      await ctx.reply(body);
      return;
    }
    case "vip-clear": {
      const removed = ctx.clearVips ? await ctx.clearVips() : 0;
      await ctx.reply(removed > 0 ? `${cmd.echo} — removed ${removed}` : "no VIPs to clear");
      return;
    }
    case "escalation-on": {
      if (ctx.setEscalation) await ctx.setEscalation(true);
      await ctx.reply(`${cmd.echo}\nphone-ring channels (pushover siren, voice call, macOS notif) will fire on life-threat. primary alerts (WA/iM/email) were already on.`);
      return;
    }
    case "escalation-off": {
      if (ctx.setEscalation) await ctx.setEscalation(false);
      await ctx.reply(`${cmd.echo}\nyou'll still get WA/iM/email on life-threat — just no phone siren or call. say *escalation on* to re-enable.`);
      return;
    }
    case "pushover-on": {
      if (ctx.setPushover) await ctx.setPushover(true);
      await ctx.reply(`${cmd.echo}\nPushover siren (priority-2, bypasses iPhone silent + DND) will fire on life-threat.`);
      return;
    }
    case "pushover-off": {
      if (ctx.setPushover) await ctx.setPushover(false);
      await ctx.reply(`${cmd.echo}\nPushover siren disabled. other channels (WA/iM/email/voice/macOS) unchanged.`);
      return;
    }
    case "call-conference":
    case "call-voicemail":
    case "call-task": {
      if (!ctx.placeOutboundCall) {
        await ctx.reply("outbound calls aren't wired on this channel yet");
        return;
      }
      const intent = cmd.action === "call-conference" ? "conference" :
                     cmd.action === "call-voicemail" ? "voicemail" : "task";
      const target = (cmd as ParsedCommand).callTarget || "";
      if (!target) {
        await ctx.reply("who should I call? format: *call <name>* or *conference me with <name>*");
        return;
      }
      const res = await ctx.placeOutboundCall({
        intent,
        target,
        message: (cmd as ParsedCommand).callMessage,
        reason: (cmd as ParsedCommand).callReason,
      });
      if (!res.ok) {
        await ctx.reply(`📞 couldn't place call: ${res.reason || "unknown error"}`);
      }
      return;
    }
  }
}
