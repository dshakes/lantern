import type { Logger } from "pino";

// Shape returned by classify(). null = couldn't classify (network/parse error).
export type Attention = {
  urgent: boolean;
  reason: string;
  summary: string;
};

// AttentionClassifier asks the Lantern control-plane (via /v1/completions,
// routed through the tenant's configured LLM providers) whether an incoming
// DM needs the owner's personal attention. Works independently of the agent
// auto-reply — the whole point is to flag urgent DMs even when the bot is
// muted or paused for that contact.
export class AttentionClassifier {
  private apiUrl: string;
  private token: string;
  private logger: Logger;
  // jid -> last-notified epoch ms. We suppress repeat notifications from the
  // same contact within dedupMs so one noisy thread doesn't hammer self-chat.
  private lastNotified: Map<string, number> = new Map();
  private dedupMs: number;

  constructor(logger: Logger) {
    this.apiUrl = (process.env.LANTERN_API_URL || "http://localhost:8080").replace(/\/$/, "");
    this.token = process.env.LANTERN_API_TOKEN || "";
    this.logger = logger.child({ component: "attention" });
    this.dedupMs =
      Math.max(1, Number(process.env.LANTERN_ATTENTION_DEDUP_MIN) || 30) * 60_000;
  }

  enabled() {
    return this.token !== "";
  }

  shouldNotify(jid: string) {
    const prev = this.lastNotified.get(jid);
    if (!prev) return true;
    return Date.now() - prev >= this.dedupMs;
  }

  markNotified(jid: string) {
    this.lastNotified.set(jid, Date.now());
  }

  async classify(
    text: string,
    pushName?: string,
    isGroup = false
  ): Promise<Attention | null> {
    if (!this.enabled()) return null;

    const groupClause = isGroup
      ? `This is a WhatsApp GROUP message — bias toward NOT urgent unless the owner is clearly asked for personally (@mention, quoted reply, "ping shekhar", "can you ask him", etc) or the content is objectively critical.`
      : `This is a 1-on-1 WhatsApp DM.`;

    const system = `You triage incoming WhatsApp messages for a busy founder. Decide if this message needs his personal attention RIGHT NOW, versus something his AI assistant can handle on his behalf.

${groupClause}

Flag URGENT when the message involves:
- emergencies, safety, health
- money / payment issues, something missed or overdue
- time-critical meetings or commitments (today / tomorrow / this week)
- explicit request to reach him personally ("need to talk", "call me", "can you ping Shekhar")
- close relationships (family / close friends) sending non-trivial content

NOT urgent: small talk, pleasantries, sales pitches, generic intros, "hi / hello / how are you", bot-like probing, group banter that isn't directed at him.

Return STRICT JSON only, no prose, no code fences:
{"urgent": true|false, "reason": "<one short line, why or why not>", "summary": "<=10 word gist of the message>"}`;

    const prefix = pushName
      ? isGroup
        ? `From ${pushName} in a group:\n\n`
        : `From: ${pushName}\n\n`
      : "";
    const userMsg = `${prefix}${text}`;

    try {
      const res = await fetch(`${this.apiUrl}/v1/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          model: "auto",
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMsg },
          ],
          stream: false,
        }),
      });

      if (!res.ok) {
        this.logger.warn(
          { status: res.status },
          "classify request failed"
        );
        return null;
      }

      const data = (await res.json()) as { content?: string };
      const raw = (data.content || "").trim();
      if (!raw) return null;

      // Some models wrap JSON in ```json fences despite instructions.
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();

      const parsed = JSON.parse(cleaned) as Partial<Attention>;
      if (typeof parsed.urgent !== "boolean") return null;
      return {
        urgent: parsed.urgent,
        reason: parsed.reason || "",
        summary: parsed.summary || "",
      };
    } catch (err) {
      this.logger.warn({ err }, "classify errored");
      return null;
    }
  }
}
