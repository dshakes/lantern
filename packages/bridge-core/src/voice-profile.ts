// voice-profile.ts — Phase 2: LLM-reasoned owner voice profile.
//
// Phase 1 (live): verbatim owner-message exemplars let the LLM SEE how the
// owner writes (owner-voice.ts → formatOwnerVoiceBlock). The LLM must infer
// the patterns itself.
//
// Phase 2 (this module): analyze those same exemplars with a second LLM call
// and produce EXPLICIT guidance — "terse, direct, switches to Telugu for
// warmth, 🙏 for thanks only" — so the reply LLM doesn't have to guess.
//
// Flag-gated: LANTERN_VOICE_REASONING=1. When unset/0 the inferStyle
// heuristic path is entirely unchanged and this module is never called.
//
// Fail-safe contract (enforced throughout):
//   - parseVoiceProfile returns null on ANY parsing error.
//   - VoiceProfileCache.getInstruction returns null on any LLM error /
//     empty result / stale-and-not-yet-refreshed state.
//   - A null from getInstruction means voiceReasoningHint is not passed
//     → agentPersonaPrompt output is byte-identical to today.
//   - The cache never throws; errors are caught + logged locally.
//
// Session key: "owner::voice-profile" — never a contact JID.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

// ── Flag gate ────────────────────────────────────────────────────────────────

