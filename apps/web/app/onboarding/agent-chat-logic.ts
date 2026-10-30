// ---------------------------------------------------------------------------
// Pure client logic for the onboarding AGENT conversation (ADR 0051), shared by
// the PAL Runtime builder flow (/onboarding) and pal (/pal/onboarding).
//
// The server (POST /v1/onboarding/agent/turn) owns the conversation, the gates
// and the facts; this file only decides how the client shows them:
//   - which progress-rail rows are done / current, from read-back facts
//   - whether to stay in the conversation or drop to the labelled wizard
//   - how a client-run tool is reported back (never carrying a secret)
//
// Self-contained on purpose: the unit tests load this file through tsx's ESM
// hook only, which cannot resolve a nested extension-less .ts import.
// ---------------------------------------------------------------------------

export type ChatProduct = "runtime" | "pal";

export interface ChatMessage {
  role: "user" | "agent" | "tool";
  text: string;
  tool?: string;
  ok?: boolean;
  at?: string;
}

export interface ChatActionArgs {
  provider?: string;
  reason?: string;
  correction?: string;
  modes?: Record<string, "auto" | "ask" | "off">;
  quietStart?: number | null;
  quietEnd?: number | null;
  why?: string;
  items?: Array<{
    section: "facts" | "relationships";
    key: string;
    value: string;
    addressAs?: string;
    never?: string[];
    quote: string;
  }>;
}

/** A tool the agent asked the CLIENT to run (bridges, secure key form, consent, confirmations). */
export type ClientTool =
  | "collect_provider_key"
  | "ask_consent"
  | "check_channels"
  | "start_imessage"
  | "pair_whatsapp"
  | "learn_voice"
  | "confirm_trust"
  | "confirm_profile"
  | "show_brief";

export interface ChatAction {
  id: string;
  tool: ClientTool | string;
  args: ChatActionArgs;
}

export interface ToolCall {
  tool: string;
  ok: boolean;
  refused?: boolean;
  summary: string;
  data?: unknown;
}

export interface ChannelObs {
  whatsapp?: string;
  imessage?: string;
  at?: string;
}

export interface RuntimeFacts {
  goal?: string;
  spec?: { name: string; description?: string; systemPrompt?: string; firstInput?: { prompt?: string }; rationale?: string; model?: string };
  specApproved?: boolean;
  agentName?: string;
  agentCreated?: boolean;
  runId?: string;
  runStatus?: string;
  sandbox?: string;
  completedAt?: string;
}

export interface PalFacts {
  consent?: { version: string; acceptedAt?: string; voiceSampling?: boolean };
  voice?: { approved?: boolean; skipped?: boolean; profile?: unknown };
  trust?: { prefsSaved?: boolean; holdsAcknowledged?: boolean };
  profile?: { items?: unknown[]; done?: boolean };
  completedAt?: string;
  resumeStep?: string;
}

export interface Facts {
  providerReady: boolean;
  phase: string;
  channelsVerified?: boolean;
  channels?: ChannelObs;
  runtime?: RuntimeFacts;
  pal?: PalFacts;
}

export interface TurnResponse {
  product: ChatProduct;
  mode: "agent" | "scripted" | "fallback";
  reply: string;
  actions: ChatAction[];
  toolCalls: ToolCall[];
  facts: Facts;
  messages: ChatMessage[];
  fallbackReason?: string;
}

/** What a client sends back after running an action. */
export interface ToolResult {
  actionId: string;
  tool: string;
  ok: boolean;
  summary: string;
  channels?: { whatsapp: string; imessage: string };
}

// ---- progress rail --------------------------------------------------------

export interface RailStep {
  id: string;
  label: string;
  hint: string;
}

export const RAIL: Record<ChatProduct, ReadonlyArray<RailStep>> = {
  runtime: [
    { id: "provider", label: "Model key", hint: "A real test call to your provider" },
    { id: "goal", label: "Your goal", hint: "In your own words" },
    { id: "spec", label: "The design", hint: "Proposed, then approved by you" },
    { id: "create", label: "Create the agent", hint: "Saved to your workspace" },
    { id: "run", label: "First run", hint: "Real output" },
    { id: "done", label: "Next steps", hint: "Channels, budgets, evals" },
  ],
  pal: [
    { id: "provider", label: "Model key", hint: "Your own provider, tested" },
    { id: "welcome", label: "Meet pal", hint: "What it touches + your consent" },
    { id: "channels", label: "Connect channels", hint: "Checked live on your Mac" },
    { id: "voice", label: "Learn your voice", hint: "Only with your opt-in" },
    { id: "trust", label: "Set trust", hint: "What pal may do alone" },
    { id: "profile", label: "Your people", hint: "Facts pal must never get wrong" },
    { id: "done", label: "First Brief", hint: "What needs you" },
  ],
};

export type RailStatus = "done" | "current" | "todo";

const PAL_CONSENT_VERSION = "2026-10";

function palDone(id: string, f: Facts): boolean {
  const p = f.pal ?? {};
  const consented = !!p.consent?.acceptedAt && p.consent.version === PAL_CONSENT_VERSION;
  const voice = !!p.voice && (!!p.voice.skipped || (!!p.voice.approved && !!p.voice.profile));
  const trust = !!p.trust?.prefsSaved && !!p.trust?.holdsAcknowledged;
  switch (id) {
    case "provider":
      return f.providerReady;
    case "welcome":
      return consented;
    case "channels":
      return voice || !!f.channelsVerified;
    case "voice":
      return voice;
    case "trust":
      return trust;
    case "profile":
      return !!p.profile?.done;
    case "done":
      return !!p.completedAt;
  }
  return false;
}

