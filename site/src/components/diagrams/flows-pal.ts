import type { FlowDef } from "./FlowDiagram";
import type { Src } from "./types";

// pal (the personal agent) diagrams for the shared FlowDiagram kit. Facts come
// from CLAUDE.md's bridge sections; module paths are cited per node.

const M = (p: string, l?: number): Src => ({ p, l });
const BC = "packages/bridge-core/src";

// ---------------------------------------------------------------------------
export const BRIEF_ATTENTION: FlowDef = {
  id: "brief",
  title: "The Brief: what needs you, ranked",
  caption: "Drafts, open promises and people waiting on you, ranked by a model that can only reorder and annotate, never invent.",
  vb: [1000, 380],
  nodes: [
    { id: "drafts", label: "Drafts", sub: "held replies", tone: "pal", x: 30, y: 40 },
    { id: "commits", label: "Commitments", sub: "open promises", tone: "pal", x: 30, y: 150 },
    { id: "waiting", label: "Waiting on you", sub: "unanswered threads", tone: "pal", x: 30, y: 260, detail: "Contacts left unanswered, VIPs first, with a preview of their last message." },
    { id: "rank", label: "Rank", sub: "attention::rank", tone: "rt", x: 260, y: 100, detail: "Returns strict JSON {order, why}. It can reorder and annotate existing items only.", src: [M(`${BC}/attention.ts`)] },
    { id: "det", label: "Deterministic order", sub: "fallback", x: 260, y: 240, detail: "Any model failure leaves the default order standing." },
    { id: "brief", label: "Brief", sub: "? · today · whats up", tone: "pal", x: 480, y: 150, detail: "A numbered list; the model's reason shows as a short suffix on each line." },
    { id: "owner", label: "You, in self-chat", tone: "client", x: 680, y: 150 },
    { id: "act", label: "Reply", sub: "2 · 2 draft · 2 skip", x: 860, y: 60, w: 125, detail: "A bare number drafts a reply in your voice and stages it, so send/edit work as usual." },
    { id: "react", label: "React", sub: "👍 👎 ⏰ ❓", x: 860, y: 240, w: 125, detail: "A reaction acts on the top item: confirm, skip, snooze or review. Undoing an auto-action always needs a typed word." },
    { id: "inbox", label: "/inbox · Personal", sub: "dashboard depth view", x: 480, y: 290 },
  ],
  edges: [
    { from: "drafts", to: "rank" },
    { from: "commits", to: "rank" },
    { from: "waiting", to: "rank" },
    { from: "rank", to: "brief", label: "order + why" },
    { from: "rank", to: "det", label: "any failure", dashed: true },
    { from: "det", to: "brief" },
    { from: "brief", to: "owner" },
    { from: "owner", to: "act" },
    { from: "owner", to: "react" },
    { from: "brief", to: "inbox", kind: "store" },
  ],
  scenarios: [
    {
      id: "rank", label: "Ranked Brief",
      steps: [
        { title: "Gather what needs you", note: "Held drafts, commitments you have not closed, and people left waiting.", edges: ["drafts>rank", "commits>rank", "waiting>rank"] },
        { title: "One model ranks across kinds", note: "A VIP waiting three days can outrank a routine draft. The model never adds an item.", edges: ["rank>brief"] },
        { title: "You read it where you already are", note: "Self-chat on iMessage or WhatsApp. The dashboard's Personal tab shows the same list.", edges: ["brief>owner", "brief>inbox"] },
        { title: "Act with a word", note: "\"2 draft\" writes a reply in your voice for thread 2 and stages it for send or edit.", edges: ["owner>act"] },
        { title: "Or with a reaction", note: "👍 sends the top draft or closes the top commitment; on WhatsApp the Brief line is struck through in place.", edges: ["owner>react"] },
      ],
    },
    {
      id: "fail", label: "Model unavailable",
      steps: [
        { title: "Same inputs", note: "Drafts, commitments, waiting threads.", edges: ["drafts>rank", "commits>rank", "waiting>rank"] },
        { title: "Ranking fails", note: "A timeout or unparseable JSON.", edges: ["rank>det"], deny: true },
        { title: "The default order stands", note: "You still get a Brief; it is just not re-ranked.", edges: ["det>brief", "brief>owner"] },
      ],
    },
  ],
  legend: [["pal", "pal"], ["rt", "Model call"], ["client", "You"]],
};

