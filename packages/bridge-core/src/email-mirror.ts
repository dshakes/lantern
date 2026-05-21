// Mirror status messages to email via the user's Gmail connector.
// Used by both bridges so a single inbox setup serves both channels.
// Routes through /v1/connectors/gmail/execute so the connector's
// label + skip-inbox handling applies — status mail never dilutes
// the user's main inbox.
//
// De-dup window prevents spam when the same status fires repeatedly
// (e.g., a flapping connection). Subject sanitization strips emoji
// and non-ASCII so Gmail's web view doesn't render mojibake.

import type { Logger } from "pino";
import { authedFetch } from "./auth.js";

const EMAIL_DEDUP_MS = 30_000;
const EMAIL_MIN_LEN = 8;
const EMAIL_LABEL = "lantern";

export interface EmailMirrorOptions {
  // Optional prefix to disambiguate which bridge a status came from
  // (e.g., "iMessage" or "WhatsApp"). Renders as "Lantern iMessage:
  // ...". Skip to use the generic "Lantern: ..." prefix.
  subjectPrefix?: string;
}

export class EmailMirror {
  private logger: Logger;
  private lastSentAt: Map<string, number> = new Map();
  private subjectPrefix: string;

  constructor(logger: Logger, opts: EmailMirrorOptions = {}) {
    this.logger = logger.child({ component: "email-mirror" });
    this.subjectPrefix = opts.subjectPrefix || "Lantern";
  }

  // Send `text` as an email to the configured owner address. No-op
  // when LANTERN_OWNER_EMAIL isn't set. Fire-and-forget safe.
  async send(text: string): Promise<void> {
    const to = process.env.LANTERN_OWNER_EMAIL;
    if (!to) return;
    if (text.length < EMAIL_MIN_LEN) return;
    const lastAt = this.lastSentAt.get(text);
    if (lastAt && Date.now() - lastAt < EMAIL_DEDUP_MS) return;
    this.lastSentAt.set(text, Date.now());

    const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
    const subject = `${this.subjectPrefix}: ${sanitizeSubject(firstLine) || "status"}`;

    try {
      const res = await authedFetch(`/v1/connectors/gmail/execute?action=send_message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to,
          subject,
          body: text,
          label: EMAIL_LABEL,
          skipInbox: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.logger.warn({ status: res.status, body: body.slice(0, 200) }, "email mirror send failed");
        return;
      }
      try {
        const json = (await res.clone().json()) as Record<string, unknown> & {
          result?: { labelWarning?: string };
          labelWarning?: string;
        };
        const warn = json?.result?.labelWarning ?? json?.labelWarning;
        if (warn) {
          this.logger.warn(
            { warn },
            "email mirror sent but label/skip-inbox failed — reconnect Gmail at /connectors so the new OAuth scope (gmail.modify) is granted",
          );
        }
      } catch {}
    } catch (err) {
      this.logger.warn({ err }, "email mirror exception");
    }
  }
}

// Sanitize a string for use as an RFC 822 Subject: header. Strips
// emoji, markdown, and non-ASCII so Gmail doesn't mojibake when
// re-interpreting UTF-8 as Latin-1 in the header path.
function sanitizeSubject(raw: string): string {
  let s = raw.split("\n", 1)[0];
  s = s.replace(/[*_`~]+/g, "");
  s = s.replace(/\p{Extended_Pictographic}/gu, "");
  s = s.replace(/[\u{1F000}-\u{1FFFF}]/gu, "");
  s = s.replace(/[\u{2600}-\u{27BF}]/gu, "");
  s = s.replace(/[\u{2300}-\u{23FF}]/gu, "");
  s = s.replace(/[^\x20-\x7E]/g, "-");
  s = s.replace(/[-\s]{2,}/g, " ").replace(/^[-\s]+|[-\s]+$/g, "");
  return s.slice(0, 100).trim();
}
