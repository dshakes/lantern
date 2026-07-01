// Spouse-nudge-agent — the elevated, agentic handler for the owner's inner
// circle (spouse first). When Manasa sends action items / requests, the bot
// doesn't just capture a vague commitment: it INTELLIGENTLY plans concrete
// actions (todos, timed reminders/calendar), drafts a warm confirmation in the
// owner's voice, and a one-line heads-up for the owner. The bridge executes the
// plan (create commitments + calendar events, notify the owner) and sends the
// confirmation.
//
// Pure planning here (one injected LLM call); all I/O + execution lives in the
// bridge. Returns null when the message carries no real action item, so a
// normal chat is untouched.

export type SpouseItemKind = "task" | "shopping" | "appointment" | "reminder";

export interface SpouseActionItem {
  /** Clean, imperative task title ("pick up the dry cleaning"). */
  title: string;
  kind: SpouseItemKind;
  urgency: "now" | "soon" | "normal";
  /** ISO datetime when the item is time-bound (→ the bridge makes a calendar
   *  event); omitted for a plain todo. */
  whenISO?: string;
}

export interface SpouseAgentPlan {
  items: SpouseActionItem[];
  /** Warm confirmation to send the SPOUSE, in the owner's casual voice. */
  replyToSpouse: string;
  /** One-line heads-up for the OWNER's self-chat. */
  ownerSummary: string;
}

const KINDS = new Set<SpouseItemKind>(["task", "shopping", "appointment", "reminder"]);

/**
 * Plan agentic actions from a spouse message. `nowISO` anchors relative dates
 * ("tomorrow 3pm"). `llmCall` is a plain text-completion seam. Returns null on
 * no action items, no LLM, or any failure (caller falls back to normal reply).
 */
export async function planSpouseActions(
  text: string,
  opts: { ownerName: string; spouseName: string; nowISO: string },
  llmCall?: (prompt: string) => Promise<string>,
): Promise<SpouseAgentPlan | null> {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || !llmCall) return null;

  const prompt =
    `${opts.spouseName} (${opts.ownerName}'s wife) just messaged him. Decide if it asks him to DO ` +
    `something — a task, errand, shopping item, appointment, or reminder. It may contain MULTIPLE ` +
    `items ("get milk and call the plumber, and Kai's dentist is tomorrow at 3"). A pure chat, ` +
    `question, or FYI is NOT an action list.\n` +
    `Current time (owner-local ISO): ${opts.nowISO}. Resolve relative times ("tomorrow 3pm") to ISO.\n` +
    `Return STRICT minified JSON, nothing else:\n` +
    `{"items":[{"title":"<imperative, no 'you'>","kind":"task|shopping|appointment|reminder","urgency":"now|soon|normal","whenISO":"<ISO if time-bound, else omit>"}],` +
    `"replyToSpouse":"<warm 1-line confirmation in ${opts.ownerName}'s casual texting voice, e.g. 'got it, i'll grab milk and call the plumber — and added Kai's dentist to the calendar'>",` +
    `"ownerSummary":"<one short line for ${opts.ownerName}: what ${opts.spouseName} needs>"}\n` +
    `If there are NO real action items, return {"items":[]}.\n` +
    `Message:\n"""${t}"""\nJSON:`;

  let raw: string;
  try {
    raw = await llmCall(prompt);
  } catch {
    return null;
  }
  const m = raw && raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: { items?: unknown; replyToSpouse?: unknown; ownerSummary?: unknown };
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(obj.items) || obj.items.length === 0) return null;

  const items: SpouseActionItem[] = [];
  for (const it of obj.items as Array<Record<string, unknown>>) {
    const title = typeof it.title === "string" ? it.title.trim() : "";
    if (title.length < 2 || title.length > 200) continue;
    const kind = KINDS.has(it.kind as SpouseItemKind) ? (it.kind as SpouseItemKind) : "task";
    const urgency =
      it.urgency === "now" || it.urgency === "soon" || it.urgency === "normal" ? it.urgency : "normal";
    const whenISO =
      typeof it.whenISO === "string" && !Number.isNaN(Date.parse(it.whenISO)) ? it.whenISO : undefined;
    items.push({ title, kind, urgency, whenISO });
  }
  if (items.length === 0) return null;

  const replyToSpouse = typeof obj.replyToSpouse === "string" ? obj.replyToSpouse.trim() : "";
  const ownerSummary =
    typeof obj.ownerSummary === "string" && obj.ownerSummary.trim()
      ? obj.ownerSummary.trim()
      : items.map((i) => i.title).join(", ");
  return { items, replyToSpouse, ownerSummary };
}
