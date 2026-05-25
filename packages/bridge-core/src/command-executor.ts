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
  }
}