/** Returns true when LANTERN_VOICE_REASONING is "1", "true", or "on". */
export function isVoiceReasoningEnabled(): boolean {
  const v = (process.env["LANTERN_VOICE_REASONING"] ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VoiceHint {
  /** Conversational register the owner uses when texting. */
  register: "very-casual" | "casual" | "direct" | "semi-formal";
  /** Typical reply length. */
  sentenceLength: "terse" | "medium" | "variable";
  /** Language mix description, e.g. "English, occasional Telugu words". Max 80 chars. */
  languageMix: string;
  /** Emoji use description, e.g. "rarely — 🙏 for warmth, 😂 for humor". Max 100 chars. */
  emojiUse: string;
  /** Interpersonal warmth level. */
  warmth: "warm" | "dry" | "neutral";
  /** Up to 5 specific observable patterns from the owner's messages. */
  patterns: string[];
}

const REGISTER_VALUES = ["very-casual", "casual", "direct", "semi-formal"] as const;
const SENTENCE_LENGTH_VALUES = ["terse", "medium", "variable"] as const;
const WARMTH_VALUES = ["warm", "dry", "neutral"] as const;

// ── Pure functions ────────────────────────────────────────────────────────────

/**
 * Builds the LLM prompt that asks for a structured voice profile.
 * Pure — no I/O, no side effects. Testable without a live LLM.
 */
export function buildVoiceProfilePrompt(
  ownerMessages: string[],
  ownerName: string,
): string {
  // Take the most-recent 60 messages to keep the prompt compact.
  const sample = ownerMessages.slice(-60).join("\n");
  return [
    `You are analyzing text messages that ${ownerName} ACTUALLY SENT to build a voice profile.`,
    `Reason from the messages below — do NOT count ratios or compute statistics.`,
    `Describe observable patterns in plain English.`,
    ``,
    `Messages sent by ${ownerName}:`,
    `---`,
    sample || "(no messages available yet)",
    `---`,
    ``,
    `Output ONLY valid JSON on one logical block — no preamble, no trailing prose:`,
    `{`,
    `  "register": ${REGISTER_VALUES.map((v) => `"${v}"`).join(" | ")},`,
    `  "sentenceLength": ${SENTENCE_LENGTH_VALUES.map((v) => `"${v}"`).join(" | ")},`,
    `  "languageMix": "<concise, max 80 chars>",`,
    `  "emojiUse": "<concise, max 100 chars>",`,
    `  "warmth": ${WARMTH_VALUES.map((v) => `"${v}"`).join(" | ")},`,
    `  "patterns": ["<pattern>", ...at most 5 short patterns from the actual messages]`,
    `}`,
  ].join("\n");
}

/**
 * Tolerantly parses the LLM output into a VoiceHint.
 * Returns null on ANY problem — unknown fields, bad enum values, missing
 * required fields, invalid JSON. Never throws.
 *
 * Pure — no I/O.
 */
export function parseVoiceProfile(raw: string): VoiceHint | null {
  if (!raw || !raw.trim()) return null;
  try {
    // Extract the first {...} block in case the LLM added prose around it.
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) return null;
    const jsonStr = raw.slice(jsonStart, jsonEnd + 1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: any = JSON.parse(jsonStr);
    if (typeof obj !== "object" || obj === null) return null;

    const register = obj["register"];
    if (!(REGISTER_VALUES as readonly string[]).includes(register)) return null;

    const sentenceLength = obj["sentenceLength"];
    if (!(SENTENCE_LENGTH_VALUES as readonly string[]).includes(sentenceLength)) return null;

    const warmth = obj["warmth"];
    if (!(WARMTH_VALUES as readonly string[]).includes(warmth)) return null;

    const languageMix = String(obj["languageMix"] ?? "").slice(0, 80).trim();
    if (!languageMix) return null;

    const emojiUse = String(obj["emojiUse"] ?? "").slice(0, 100).trim();
    if (!emojiUse) return null;

    const rawPatterns = obj["patterns"];
    const patterns: string[] = Array.isArray(rawPatterns)
      ? rawPatterns
          .slice(0, 5)
          .map((p: unknown) => String(p).trim().slice(0, 120))
          .filter(Boolean)
      : [];

    return {
      register: register as VoiceHint["register"],
      sentenceLength: sentenceLength as VoiceHint["sentenceLength"],
      warmth: warmth as VoiceHint["warmth"],
      languageMix,
      emojiUse,
      patterns,
    };
  } catch {
    return null;
  }
}

/**
 * Converts a VoiceHint into a plain-English instruction block suitable
 * for injection into the persona prompt.
 *
 * Pure — no I/O.
 */
export function voiceHintToInstruction(hint: VoiceHint, ownerName: string): string {
  const lines: string[] = [
    `## ${ownerName}'s voice (LLM-reasoned from real messages):`,
    `- Register: ${hint.register}`,
    `- Reply length: ${hint.sentenceLength}`,
    `- Language: ${hint.languageMix}`,
    `- Emoji: ${hint.emojiUse}`,
    `- Warmth: ${hint.warmth}`,
  ];
  if (hint.patterns.length > 0) {
    lines.push(`- Observed patterns: ${hint.patterns.join("; ")}`);
  }
  lines.push(
    `Write EXACTLY the way these patterns describe — not what "casual" generically means, but what ${ownerName} actually does.`,
  );
  return lines.join("\n");
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/** Injected LLM caller — returns the raw LLM text or null on error. */
export type LLMCaller = (prompt: string) => Promise<string | null>;

interface CacheEntry {
  hint: VoiceHint;
  ts: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min

/**
 * Caches the LLM-computed VoiceHint with a TTL.
 *
 * - Never throws; all errors are caught internally.
 * - Returns the cached hint immediately and refreshes in the background
 *   when stale. A reply is NEVER blocked waiting for the LLM.
 * - When nothing is cached yet and the first refresh is in-flight,
 *   returns null → agentPersonaPrompt is byte-identical to today.
 * - Persists to `<stateDir>/voice-profile.json` (mode 0600) so it
 *   survives restarts.
 */
export class VoiceProfileCache {
  private cached: CacheEntry | null = null;
  private refreshing = false;
  private readonly ttlMs: number;
  private readonly filePath: string | null;

  constructor(
    private readonly llmCall: LLMCaller,
    private readonly ownerName: string,
    opts?: {
      stateDir?: string;
      ttlMs?: number;
    },
  ) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.filePath = opts?.stateDir != null
      ? join(opts.stateDir, "voice-profile.json")
      : null;
  }

  /**
   * Returns the cached voice instruction string, or null when no hint is
   * available. Kicks off a background refresh when the cache is stale.
   */
  getInstruction(ownerMessages: string[]): string | null {
    this.maybeRefresh(ownerMessages);
    return this.cached != null
      ? voiceHintToInstruction(this.cached.hint, this.ownerName)
      : null;
  }

  /**
   * Load persisted cache from disk. Best-effort — no-ops on any error.
   * Call once on startup (after await) to warm the in-memory cache from a
   * prior session.
   */
  async warmFromDisk(): Promise<void> {
    if (!this.filePath) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "hint" in parsed &&
        "ts" in parsed
      ) {
        const entry = parsed as { hint: unknown; ts: unknown };
        // Only use if not expired
        const ts = typeof entry.ts === "number" ? entry.ts : 0;
        if (Date.now() - ts < this.ttlMs * 2) {
          const hint = parseVoiceProfile(JSON.stringify(entry.hint));
          if (hint) {
            this.cached = { hint, ts };
          }
        }
      }
    } catch {
      // File missing, corrupt, etc. — not an error, just start cold.
    }
  }

  private maybeRefresh(ownerMessages: string[]): void {
    if (this.refreshing) return;
    const isStale =
      this.cached == null || Date.now() - this.cached.ts > this.ttlMs;
    if (!isStale) return;
    this.refreshing = true;
    void this.doRefresh(ownerMessages);
  }

  private async doRefresh(ownerMessages: string[]): Promise<void> {
    try {
      const prompt = buildVoiceProfilePrompt(ownerMessages, this.ownerName);
      const raw = await this.llmCall(prompt);
      if (raw) {
        const hint = parseVoiceProfile(raw);
        if (hint) {
          this.cached = { hint, ts: Date.now() };
          await this.persist();
        }
      }
    } catch {
      // Fail-safe: keep old cached value or null; never surface to caller.
    } finally {
      this.refreshing = false;
    }
  }

  private async persist(): Promise<void> {
    if (!this.filePath || !this.cached) return;
    try {
      const dir = dirname(this.filePath);
      await mkdir(dir, { recursive: true });
      await writeFile(
        this.filePath,
        JSON.stringify(this.cached, null, 2),
        { mode: 0o600 },
      );
    } catch {
      // Disk write failure is non-fatal.
    }
  }
}