// ---------------------------------------------------------------------------
export const HOLDS_GATES: FlowDef = {
  id: "holds",
  title: "Holds: gates at the send boundary",
  caption: "Before a reply leaves in your voice, two gates can hold it for you. Each is a model judgment plus a deterministic backstop, so an outage cannot fail open.",
  vb: [980, 400],
  nodes: [
    { id: "in", label: "Contact message", tone: "client", x: 30, y: 150 },
    { id: "draft", label: "Reply draft", tone: "pal", x: 210, y: 150 },
    { id: "cg", label: "Commitment gate", sub: "money · promises", tone: "rt", x: 390, y: 150, detail: "Holds a reply that commits you to money or an action, or answers a request for money, in English, romanized Telugu or Hindi. Reads the recent thread, not just this pair.", src: [M(`${BC}/commitment-gate.ts`)] },
    { id: "gg", label: "Grounding gate", sub: "can't verify → hold", tone: "rt", x: 570, y: 150, detail: "Holds specific dates for your life, contradictions of the contact about your plans, outcomes only you could confirm, and a cheerful reply to grief.", src: [M(`${BC}/grounding-gate.ts`)] },
    { id: "send", label: "Sent", tone: "ok", x: 790, y: 60 },
    { id: "held", label: "HELD for you", sub: "⚠️ page to self-chat", tone: "deny", x: 790, y: 250 },
    { id: "owner", label: "Your one line", sub: "becomes the reply", tone: "client", x: 580, y: 320 },
  ],
  edges: [
    { from: "in", to: "draft" },
    { from: "draft", to: "cg" },
    { from: "cg", to: "gg", label: "pass" },
    { from: "gg", to: "send", label: "pass" },
    { from: "cg", to: "held", via: [[465, 285]], at: 0.6 },
    { from: "gg", to: "held" },
    { from: "held", to: "owner" },
  ],
  scenarios: [
    {
      id: "clean", label: "Clean reply",
      steps: [
        { title: "A contact writes", note: "Any ordinary message.", edges: ["in>draft"] },
        { title: "No money, no promise", note: "Both layers agree.", edges: ["draft>cg", "cg>gg"] },
        { title: "Nothing unverifiable", note: "No invented dates or outcomes.", edges: ["gg>send"] },
      ],
    },
    {
      id: "money", label: "Promises money",
      steps: [
        { title: "A relative asks for help", note: "The draft says, in Telugu, \"sending it now\".", edges: ["in>draft"] },
        { title: "Held, not sent", note: "Tier forced LOW and the draft path taken even when draft-confirm is off. A prompt rule is advice; this is a gate.", edges: ["draft>cg", "cg>held"], deny: true },
        { title: "You decide", note: "You get a distinct ⚠️ HELD page, not a routine audit ping. Your typed line is what goes out.", edges: ["held>owner"] },
      ],
    },
    {
      id: "ground", label: "Unverifiable date",
      steps: [
        { title: "\"Showtime today??\"", note: "The draft says \"not today, the 10th is the big day\", from a stale profile line.", edges: ["in>draft", "draft>cg"] },
        { title: "Grounding gate holds it", note: "A specific date for your life, contradicting the contact. Nothing in mail or calendar verifies it.", edges: ["cg>gg", "gg>held"], deny: true },
        { title: "Your line becomes the reply", note: "\"I can't verify\" is the page; you answer once.", edges: ["held>owner"] },
      ],
    },
  ],
  legend: [["rt", "Gate: model + backstop"], ["deny", "Held"], ["ok", "Sent"]],
};