function runtimeDone(id: string, f: Facts): boolean {
  const r = f.runtime ?? {};
  switch (id) {
    case "provider":
      return f.providerReady;
    case "goal":
      return !!r.goal?.trim();
    case "spec":
      return !!r.spec && (!!r.specApproved || !!r.agentCreated);
    case "create":
      return !!r.agentCreated;
    case "run":
      return r.runStatus === "succeeded";
    case "done":
      return !!r.completedAt;
  }
  return false;
}

/** The rail row the server's phase maps to. */
export function railCurrent(product: ChatProduct, phase: string): string {
  if (product === "runtime") return phase === "finish" ? "done" : phase;
  return phase;
}

/** Each rail row's status, from read-back facts (not from list order). */
export function railStatuses(product: ChatProduct, facts: Facts | null | undefined): Array<RailStep & { status: RailStatus }> {
  const f: Facts = facts ?? { providerReady: false, phase: "provider" };
  const current = railCurrent(product, f.phase);
  const done = product === "pal" ? palDone : runtimeDone;
  return RAIL[product].map((s) => ({
    ...s,
    status: done(s.id, f) && s.id !== current ? "done" : s.id === current ? "current" : "todo",
  }));
}

// ---- mode -------------------------------------------------------------------

export type ChatView = { kind: "chat" } | { kind: "wizard"; reason: string };

/**
 * Stay in the conversation unless the agent itself says it can't reason
 * (model failure). A scripted turn (no key yet) is still the conversation.
 */
export function decideView(resp: Pick<TurnResponse, "mode" | "fallbackReason"> | null, requestError?: unknown): ChatView {
  if (requestError) {
    return { kind: "wizard", reason: `The onboarding agent isn't reachable (${errorText(requestError)}).` };
  }
  if (resp?.mode === "fallback") {
    return { kind: "wizard", reason: resp.fallbackReason ? capitalize(resp.fallbackReason) + "." : "The onboarding agent couldn't reach the model." };
  }
  return { kind: "chat" };
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function errorText(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.replace(/^API \d{3}:\s*/, "").slice(0, 200);
  if (typeof err === "string" && err.trim()) return err.slice(0, 200);
  return "unknown error";
}

// ---- secrets ------------------------------------------------------------------

const KEY_PATTERNS = [/sk-ant-[A-Za-z0-9_-]{20,}/g, /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g];

/** Mask anything key-shaped for the optimistic chat bubble (the server redacts too). */
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of KEY_PATTERNS) out = out.replace(re, "[provider key — saved securely, removed from chat]");
  return out;
}

export function containsProviderKey(text: string): boolean {
  return KEY_PATTERNS.some((re) => new RegExp(re.source).test(text));
}

// ---- tool results -----------------------------------------------------------------

export function channelSummary(c: { whatsapp: string; imessage: string }): string {
  const fmt = (name: string, v: string, ok: string) => `${name} ${v === ok ? "connected" : v.replace(/_/g, " ")}`;
  return `${fmt("iMessage", c.imessage, "ready")}; ${fmt("WhatsApp", c.whatsapp, "connected")}`;
}

/**
 * Build the report for a finished client action. Summaries are plain facts the
 * client observed; they never carry a key (masked defensively) and are capped.
 */
export function toolResult(action: Pick<ChatAction, "id" | "tool">, ok: boolean, summary: string, channels?: { whatsapp: string; imessage: string }): ToolResult {
  const r: ToolResult = { actionId: action.id, tool: action.tool, ok, summary: maskSecrets(summary).slice(0, 400) };
  if (channels) r.channels = { whatsapp: channels.whatsapp, imessage: channels.imessage };
  return r;
}

/** The message to show while a turn is in flight (optimistic, masked). */
export function optimisticUserMessage(text: string): ChatMessage | null {
  const t = text.trim();
  return t ? { role: "user", text: maskSecrets(t) } : null;
}

export const ACTION_TITLES: Record<string, string> = {
  collect_provider_key: "Add a model key",
  ask_consent: "Your consent",
  check_channels: "Channel check",
  start_imessage: "Start iMessage",
  pair_whatsapp: "Link WhatsApp",
  learn_voice: "Your voice",
  confirm_trust: "Trust settings",
  confirm_profile: "Confirm what I heard",
  show_brief: "Your first Brief",
};

/** Human label for a tool chip in the transcript. */
export function toolLabel(tool: string | undefined): string {
  if (!tool) return "tool";
  const labels: Record<string, string> = {
    save_provider_key: "Saved model key",
    test_provider: "Tested model key",
    design_agent: "Designed the agent",
    create_agent: "Created the agent",
    start_run: "First run",
    finish: "Finished setup",
    skip_voice: "Skipped voice",
    propose_trust: "Proposed trust settings",
    extract_profile: "Read your people",
    finish_profile: "Closed your people",
    ...ACTION_TITLES,
  };
  return labels[tool] ?? tool.replace(/_/g, " ");
}

/** The latest structured result of a tool this session (spec, run output). */
export function latestData<T = unknown>(calls: ToolCall[], tool: string): T | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].tool === tool && calls[i].ok && calls[i].data !== undefined) return calls[i].data as T;
  }
  return null;
}
