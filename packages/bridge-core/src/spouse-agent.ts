// Spouse-nudge-agent — the elevated, agentic, TWO-WAY handler for the owner's
// inner circle (spouse first). It doesn't just capture tasks; it reasons about
// what Manasa's message MEANS and responds truthfully from real task state:
//
//   • NEW ACTION ITEMS  → plan concrete actions (multi-item, timed → calendar)
//   • STATUS QUERY       → answer "did he do X?" TRUTHFULLY from the open items
//                          (never fabricate "done" when it's still pending)
//   • DONE REPORT        → she says an item's handled → mark it complete
//   • CHAT               → nothing to do, let the normal reply run
//
// Pure planning here (one injected LLM call over the message + the current open
// items); all I/O + execution lives in the bridge. Returns null for plain chat.

export type SpouseItemKind = "task" | "shopping" | "appointment" | "reminder";

export interface SpouseActionItem {
  title: string;
  kind: SpouseItemKind;
  urgency: "now" | "soon" | "normal";
  /** ISO datetime when time-bound (→ calendar event); omitted for a plain todo. */
  whenISO?: string;
}

/** An open spouse-sourced commitment the bridge already tracks. */
export interface OpenSpouseItem {
  id: string;
  title: string;
}

export type SpouseResponse =
  | { type: "actions"; items: SpouseActionItem[]; replyToSpouse: string; ownerSummary: string }
  | { type: "status"; replyToSpouse: string }
  | { type: "done"; doneIds: string[]; replyToSpouse: string; ownerSummary: string }
  | null;

const KINDS = new Set<SpouseItemKind>(["task", "shopping", "appointment", "reminder"]);

/**
 * Reason about a spouse message against the current open items and return the
 * right agentic response. `nowISO` anchors relative dates. Returns null on plain
 * chat / no LLM / any failure (caller falls back to the normal reply).
 */
export async function handleSpouseMessage(
  text: string,
  opts: { ownerName: string; spouseName: string; nowISO: string; openItems?: OpenSpouseItem[] },
  llmCall?: (prompt: string) => Promise<string>,
): Promise<SpouseResponse> {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || !llmCall) return null;

  const open = (opts.openItems ?? []).slice(0, 30);
  const openList = open.length
    ? open.map((it, i) => `[${i}] ${it.title}`).join("\n")
    : "(none currently open)";

  const prompt =
    `${opts.spouseName} (${opts.ownerName}'s wife) just messaged him. Classify her message and respond.\n` +
    `Current time (owner-local ISO): ${opts.nowISO}.\n` +
    `${opts.ownerName}'s OPEN items she previously asked for:\n${openList}\n\n` +
    `Decide ONE type:\n` +
    `- "actions": she's asking him to DO new things (task/errand/shopping/appointment/reminder — may be MULTIPLE). Resolve relative times to ISO.\n` +
    `- "status": she's ASKING whether something is done / where it stands. Answer TRUTHFULLY from the open list above — if it's still open, say it's on his list (never claim it's done). Reference the real item.\n` +
    `- "done": she's telling him an open item is now handled / no longer needed. Identify which open item indices.\n` +
    `- "chat": ordinary conversation, no task. \n\n` +
    `Return STRICT minified JSON, nothing else, ONE of:\n` +
    `{"type":"actions","items":[{"title":"<imperative,no 'you'>","kind":"task|shopping|appointment|reminder","urgency":"now|soon|normal","whenISO":"<ISO if timed>"}],"replyToSpouse":"<warm 1-line confirmation in ${opts.ownerName}'s casual voice>","ownerSummary":"<one line for ${opts.ownerName}>"}\n` +
    `{"type":"status","replyToSpouse":"<truthful 1-line answer from the open list, ${opts.ownerName}'s casual voice>"}\n` +
    `{"type":"done","doneIndices":[<int>],"replyToSpouse":"<warm 1-line ack>","ownerSummary":"<one line for ${opts.ownerName}>"}\n` +
    `{"type":"chat"}\n` +
    `Message:\n"""${t}"""\nJSON:`;

  let raw: string;
  try {
    raw = await llmCall(prompt);
  } catch {
    return null;
  }
  const m = raw && raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }

  const reply = typeof obj.replyToSpouse === "string" ? obj.replyToSpouse.trim() : "";
  const ownerSummary = typeof obj.ownerSummary === "string" ? obj.ownerSummary.trim() : "";

  if (obj.type === "status") {
    return reply ? { type: "status", replyToSpouse: reply } : null;
  }

  if (obj.type === "done" && Array.isArray(obj.doneIndices)) {
    const doneIds = (obj.doneIndices as unknown[])
      .map((i) => (typeof i === "number" && i >= 0 && i < open.length ? open[i].id : null))
      .filter((x): x is string => !!x);
    if (doneIds.length === 0) return null;
    return {
      type: "done",
      doneIds,
      replyToSpouse: reply || "got it, marking that done 👍",
      ownerSummary: ownerSummary || "marked done",
    };
  }

  if (obj.type === "actions" && Array.isArray(obj.items)) {
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
    return {
      type: "actions",
      items,
      replyToSpouse: reply,
      ownerSummary: ownerSummary || items.map((i) => i.title).join(", "),
    };
  }

  return null; // "chat" or anything unrecognized
}