// ---------------------------------------------------------------------------
export const VOICE_PIPELINE: FlowDef = {
  id: "voice",
  title: "The voice pipeline: sounds like you, never a bot",
  caption: "Every contact reply passes the same line of checks, in order. Pick a scenario to see a draft go straight through, get caught, or get refined.",
  vb: [1000, 330],
  nodes: [
    { id: "ctx", label: "Context", sub: "now · actions · tone", x: 20, y: 60, w: 140, detail: "A dated present-tense self-model (inner circle only), what the assistant did for this contact, and the emotional register." },
    { id: "draft", label: "Draft", tone: "pal", x: 185, y: 60, w: 140 },
    { id: "guard", label: "Bot-tell guard", sub: "detectBotTells", tone: "rt", x: 350, y: 60, w: 140, detail: "Stock phrases, JSON leaks, whereabouts, a reply ≥ 0.75 Jaccard-similar to the last 3, or voice drift past your own p95 floor.", src: [M(`${BC}/natural.ts`)] },
    { id: "tier", label: "Confidence tier", sub: "HIGH · MED · LOW", x: 515, y: 60, w: 140 },
    { id: "refine", label: "Critique-refine", sub: "vs 5 real messages", tone: "rt", x: 680, y: 60, w: 140, detail: "Edits against the 5 messages you really sent that are most similar. Accepted only if not further from your voice and still guard-clean.", src: [M(`${BC}/voice-refine.ts`)] },
    { id: "gates", label: "Holds", sub: "commitment · grounding", tone: "rt", x: 845, y: 60, w: 140 },
    { id: "regen", label: "Regenerate", sub: "fix, then ground", x: 350, y: 220, w: 140, detail: "One corrective regeneration, then one strict exemplar-grounded attempt. A short greeting table is only the last fallback." },
    { id: "send", label: "Send", tone: "ok", x: 680, y: 220, w: 140 },
    { id: "claims", label: "Verifiable claims", sub: "10-min action log", x: 845, y: 220, w: 140, detail: "\"I sent it\" stays only if the bridge recorded that action for this contact in the last 10 minutes; otherwise it becomes \"I'll send it\".", src: [M(`${BC}/verifiable-claims.ts`)] },
  ],
  edges: [
    { from: "ctx", to: "draft" },
    { from: "draft", to: "guard" },
    { from: "guard", to: "regen", label: "tell found", via: [[395, 170]], kind: "deny" },
    { from: "regen", to: "guard", via: [[445, 170]] },
    { from: "guard", to: "tier", label: "clean" },
    { from: "tier", to: "refine", label: "MEDIUM/LOW" },
    { from: "tier", to: "gates", label: "HIGH", via: [[585, 34], [915, 34]], at: 0.5 },
    { from: "refine", to: "gates" },
    { from: "gates", to: "claims", label: "pass" },
    { from: "claims", to: "send" },
  ],
  scenarios: [
    {
      id: "clean", label: "Clean, confident",
      steps: [
        { title: "Grounded context", note: "Who this is, what is true now, what was already done for them.", edges: ["ctx>draft"] },
        { title: "Guard finds nothing", note: "No stock phrases, no leaks, not a repeat, inside your own voice floor.", edges: ["draft>guard", "guard>tier"] },
        { title: "HIGH skips refinement", note: "Refinement is for MEDIUM and LOW drafts only.", edges: ["tier>gates"] },
        { title: "Claims checked, then sent", note: "Only actions provably done are stated as done.", edges: ["gates>claims", "claims>send"] },
      ],
    },
    {
      id: "tell", label: "Bot-tell caught",
      steps: [
        { title: "Draft opens with \"Certainly!\"", note: "A stock customer-service phrase.", edges: ["ctx>draft", "draft>guard"] },
        { title: "Suppressed, not sent", note: "The guard suppresses the draft and asks for a corrected one; never silence.", edges: ["guard>regen"], deny: true },
        { title: "Regenerated and re-checked", note: "Corrective first, then a strict attempt grounded in your real messages.", edges: ["regen>guard"] },
        { title: "Now clean", note: "On through the rest of the line.", edges: ["guard>tier", "tier>gates", "gates>claims", "claims>send"] },
      ],
    },
    {
      id: "refine", label: "MEDIUM → refined",
      steps: [
        { title: "Clean but unsure", note: "Tier MEDIUM.", edges: ["draft>guard", "guard>tier"] },
        { title: "Critique against your own messages", note: "Kept only if it is not further from your voice. Every draft logs its voice score.", edges: ["tier>refine"] },
        { title: "Gates, claims, send", note: "The same send boundary as every reply.", edges: ["refine>gates", "gates>claims", "claims>send"] },
      ],
    },
  ],
  legend: [["pal", "Draft"], ["rt", "Check"], ["ok", "Sent"], ["deny", "Caught"]],
};

