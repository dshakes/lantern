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

export interface RecurringSpec {
  title: string;
  cadence: "daily" | "weekly";
  timeHHMM: string; // owner-local 24h "HH:MM"
  days?: number[]; // weekly: 0=Sun..6=Sat
}

export type SpouseResponse =
  | { type: "actions"; items: SpouseActionItem[]; replyToSpouse: string; ownerSummary: string }
  | { type: "status"; replyToSpouse: string }
  | { type: "done"; doneIds: string[]; replyToSpouse: string; ownerSummary: string }
  | { type: "recurring"; reminder: RecurringSpec; replyToSpouse: string; ownerSummary: string }
  | { type: "list"; op: "add" | "remove" | "show"; items: string[]; replyToSpouse: string }
  | null;

const KINDS = new Set<SpouseItemKind>(["task", "shopping", "appointment", "reminder"]);

/**
 * Returns true when the message contains a time-of-day or calendar-date token
 * that can plausibly ground a whenISO from the LLM. Conservative — false
 * negatives (item becomes a plain todo) are safer than fabricated event times.
 *
 * ponytail: "may" excluded to avoid modal-verb false positives ("may I…");
 * "May" appointments without a specific day/time correctly drop whenISO.
 */
function messageHasTemporalToken(text: string): boolean {
  return /\b(\d{1,2}:\d{2}|\d{1,2}\s*[ap]m|noon|midnight|today|tomorrow|tonight|morning|evening|afternoon|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/i.test(
    text,
  );
}

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

  // ponytail: 100 is ample for one spouse's open list; split to paged lists if this ever becomes a real ceiling
  const open = (opts.openItems ?? []).slice(0, 100);
  const openList = open.length
    ? open.map((it, i) => `[${i}] ${it.title}`).join("\n")
    : "(none currently open)";

  const prompt =
    `${opts.spouseName} (${opts.ownerName}'s wife) just messaged him. Classify her message and respond.\n` +
    `Current time (owner-local ISO): ${opts.nowISO}.\n` +
    `${opts.ownerName}'s OPEN items she previously asked for:\n${openList}\n\n` +
    `Decide ONE type:\n` +
    `- "actions": she's asking him to DO new one-off things (task/errand/shopping/appointment — may be MULTIPLE). Resolve relative times to ISO.\n` +
    `- "recurring": she wants a REPEATING reminder ("every evening remind him to take meds", "water the plants daily at 9am", "every Mon/Wed remind him to..."). Give cadence + owner-local time.\n` +
    `- "list": she's managing the SHARED LIST — "add milk to the list" (op:add), "take milk off the list" (op:remove), "what's on our list" (op:show). Items are the things.\n` +
    `- "status": she's ASKING whether something is done / where it stands. Set statusIndex to the 0-based index of the open item she means, or -1 if it's not in the list. Code builds the reply — never claim it's done.\n` +
    `- "done": she's telling him an open item is now handled / no longer needed. Identify which open item indices.\n` +
    `- "chat": ordinary conversation, no task. \n\n` +
    `Return STRICT minified JSON, nothing else, ONE of:\n` +
    `{"type":"actions","items":[{"title":"<imperative,no 'you'>","kind":"task|shopping|appointment|reminder","urgency":"now|soon|normal","whenISO":"<ISO if timed>"}],"replyToSpouse":"<warm 1-line confirmation in ${opts.ownerName}'s casual voice>","ownerSummary":"<one line for ${opts.ownerName}>"}\n` +
    `{"type":"recurring","reminder":{"title":"<imperative>","cadence":"daily|weekly","timeHHMM":"<HH:MM 24h owner-local>","days":[<0-6 if weekly>]},"replyToSpouse":"<warm 1-line ack>","ownerSummary":"<one line>"}\n` +
    `{"type":"list","op":"add|remove|show","items":["<item>"],"replyToSpouse":"<warm 1-line ack>"}\n` +
    `{"type":"status","statusIndex":<int: 0-based index of the matching open item, or -1 if not found>}\n` +
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
    // Fix A: answer is deterministic from real open-item state — never pass through LLM free-text
    // which could fabricate "done" for something still pending.
    const idx = typeof obj.statusIndex === "number" ? Math.round(obj.statusIndex) : -1;
    if (idx >= 0 && idx < open.length) {
      return { type: "status", replyToSpouse: `that's still on his list — ${open[idx].title}` };
    }
    return { type: "status", replyToSpouse: "i don't see that on his list, will check with him" };
  }

  if (obj.type === "recurring" && obj.reminder && typeof obj.reminder === "object") {
    const r = obj.reminder as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const cadence = r.cadence === "weekly" ? "weekly" : "daily";
    const timeHHMM = typeof r.timeHHMM === "string" && /^\d{1,2}:\d{2}$/.test(r.timeHHMM) ? r.timeHHMM : "";
    if (!title || !timeHHMM) return null;
    const days = Array.isArray(r.days)
      ? (r.days as unknown[]).filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6)
      : undefined;
    return {
      type: "recurring",
      reminder: { title, cadence, timeHHMM, days: cadence === "weekly" ? days : undefined },
      replyToSpouse: reply || "got it, i'll remind him",
      ownerSummary: ownerSummary || title,
    };
  }

  if (obj.type === "list" && (obj.op === "add" || obj.op === "remove" || obj.op === "show")) {
    const items = Array.isArray(obj.items)
      ? (obj.items as unknown[]).map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean)
      : [];
    if (obj.op !== "show" && items.length === 0) return null;
    return { type: "list", op: obj.op, items, replyToSpouse: reply };
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
      // Fix B: only accept whenISO when the raw message text contains a time/date token;
      // otherwise the LLM is inventing a time not present in what she said.
      const whenISO =
        typeof it.whenISO === "string" && !Number.isNaN(Date.parse(it.whenISO)) && messageHasTemporalToken(t)
          ? it.whenISO
          : undefined;
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
