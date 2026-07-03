// REGRESSION: the 👎/🔁 critique-and-retry pass must run in an ISOLATED
// control-plane session (`${jid}::critique`), never the contact's live
// session — otherwise the retry appends the contact's original inbound as a
// duplicate "user" turn onto their real conversation history and poisons
// every future reply (the systemHint carrying critique context is transient
// and never persisted).
//
// Same harness style as severe-fixes.test.ts: construct the class, drive the
// private method via bracket access, never connect to WhatsApp.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { WhatsAppSession } from "../src/session.js";

const logger = pino({ level: "silent" });

let tmpRoot: string;
let prevCwd: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lantern-critique-iso-"));
  prevCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("handleBadFeedbackRetry session isolation", () => {
  it("uses `${jid}::critique` as the session key, never the bare contact jid", async () => {
    const s = new WhatsAppSession("test-tenant", logger);
    const contactJid = "15551234567@s.whatsapp.net";
    const msgId = "MSG1";

    const respondTo = vi.fn().mockResolvedValue("a better reply");
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "SENT1" } });

    const priv = s as unknown as {
      bridgeReplyMeta: Map<string, unknown>;
      dislikeMemory: { record: (e: unknown) => Promise<void> };
      agent: { respondTo: typeof respondTo };
      socket: { sendMessage: typeof sendMessage };
      confirmToSelf: (t: string) => Promise<void>;
      logActivity: (...a: unknown[]) => void;
      handleBadFeedbackRetry: (jid: string, msgId?: string) => Promise<void>;
    };

    priv.bridgeReplyMeta = new Map([
      [
        msgId,
        {
          jid: contactJid,
          inboundText: "when are you coming?",
          replyText: "I shall arrive presently.",
          systemHint: "base hint",
          surface: "contact-reply",
        },
      ],
    ]);
    priv.dislikeMemory = { record: vi.fn().mockResolvedValue(undefined) } as never;
    priv.agent = { respondTo } as never;
    priv.socket = { sendMessage } as never;
    priv.confirmToSelf = vi.fn().mockResolvedValue(undefined);
    priv.logActivity = vi.fn();

    await priv.handleBadFeedbackRetry(contactJid, msgId);

    // The critique turn ran in the isolated session…
    expect(respondTo).toHaveBeenCalledTimes(1);
    expect(respondTo.mock.calls[0][0]).toBe(`${contactJid}::critique`);
    // …and never with the bare contact jid (the live-session key).
    expect(respondTo.mock.calls[0][0]).not.toBe(contactJid);

    // The corrected reply still goes to the real contact thread.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe(contactJid);
  });
});