// ---------------------------------------------------------------------------
export const CROSS_CHANNEL_MEMORY: FlowDef = {
  id: "memory",
  title: "Cross-channel memory",
  caption: "iMessage and WhatsApp share one person graph and one timeline, so what you learn on one channel is there on the other.",
  vb: [980, 425],
  frames: [
    { label: "Bridges · on your Mac", x: 15, y: 15, w: 380, h: 390, kind: "zone" },
    { label: "Control plane · /v1/people · /v1/memory", x: 415, y: 15, w: 375, h: 315, kind: "cp" },
  ],
  nodes: [
    { id: "im", label: "iMessage", tone: "pal", x: 30, y: 40 },
    { id: "wa", label: "WhatsApp", tone: "pal", x: 30, y: 150 },
    { id: "ep", label: "Episodes", sub: "14 days · encrypted", tone: "store", x: 30, y: 280, detail: "Each substantive exchange as (date, topic, outcome); the 5 most recent per contact go into the reply prompt. AES-256-GCM at rest." },
    { id: "top", label: "Topic index", sub: "7 days · encrypted", tone: "store", x: 210, y: 280, w: 170, detail: "Topic-tagged messages, for related context from other threads; the prompt says never to volunteer it unasked." },
    { id: "res", label: "Resolve", sub: "POST /v1/people/resolve", x: 430, y: 40, w: 165 },
    { id: "person", label: "Person graph", sub: "handles merged", tone: "rt", x: 620, y: 40, detail: "One canonical person, many channel handles. Duplicates are merged transactionally." },
    { id: "ev", label: "Timeline", sub: "POST /v1/memory/events", x: 430, y: 150, w: 165 },
    { id: "ctx", label: "Context", sub: "GET /v1/memory/context", x: 620, y: 150, w: 160 },
    { id: "search", label: "Recall", sub: "hybrid RRF search", x: 620, y: 260, w: 160, detail: "GET /v1/memory/search across every person except the current one." },
    { id: "prompt", label: "Reply prompt", tone: "pal", x: 820, y: 150, w: 145 },
  ],
  edges: [
    { from: "im", to: "res" },
    { from: "wa", to: "res" },
    { from: "res", to: "person" },
    { from: "im", to: "ev" },
    { from: "wa", to: "ev" },
    { from: "person", to: "ctx" },
    { from: "ev", to: "ctx" },
    { from: "ctx", to: "prompt" },
    { from: "search", to: "prompt" },
    { from: "top", to: "search", label: "offline fallback", dashed: true },
    { from: "ep", to: "prompt", via: [[105, 413], [892, 413]], at: 0.5 },
  ],
  scenarios: [
    {
      id: "one", label: "One person, two channels",
      steps: [
        { title: "A handle on each channel", note: "A phone number on iMessage, a JID on WhatsApp.", edges: ["im>res", "wa>res"] },
        { title: "Resolved to one person", note: "The person row is canonical; duplicate candidates can be merged.", edges: ["res>person"] },
        { title: "Every exchange on one timeline", note: "Events land under the person, whichever channel they came from.", edges: ["im>ev", "wa>ev"] },
      ],
    },
    {
      id: "reply", label: "Recall for a reply",
      steps: [
        { title: "Unified context", note: "Facts and recent events for this person across both channels, sliceable by window.", edges: ["person>ctx", "ev>ctx", "ctx>prompt"] },
        { title: "Recent episodes", note: "What you last talked about, and how it ended.", edges: ["ep>prompt"] },
        { title: "Related threads", note: "What other people said about the same topics, held back unless asked.", edges: ["top>search", "search>prompt"] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
export const WORLD_MODEL: FlowDef = {
  id: "world-model",
  title: "World model refresh",
  caption: "Every few hours pal re-derives what is true now from your mail, calendar and messages, and drops anything it cannot cite verbatim.",
  vb: [980, 420],
  nodes: [
    { id: "mail", label: "Mail subjects", sub: "last 7 days", x: 30, y: 20, detail: "Apple Mail's local index, read-only, never logged." },
    { id: "cal", label: "Calendar", sub: "next 30 days", x: 30, y: 100 },
    { id: "notes", label: "Your self-chat notes", sub: "highest authority", tone: "pal", x: 30, y: 180, detail: "\"Opening moved to the 18th\" overrides mail." },
    { id: "inb", label: "Inbound messages", sub: "contacts only", x: 30, y: 260, detail: "A friend's \"still on for the 18th?\" is evidence. The bot's own replies are excluded: they may be the stale claim." },
    { id: "prof", label: "Current profile", sub: "## Now · ## Public", tone: "store", x: 30, y: 340 },
    { id: "llm", label: "Reason", sub: "owner::worldmodel", tone: "rt", x: 260, y: 180, detail: "One call, strict JSON." },
    { id: "chk", label: "Grounding check", sub: "verbatim + until date", tone: "rt", x: 460, y: 180, detail: "Each item must cite a source that appears verbatim in the inputs and carry an until date within 120 days, or it is dropped.", src: [M(`${BC}/world-model.ts`)] },
    { id: "drop", label: "Dropped", sub: "uncited · out of range", tone: "deny", x: 460, y: 330 },
    { id: "now", label: "## Now", sub: "upserted", tone: "pal", x: 670, y: 100 },
    { id: "pub", label: "## Public (managed)", sub: "rebuilt", tone: "pal", x: 670, y: 260, detail: "Your hand-written ## Public is never touched." },
    { id: "fyi", label: "🧭 FYI", sub: "to self-chat", tone: "client", x: 860, y: 180, w: 110, detail: "A wrong derivation is one line from a correction." },
  ],
  edges: [
    { from: "mail", to: "llm" },
    { from: "cal", to: "llm" },
    { from: "notes", to: "llm" },
    { from: "inb", to: "llm" },
    { from: "prof", to: "llm" },
    { from: "llm", to: "chk" },
    { from: "chk", to: "drop", kind: "deny" },
    { from: "chk", to: "now" },
    { from: "chk", to: "pub" },
    { from: "now", to: "fyi" },
    { from: "pub", to: "fyi" },
  ],
  scenarios: [
    {
      id: "refresh", label: "Refresh",
      steps: [
        { title: "Your own evidence", note: "Mail, calendar, your notes and what contacts said, plus what the profile believes now.", edges: ["mail>llm", "cal>llm", "notes>llm", "inb>llm", "prof>llm"] },
        { title: "One reasoned pass", note: "Rides the proactive tick every few hours (default 6).", edges: ["llm>chk"] },
        { title: "Written back", note: "## Now lines upserted; the managed ## Public rebuilt.", edges: ["chk>now", "chk>pub"] },
        { title: "You are told", note: "Every change comes to self-chat as a 🧭 line.", edges: ["now>fyi", "pub>fyi"] },
      ],
    },
    {
      id: "drop", label: "Ungrounded claim",
      steps: [
        { title: "The model proposes a fact", note: "Its cited source does not appear verbatim in the inputs.", edges: ["notes>llm", "llm>chk"] },
        { title: "Dropped", note: "Never written, never said to a contact.", edges: ["chk>drop"], deny: true },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
export const PROACTIVE_NUDGES: FlowDef = {
  id: "nudges",
  title: "Proactive nudges",
  caption: "pal watches for the moments you would want a heads-up, ranks them, and checks it has not already told you.",
  vb: [980, 360],
  nodes: [
    { id: "cal", label: "Calendar", sub: "starts within 15 min", x: 30, y: 20, detail: "pre-meeting: \"1:1 with Raju starts in 10 min, pulling up the thread\"." },
    { id: "dates", label: "Owner facts", sub: "dates within 1 day", x: 30, y: 105, detail: "relationship-date: anniversaries and birthdays." },
    { id: "thr", label: "Threads", sub: "unanswered > 2 days", x: 30, y: 190, detail: "overdue-reply." },
    { id: "com", label: "Commitments", sub: "open > 4 h", x: 30, y: 275, detail: "commitment: \"still on your plate: send Raju the deck\"." },
    { id: "eng", label: "Rank by kind", sub: "computeProactiveNudges", tone: "rt", x: 250, y: 147, detail: "A pure function: pre-meeting, then relationship-date, overdue-reply, commitment.", src: [M(`${BC}/anticipation.ts`)] },
    { id: "dd", label: "Dedupe", sub: "fired-nudges.json", tone: "store", x: 450, y: 147, detail: "A stable dedupe key per nudge: never the same nudge twice in a day." },
    { id: "gate", label: "Quiet hours", sub: "· killswitch", x: 640, y: 147 },
    { id: "out", label: "Self-chat nudge", tone: "pal", x: 830, y: 70, w: 135 },
    { id: "skip", label: "Not sent", tone: "deny", x: 830, y: 230, w: 135 },
  ],
  edges: [
    { from: "cal", to: "eng" },
    { from: "dates", to: "eng" },
    { from: "thr", to: "eng" },
    { from: "com", to: "eng" },
    { from: "eng", to: "dd" },
    { from: "dd", to: "gate", label: "new" },
    { from: "dd", to: "skip", label: "already fired", via: [[525, 257]], at: 0.6 },
    { from: "gate", to: "out" },
    { from: "gate", to: "skip" },
  ],
  scenarios: [
    {
      id: "meet", label: "Pre-meeting",
      steps: [
        { title: "A meeting in 10 minutes", note: "Highest priority kind.", edges: ["cal>eng"] },
        { title: "First time today", note: "No matching dedupe key.", edges: ["eng>dd", "dd>gate"] },
        { title: "Delivered", note: "Outside quiet hours, killswitch off.", edges: ["gate>out"] },
      ],
    },
    {
      id: "dup", label: "Already told you",
      steps: [
        { title: "Same overdue thread", note: "You were nudged about it this morning.", edges: ["thr>eng", "eng>dd"] },
        { title: "Suppressed", note: "The dedupe key matched.", edges: ["dd>skip"], deny: true },
      ],
    },
    {
      id: "quiet", label: "Quiet hours",
      steps: [
        { title: "A commitment is overdue at 2 am", note: "New, so it passes dedupe.", edges: ["com>eng", "eng>dd", "dd>gate"] },
        { title: "Held by quiet hours", note: "01:00 to 06:00 by default. Set PAL_PROACTIVE_NUDGES=0 to turn nudges off entirely.", edges: ["gate>skip"], deny: true },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
export const SKILL_FORGE: FlowDef = {
  id: "skill-forge",
  title: "Skill forge: teach pal a recurring job",
  caption: "A skill is a prompt on a schedule, never code. Nothing activates until you approve it.",
  vb: [1000, 420],
  nodes: [
    { id: "ask", label: "new skill: …", sub: "self-chat", tone: "client", x: 20, y: 50, w: 140 },
    { id: "match", label: "Match request", sub: "strict grammar", x: 185, y: 50, w: 140 },
    { id: "spec", label: "Draft spec", sub: "skillforge::spec", tone: "rt", x: 350, y: 50, w: 140, detail: "{name, description, schedule {hour, minute, daysOfWeek}, prompt}, or an honest {error} when it can't be a scheduled prompt.", src: [M(`${BC}/skill-forge.ts`)] },
    { id: "prop", label: "Proposal", sub: "to self-chat", tone: "pal", x: 515, y: 50, w: 140 },
    { id: "ok", label: "approve skill", sub: "within 10 min", tone: "client", x: 680, y: 50, w: 140 },
    { id: "store", label: "skills.json", sub: "0600", tone: "store", x: 845, y: 50, w: 140 },
    { id: "tick", label: "Proactive tick", sub: "kill · mute · quiet", x: 845, y: 230, w: 140 },
    { id: "due", label: "Due?", sub: "50-min window", x: 680, y: 230, w: 140, detail: "Matches your local day and time within a window wider than the tick, so none are missed." },
    { id: "stamp", label: "Stamp first", sub: "lastFiredDay", x: 515, y: 230, w: 140, detail: "Stamped before running: a crash drops one delivery rather than sending twice." },
    { id: "run", label: "Run the prompt", sub: "web_search only", tone: "rt", x: 350, y: 230, w: 140 },
    { id: "out", label: "Result", sub: "to self-chat", tone: "pal", x: 185, y: 230, w: 140 },
    { id: "no", label: "Shell · files", sub: "never", tone: "deny", x: 340, y: 345, w: 160 },
  ],
  edges: [
    { from: "ask", to: "match" },
    { from: "match", to: "spec" },
    { from: "spec", to: "prop" },
    { from: "prop", to: "ok" },
    { from: "ok", to: "store" },
    { from: "store", to: "tick", dashed: true },
    { from: "tick", to: "due" },
    { from: "due", to: "stamp" },
    { from: "stamp", to: "run" },
    { from: "run", to: "out" },
    { from: "run", to: "no", kind: "deny", label: "no capability" },
  ],
  scenarios: [
    {
      id: "teach", label: "Teach a skill",
      steps: [
        { title: "Ask in plain words", note: "\"new skill: every Friday at 5, summarize this week's school emails\".", edges: ["ask>match", "match>spec"] },
        { title: "pal proposes", note: "Name, schedule and prompt, shown to you.", edges: ["spec>prop"] },
        { title: "You approve", note: "Reply \"approve skill\" within 10 minutes.", edges: ["prop>ok", "ok>store"] },
      ],
    },
    {
      id: "noapprove", label: "Not approved",
      steps: [
        { title: "A proposal goes unanswered", note: "Or you say no.", edges: ["spec>prop", "prop>ok"], deny: true, nodes: ["prop", "ok"] },
      ],
    },
    {
      id: "fire", label: "It fires",
      steps: [
        { title: "On the proactive tick", note: "So the killswitch, mute and quiet hours gate it like everything else.", edges: ["store>tick", "tick>due"] },
        { title: "Stamped before it runs", note: "At most once per day.", edges: ["due>stamp", "stamp>run"] },
        { title: "Only a prompt", note: "With web search; no shell, no filesystem, no new capability surface.", edges: ["run>no"], deny: true },
        { title: "Delivered to you", note: "The result lands in self-chat.", edges: ["run>out"] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
export const RECAP: FlowDef = {
  id: "recap",
  title: "Recap: what did I miss",
  caption: "Ask in self-chat and pal writes a short narrative of what landed while you were away, leading with what matters.",
  vb: [1040, 330],
  nodes: [
    { id: "ask", label: "what did I miss", sub: "· catch me up", tone: "client", x: 20, y: 140, w: 150 },
    { id: "gram", label: "Recognize", sub: "≤ 80 chars", x: 190, y: 140, w: 150, detail: "A strict grammar capped at 80 characters, so a real message is never mistaken for a recap request.", src: [M(`${BC}/time-travel.ts`)] },
    { id: "win", label: "Window", sub: "default 6 h", x: 360, y: 140, w: 150, detail: "\"last 3 hours\", \"today\", \"overnight\"." },
    { id: "gather", label: "Gather", sub: "since the cutoff", x: 530, y: 140, w: 150 },
    { id: "wait", label: "Waiting on you", tone: "pal", x: 530, y: 30, w: 150 },
    { id: "acts", label: "What pal did", sub: "recent actions", tone: "pal", x: 530, y: 255, w: 150 },
    { id: "llm", label: "Narrate", sub: "recap::synth", tone: "rt", x: 720, y: 55, w: 150 },
    { id: "fb", label: "Ranked fallback", sub: "finalizeRecap", x: 720, y: 230, w: 150, detail: "Deterministic and weight-ranked: still truthful when the model call fails." },
    { id: "out", label: "Recap", sub: "to self-chat", tone: "pal", x: 895, y: 140, w: 130 },
  ],
  edges: [
    { from: "ask", to: "gram" },
    { from: "gram", to: "win" },
    { from: "win", to: "gather" },
    { from: "wait", to: "gather" },
    { from: "acts", to: "gather" },
    { from: "gather", to: "llm" },
    { from: "gather", to: "fb", dashed: true, label: "on failure" },
    { from: "llm", to: "out" },
    { from: "fb", to: "out" },
  ],
  scenarios: [
    {
      id: "ok", label: "Recap",
      steps: [
        { title: "You ask", note: "Optionally with a window.", edges: ["ask>gram", "gram>win"] },
        { title: "What landed since the cutoff", note: "Who is waiting on you, and what pal did on your behalf.", edges: ["win>gather", "wait>gather", "acts>gather"] },
        { title: "A short narrative", note: "Leads with what matters; it matches no command, so it cannot loop.", edges: ["gather>llm", "llm>out"] },
      ],
    },
    {
      id: "fb", label: "Model fails",
      steps: [
        { title: "Same gathering", note: "As above.", edges: ["win>gather", "wait>gather", "acts>gather"] },
        { title: "Narration fails", note: "Timeout or error.", edges: ["gather>llm"], deny: true },
        { title: "Ranked list instead", note: "Truthful, just less fluent.", edges: ["gather>fb", "fb>out"] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Docs landing hero: both products on one picture.
export const TWO_PRODUCTS: FlowDef = {
  id: "two-products",
  title: "pal runs on PAL Runtime",
  caption: "Step through a reply pal sends, one it holds, and a run of your own agent.",
  vb: [560, 410],
  nodes: [
    { id: "you", label: "A contact writes", sub: "iMessage · WhatsApp", tone: "client", x: 10, y: 20, w: 160 },
    { id: "dev", label: "Your agent code", sub: "SDK · CLI · REST", tone: "client", x: 390, y: 20, w: 160 },
    { id: "bridge", label: "pal bridge", sub: "on your Mac", tone: "pal", x: 10, y: 160, w: 160, detail: "Reads the message, keeps your people and memory, and runs every check on the draft before anything is sent.", src: [M(`${BC}/agent.ts`)] },
    { id: "cp", label: "PAL Runtime", sub: "sessions · runs · journal", tone: "rt", x: 200, y: 160, w: 160, detail: "The control plane: sessions for pal's turns, runs for your agents, budgets checked before the model call, and a journal of every step.", src: [M("services/control-plane/internal/handlers/sessions.go"), M("services/control-plane/internal/handlers/budgets.go")] },
    { id: "llm", label: "Model call", sub: "your keys · failover", tone: "rt", x: 390, y: 160, w: 160 },
    { id: "gates", label: "Gates", sub: "money · dates · grief", tone: "pal", x: 10, y: 300, w: 160, detail: "The commitment and grounding gates. Each is a model judgment plus a deterministic backstop, so an outage cannot fail open.", src: [M(`${BC}/commitment-gate.ts`), M(`${BC}/grounding-gate.ts`)] },
    { id: "send", label: "Sent as you", sub: "paced like you", tone: "ok", x: 200, y: 262, w: 160, src: [M(`${BC}/pacing.ts`)] },
    { id: "held", label: "Held for you", sub: "page to self-chat", tone: "deny", x: 200, y: 340, w: 160 },
    { id: "vm", label: "microVM", sub: "egress allowlist", tone: "guest", x: 390, y: 300, w: 160, detail: "Untrusted code runs in a Firecracker or Kata microVM. Egress goes through an allowlist; secrets are vended at run time, never baked in.", src: [M("services/runtime-manager/src/egress_broker.rs")] },
  ],
  edges: [
    { from: "you", to: "bridge" },
    { from: "bridge", to: "cp", label: "turn", bidi: true },
    { from: "cp", to: "llm", bidi: true },
    { from: "bridge", to: "gates", label: "draft" },
    { from: "gates", to: "send", via: [[185, 327], [185, 289]] },
    { from: "gates", to: "held" },
    { from: "dev", to: "cp", label: "run", via: [[470, 120], [280, 120]] },
    { from: "cp", to: "vm", label: "tool code", via: [[280, 245], [470, 245]] },
  ],
  scenarios: [
    {
      id: "reply", label: "pal sends",
      steps: [
        { title: "A contact writes", note: "The bridge on your Mac picks up the message from iMessage or WhatsApp.", edges: ["you>bridge"] },
        { title: "A draft in your voice", note: "The bridge posts the turn to a session on PAL Runtime, which calls your model provider.", edges: ["bridge>cp", "cp>llm"] },
        { title: "Checked, then sent", note: "Nothing commits you and nothing is unverifiable, so the reply goes out, paced like you.", edges: ["bridge>gates", "gates>send"] },
      ],
    },
    {
      id: "held", label: "pal holds",
      steps: [
        { title: "A relative asks for money", note: "The draft says \"sending it now\".", edges: ["you>bridge", "bridge>cp", "cp>llm"] },
        { title: "Held, not sent", note: "The commitment gate holds it and pages your self-chat. Your one typed line becomes the reply.", edges: ["bridge>gates", "gates>held"], deny: true },
      ],
    },
    {
      id: "run", label: "Your agent",
      steps: [
        { title: "Your code starts a run", note: "POST /v1/runs from an SDK, the CLI or curl.", edges: ["dev>cp"] },
        { title: "Budget first, then the model", note: "A hard cap answers 402 before any model call. Every step is journaled, so a crash resumes instead of restarting.", edges: ["cp>llm"] },
        { title: "Untrusted code in a microVM", note: "Tool code runs behind an egress allowlist, never on the host.", edges: ["cp>vm"] },
      ],
    },
  ],
  legend: [["pal", "pal"], ["rt", "PAL Runtime"], ["ok", "Sent"], ["deny", "Held"]],
};
