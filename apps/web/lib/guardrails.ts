// ---------------------------------------------------------------------------
// Guardrails — client-side safety filters for agent output
// ---------------------------------------------------------------------------

export interface GuardrailConfig {
  contentFilter: boolean;
  blockPII: boolean;
  blockToxic: boolean;
  blockedTopics: string[];
  maxResponseLength: number;
}

export interface GuardrailResult {
  text: string;
  blocked: boolean;
  warnings: string[];
}

const DEFAULT_CONFIG: GuardrailConfig = {
  contentFilter: false,
  blockPII: false,
  blockToxic: false,
  blockedTopics: [],
  maxResponseLength: 0,
};

// PII patterns
const PII_PATTERNS: Array<{ regex: RegExp; label: string; replacement: string }> = [
  { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: "email address", replacement: "[EMAIL REDACTED]" },
  { regex: /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g, label: "phone number", replacement: "[PHONE REDACTED]" },
  { regex: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, label: "SSN", replacement: "[SSN REDACTED]" },
  { regex: /\b(?:\d[ -]*?){13,16}\b/g, label: "credit card", replacement: "[CARD REDACTED]" },
];

// Basic toxicity keywords (content filter)
const TOXIC_PATTERNS = /\b(kill\s+yourself|kys|hate\s+speech|racial\s+slur|bomb\s+threat)\b/gi;

export function applyGuardrails(text: string, config: GuardrailConfig): GuardrailResult {
  const warnings: string[] = [];
  let result = text;
  let blocked = false;

  // PII detection and redaction
  if (config.blockPII) {
    for (const p of PII_PATTERNS) {
      const matches = result.match(p.regex);
      if (matches) {
        warnings.push(`Redacted ${matches.length} ${p.label}(s)`);
        result = result.replace(p.regex, p.replacement);
      }
    }
  }

  // Toxic content filter
  if (config.blockToxic) {
    if (TOXIC_PATTERNS.test(result)) {
      warnings.push("Toxic content detected and blocked");
      blocked = true;
      result = "[Content blocked by safety filter]";
      return { text: result, blocked, warnings };
    }
  }

  // Blocked topics
  if (config.blockedTopics.length > 0) {
    const lower = result.toLowerCase();
    for (const topic of config.blockedTopics) {
      const trimmed = topic.trim().toLowerCase();
      if (trimmed && lower.includes(trimmed)) {
        warnings.push(`Blocked topic detected: "${topic.trim()}"`);
        blocked = true;
        result = `[Content blocked: contains restricted topic "${topic.trim()}"]`;
        return { text: result, blocked, warnings };
      }
    }
  }

  // General content filter (flag suspicious patterns)
  if (config.contentFilter) {
    const suspiciousPatterns = /\b(password|secret|api[_-]?key|token|credentials?)\s*[:=]\s*\S+/gi;
    const matches = result.match(suspiciousPatterns);
    if (matches) {
      warnings.push(`Content filter: ${matches.length} potential secret(s) detected`);
      result = result.replace(suspiciousPatterns, "[FILTERED: potential secret]");
    }
  }

  // Max response length
  if (config.maxResponseLength > 0 && result.length > config.maxResponseLength) {
    warnings.push(`Truncated from ${result.length} to ${config.maxResponseLength} characters`);
    result = result.slice(0, config.maxResponseLength) + "\n\n[Truncated: max response length reached]";
  }

  return { text: result, blocked, warnings };
}

// localStorage helpers
const GUARDRAILS_KEY_PREFIX = "lantern_guardrails_";

export function getGuardrailConfig(agentName: string): GuardrailConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = localStorage.getItem(GUARDRAILS_KEY_PREFIX + agentName);
    if (!raw) return DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveGuardrailConfig(agentName: string, config: GuardrailConfig): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(GUARDRAILS_KEY_PREFIX + agentName, JSON.stringify(config));
}

export function hasActiveGuardrails(config: GuardrailConfig): boolean {
  return config.contentFilter || config.blockPII || config.blockToxic || config.blockedTopics.length > 0 || config.maxResponseLength > 0;
}
