// skill-forge.ts — the safe self-improvement loop ("teach yourself ...").
//
// The owner asks for a new recurring capability in self-chat; the LLM drafts
// a structured skill spec (name, schedule, the prompt it will run); the owner
// approves; the bridge fires it on its proactive tick and delivers the result
// to self-chat. The LLM designs the skill AND executes every firing — nothing
// static beyond the schedule matcher. Safety model:
//   1. OWNER-ONLY: proposal + approval + execution all live in owner self-chat.
//   2. Nothing activates without an explicit approval reply.
//   3. Execution rides the existing tick → killswitch, mute, and quiet hours
//      gate it exactly like every other proactive loop.
//   4. Skills are prompts, not code — no shell, no filesystem, no new
//      capability surface. (That is the line OpenClaw crossed; we don't.)
//
// PURE module: request detection, spec prompt/parse, schedule matching,
// formatting. The bridge owns state (skills.json 0600), the LLM calls, and
// delivery.

export interface SkillSchedule {
  /** Owner-local firing time. */
  hour: number; // 0-23
  minute: number; // 0-59
  /** Days of week 0=Sun..6=Sat. Empty = every day. */
  daysOfWeek: number[];
}

export interface SkillSpec {
  /** kebab-case id, ≤30 chars. */
  name: string;
  /** One-line owner-facing description, ≤120 chars. */
  description: string;
  schedule: SkillSchedule;
  /** The instruction the LLM runs at each firing. */
  prompt: string;
}

export interface StoredSkill extends SkillSpec {
  createdAt: number;
  /** "YYYY-MM-DD" of the last firing (owner-local) — once-per-day guard. */
  lastFiredDay?: string;
  enabled: boolean;
}

export interface SkillForgeState {
  skills: StoredSkill[];
}

export function defaultSkillState(): SkillForgeState {
  return { skills: [] };
}

// ── Request detection (accelerator grammar; the NL router can also land here) ──

const SKILL_REQ_RE = /^(?:new skill|teach yourself|learn to|make a skill|add a skill)\b[:,]?\s*(.+)$/is;

/** Returns the freeform request text when the message asks for a new skill. */
export function matchSkillRequest(text: string): string | null {
  const m = text.trim().match(SKILL_REQ_RE);
  return m ? m[1].trim() : null;
}

export function matchSkillCommand(text: string): "list" | { drop: number } | null {
  const t = text.trim().toLowerCase();
  if (/^skills$/.test(t)) return "list";
  const d = t.match(/^(?:drop|delete|remove)\s+skill\s+(\d{1,2})$/);
  if (d) return { drop: parseInt(d[1], 10) };
  return null;
}

// ── Spec drafting (LLM) ─────────────────────────────────────────────────────

export function buildSkillSpecPrompt(request: string, now: Date, timezone?: string): string {
  return [
    "Design a recurring personal-assistant skill from this request. The skill is a PROMPT you will run on a schedule — it can reason, search the web, read the owner's context, and text the owner a result. It cannot run code or touch files.",
    `Owner request: "${request}"`,
    `Current time: ${now.toString()}${timezone ? ` (${timezone})` : ""}`,
    "",
    'Reply with STRICT JSON only:',
    '{"name":"kebab-case-id","description":"one line, ≤120 chars, owner-facing","schedule":{"hour":18,"minute":0,"daysOfWeek":[0]},"prompt":"the exact instruction to execute at each firing — specific, self-contained, written to YOU"}',
    "daysOfWeek: 0=Sunday..6=Saturday, [] = every day. Pick the schedule the request implies; if none is implied, pick a sensible one.",
    'If the request cannot work as a scheduled prompt (needs code, hardware, or a one-off action), reply {"error":"<one-line reason>"} instead. Never invent facts about the owner.',
  ].join("\n");
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;

/** Tolerant parse + validation. Returns the spec, an error string from the
 *  model (honest refusal), or null when unparseable. Never throws. */
export function parseSkillSpec(raw: string): SkillSpec | { error: string } | null {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const p = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof p.error === "string" && p.error.trim()) return { error: p.error.trim().slice(0, 200) };
    const name = typeof p.name === "string" ? p.name.trim().toLowerCase() : "";
    const description = typeof p.description === "string" ? p.description.trim().slice(0, 120) : "";
    const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
    const sched = (p.schedule ?? {}) as Record<string, unknown>;
    const hour = Number(sched.hour);
    const minute = Number(sched.minute);
    const days = Array.isArray(sched.daysOfWeek)
      ? sched.daysOfWeek.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
      : [];
    if (!NAME_RE.test(name) || !description || !prompt) return null;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return { name, description, prompt, schedule: { hour, minute, daysOfWeek: [...new Set(days)].sort() } };
  } catch {
    return null;
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatSchedule(s: SkillSchedule): string {
  const t = `${((s.hour + 11) % 12) + 1}:${String(s.minute).padStart(2, "0")}${s.hour < 12 ? "am" : "pm"}`;
  if (s.daysOfWeek.length === 0) return `daily at ${t}`;
  if (s.daysOfWeek.length === 7) return `daily at ${t}`;
  return `${s.daysOfWeek.map((d) => DAY_NAMES[d]).join("/")} at ${t}`;
}

export function formatSkillProposal(spec: SkillSpec): string {
  return [
    `🛠 skill proposal — *${spec.name}*`,
    spec.description,
    `runs: ${formatSchedule(spec.schedule)}`,
    `→ reply "approve skill" to activate · "drop" to discard`,
  ].join("\n");
}

export function formatSkillList(skills: StoredSkill[]): string {
  if (skills.length === 0) return `🛠 no skills yet — say "new skill: ..." to teach me one.`;
  const lines = [`🛠 your skills:`];
  skills.forEach((s, i) => {
    lines.push(` ${i + 1} ${s.name} — ${formatSchedule(s.schedule)}${s.enabled ? "" : " (off)"}`);
  });
  lines.push(`→ "drop skill <n>" to remove`);
  return lines.join("\n");
}

// ── Firing ──────────────────────────────────────────────────────────────────

/** Owner-local "YYYY-MM-DD" for the once-per-day guard. */
export function localDayKey(now: Date, timezone?: string): string {
  try {
    return now.toLocaleDateString("en-CA", { timeZone: timezone });
  } catch {
    return now.toLocaleDateString("en-CA");
  }
}

/**
 * Skills due at `now`: schedule day matches, the local time is at/past
 * hour:minute but within `windowMin` minutes of it (tick jitter tolerance),
 * and it hasn't fired today.
 */
export function dueSkills(state: SkillForgeState, now: Date, timezone?: string, windowMin = 20): StoredSkill[] {
  const dayKey = localDayKey(now, timezone);
  let local: { dow: number; minutes: number };
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, weekday: "short", hour: "numeric", minute: "numeric", hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const dow = DAY_NAMES.findIndex((d) => get("weekday").startsWith(d));
    local = { dow: dow >= 0 ? dow : now.getDay(), minutes: (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10) };
  } catch {
    local = { dow: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() };
  }
  return state.skills.filter((s) => {
    if (!s.enabled || s.lastFiredDay === dayKey) return false;
    if (s.schedule.daysOfWeek.length > 0 && !s.schedule.daysOfWeek.includes(local.dow)) return false;
    const target = s.schedule.hour * 60 + s.schedule.minute;
    return local.minutes >= target && local.minutes < target + windowMin;
  });
}
