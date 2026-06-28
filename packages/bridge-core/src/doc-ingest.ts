// doc-ingest.ts — Mac-file ingestion for the Lantern life-domain trackers.
//
// Scans the owner's local documents (medical reports, insurance cards,
// vehicle/registration, etc.) and files them into the domain-records store,
// alongside the existing Gmail ingestion.
//
// ADDITIVE, OWNER-ONLY. Ships dark behind LANTERN_DOC_INGEST=on.
// Every file path goes through PersonalDocs.isAllowedPath before read.
// NEVER logs doc content, OCR text, extracted fields, or PII — only counts
// + domains + basenames at debug level.
//
// Pure parts (classifyDocForDomain, buildDocExtractPrompt, parseDocExtraction,
// DomainRecordsClient, state helpers, file listing) live here. The bridge
// sessions wire the tick + timer.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

// ── Domain classification ─────────────────────────────────────────────────────

// Each tuple: [regex, domain, kind]. First match wins (most-specific first).
// Applied to filename.toLowerCase() THEN optional snippet.toLowerCase().
// ponytail: keyword list is conservative — prefers misses over false positives.
const RULES: Array<[RegExp, string, string]> = [
  // ── health ──
  [/\b(?:lab[\s_-]?result|blood[\s_-]?test|cbc|lipid[\s_-]?panel|hba1c)\b/i, "health", "lab_result"],
  [/\b(?:prescription|rx\b|medication[\s_-]?list)\b/i, "health", "prescription"],
  [/\b(?:eob|explanation[\s_-]?of[\s_-]?benefit|insurance[\s_-]?card|health[\s_-]?insurance|medical[\s_-]?insurance|bcbs|aetna|cigna|unitedhealth)\b/i, "health", "insurance"],
  [/\b(?:immunization|vaccination|vaccine|shot[\s_-]?record)\b/i, "health", "immunization"],
  [/\bdischarge[\s_-]?summary\b/i, "health", "discharge_summary"],
  [/\b(?:medical[\s_-]?record|doctor[\s_-]?note|physician|clinic|hospital[\s_-]?bill|eop|remittance)\b/i, "health", "medical"],
  // ── vehicle ──
  [/\b(?:auto[\s_-]?insurance|car[\s_-]?insurance|vehicle[\s_-]?insurance|geico|progressive|state[\s_-]?farm)\b/i, "vehicle", "insurance"],
  [/\b(?:vehicle[\s_-]?registration|car[\s_-]?registration|dmv[\s_-]?registration)\b/i, "vehicle", "registration"],
  [/\bregistration\b/i, "vehicle", "registration"],
  [/\b(?:vin\b|vehicle[\s_-]?title|car[\s_-]?title)\b/i, "vehicle", "title"],
  [/\b(?:service[\s_-]?record|oil[\s_-]?change|maintenance[\s_-]?log|auto[\s_-]?repair|smog[\s_-]?check|carfax)\b/i, "vehicle", "service_record"],
  [/\bdmv\b/i, "vehicle", "dmv"],
  // ── home ──
  [/\b(?:home[\s_-]?insurance|homeowner[s']?|renter'?s?[\s_-]?insurance)\b/i, "home", "insurance"],
  [/\b(?:lease[\s_-]?agreement|rental[\s_-]?agreement|tenancy[\s_-]?agreement)\b/i, "home", "lease"],
  [/\bleasing?\b/i, "home", "lease"],
  [/\b(?:mortgage|deed[\s_-]?of[\s_-]?trust|home[\s_-]?loan|heloc)\b/i, "home", "mortgage"],
  [/\bhoa\b/i, "home", "hoa"],
  [/\b(?:utility[\s_-]?bill|electric[\s_-]?bill|gas[\s_-]?bill|water[\s_-]?bill)\b/i, "home", "utility"],
  [/\b(?:home[\s_-]?warranty|appliance[\s_-]?warranty|extended[\s_-]?warranty)\b/i, "home", "warranty"],
  [/\b(?:property[\s_-]?tax|assessed[\s_-]?value|tax[\s_-]?bill)\b/i, "home", "tax"],
  // ── travel ──
  [/\bboarding[\s_-]?pass\b/i, "travel", "boarding_pass"],
  [/\b(?:flight[\s_-]?(?:confirmation|itinerary|ticket)|travel[\s_-]?(?:itinerary|confirmation)|trip[\s_-]?itinerary)\b/i, "travel", "itinerary"],
  [/\bpassport\b/i, "travel", "passport"],
  [/\bvisa\b/i, "travel", "visa"],
  [/\b(?:hotel[\s_-]?reservation|booking[\s_-]?confirmation|airbnb)\b/i, "travel", "reservation"],
  // ── career ──
  [/\boffer[\s_-]?letter\b/i, "career", "offer_letter"],
  [/\b(?:resume|curriculum[\s_-]?vitae|cv\.pdf)\b/i, "career", "resume"],
  [/\b(?:diploma|degree[\s_-]?certificate|graduation)\b/i, "career", "certificate"],
  [/\btranscript\b/i, "career", "transcript"],
  [/\b(?:certificate|certification)\b/i, "career", "certificate"],
  [/\b(?:w2\b|w-2|1099|1099-nec|form[\s_-]?1040)\b/i, "career", "tax_doc"],
];

/**
 * PURE: Classify a filename (+ optional content snippet) into a life-domain record type.
 * Returns {domain, kind} on first match, or null for unclassified files.
 * Conservative — prefers misses over false positives.
 */
export function classifyDocForDomain(
  filename: string,
  snippet?: string,
): { domain: string; kind: string } | null {
  // Normalize underscores to spaces so \b word-boundaries work on "lab_result_2024.pdf"-style names.
  // (Underscore is \w in JS regex, so "lab_result" has no \b between the two tokens without this.)
  const fn = filename.toLowerCase().replace(/_/g, " ");
  const sn = (snippet || "").toLowerCase().replace(/_/g, " ");
  for (const [re, domain, kind] of RULES) {
    if (re.test(fn) || (sn && re.test(sn))) {
      return { domain, kind };
    }
  }
  return null;
}

// ── Domain records API client ─────────────────────────────────────────────────

/** Minimal fetch signature — matches authedFetch and test mocks. */
export type DomainRecordsFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface DomainRecordCreateRequest {
  domain: string;
  kind: string;
  title: string;
  fields?: Record<string, string>;
  source?: string;
  sourceRef?: string;
  validUntil?: string;
  idempotencyKey?: string;
}

/** Wraps POST /v1/domain-records. Best-effort — never throws. Mirrors CommitmentsClient. */
export class DomainRecordsClient {
  constructor(private readonly fetchFn: DomainRecordsFetch) {}

  /** Returns {id} on success or null on any failure. */
  async create(req: DomainRecordCreateRequest): Promise<{ id: string } | null> {
    try {
      const res = await this.fetchFn("/v1/domain-records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { id?: string };
      return data.id ? { id: data.id } : null;
    } catch {
      return null;
    }
  }
}

// ── LLM extraction ────────────────────────────────────────────────────────────

/**
 * Build the strict-JSON extraction prompt sent to the LLM via agent.respondTo.
 * The LLM must return ONLY valid JSON — no prose, no fences.
 */
export function buildDocExtractPrompt(domain: string, text: string): string {
  const schema =
    `{"records":[{"kind":"<kind>","title":"<short title>","fields":{"<key>":"<value>"},"validUntil":"<YYYY-MM-DD or omit>"}],` +
    `"obligations":[{"title":"<action required>","dueDate":"<YYYY-MM-DD or omit>","kind":"<task type>"}]}`;
  const rules = [
    `Domain: ${domain}`,
    "records: extract key structured facts (dates, IDs, amounts, parties, expiry/renewal dates)",
    "obligations: ONLY when a clear ACTION is required by the owner (renewal, payment, appointment, filing deadline)",
    "fields: flat string key-value pairs — no nesting, no raw text blobs",
    "validUntil: ISO date when this record expires or needs renewal (omit if none)",
    "Return [] for records or obligations when none apply",
    "DO NOT log SSNs or full credit card numbers — last-4 digits only",
  ].join("\n");
  return (
    `Extract structured facts from this ${domain} document.\nReturn ONLY valid JSON matching:\n${schema}\n\nRules:\n${rules}\n\nDocument:\n${text.slice(0, 8000)}`
  );
}

export interface DocExtractionRecord {
  kind: string;
  title: string;
  fields?: Record<string, string>;
  validUntil?: string;
}

export interface DocExtractionObligation {
  title: string;
  dueDate?: string;
  kind: string;
}

export interface DocExtraction {
  records: DocExtractionRecord[];
  obligations: DocExtractionObligation[];
}

/**
 * PURE: Parse raw LLM output into a DocExtraction.
 * Strips markdown fences, tolerates prose wrappers, returns null on failure.
 */
export function parseDocExtraction(raw: string): DocExtraction | null {
  if (!raw || typeof raw !== "string") return null;
  // Strip common markdown fences (```json ... ``` or ``` ... ```)
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  // Find the outermost JSON object (tolerates prose before/after)
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1)) as Partial<DocExtraction>;
    const records: DocExtractionRecord[] = Array.isArray(parsed.records)
      ? parsed.records.filter(
          (r): r is DocExtractionRecord =>
            r !== null &&
            typeof r === "object" &&
            typeof r.kind === "string" &&
            r.kind.length > 0 &&
            typeof r.title === "string" &&
            r.title.length > 0,
        )
      : [];
    const obligations: DocExtractionObligation[] = Array.isArray(parsed.obligations)
      ? parsed.obligations.filter(
          (o): o is DocExtractionObligation =>
            o !== null &&
            typeof o === "object" &&
            typeof o.title === "string" &&
            o.title.length > 0 &&
            typeof o.kind === "string" &&
            o.kind.length > 0,
        )
      : [];
    return { records, obligations };
  } catch {
    return null;
  }
}

// ── State management ──────────────────────────────────────────────────────────

/** Maps absolute file path → mtime epoch ms. Idempotency: skip files with unchanged mtime. */
export type DocIngestState = Record<string, number>;

export function loadDocIngestState(stateFile: string): DocIngestState {
  try {
    if (!existsSync(stateFile)) return {};
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: DocIngestState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDocIngestState(state: DocIngestState, stateFile: string): void {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    try { chmodSync(stateFile, 0o600); } catch {}
  } catch {
    // best-effort; never throw into the bridge
  }
}

// ── File enumeration ──────────────────────────────────────────────────────────

/** Read allowed roots from LANTERN_PERSONAL_DOCS_ROOTS — same source as PersonalDocs. */
export function getAllowedRoots(): string[] {
  const home = homedir();
  const envRoots = (process.env.LANTERN_PERSONAL_DOCS_ROOTS || "")
    .split(":")
    .map((r) => r.trim().replace(/^~/, home))
    .filter(Boolean);
  return envRoots.length > 0
    ? envRoots
    : [
        join(home, "Documents"),
        join(home, "Desktop"),
        join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"),
      ];
}

const DOC_EXTS = [".pdf", ".docx", ".doc", ".txt", ".md", ".png", ".jpg", ".jpeg"];
const PRUNE_DIRS = [
  "node_modules", ".git", ".next", "dist", "build",
  ".cache", "Caches", ".Trash", ".DS_Store",
];

/**
 * List doc-like files in `root` using `find`, up to `limit` results.
 * Prunes common non-document directories. 10s timeout.
 */
export function findDocFiles(
  root: string,
  limit: number,
): Promise<Array<{ path: string; mtime: number }>> {
  return new Promise((resolve) => {
    if (!existsSync(root)) { resolve([]); return; }
    // ( -name X -o -name Y ... ) -prune
    const pruneArgs: string[] = [];
    for (const p of PRUNE_DIRS) {
      if (pruneArgs.length) pruneArgs.push("-o");
      pruneArgs.push("-name", p);
    }
    // ( -iname *.pdf -o -iname *.docx ... ) -print
    const nameArgs: string[] = [];
    for (const e of DOC_EXTS) {
      if (nameArgs.length) nameArgs.push("-o");
      nameArgs.push("-iname", `*${e}`);
    }
    const args = [root, "(", ...pruneArgs, ")", "-prune", "-o", "(", ...nameArgs, ")", "-print"];
    const proc = spawn("find", args);
    let stdout = "";
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {}; resolve([]); }, 10_000);
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", () => {}); // swallow permission-denied noise
    proc.on("close", () => {
      clearTimeout(timer);
      const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const out: Array<{ path: string; mtime: number }> = [];
      for (const p of lines) {
        if (out.length >= limit) break;
        try {
          const st = statSync(p);
          if (st.isFile()) out.push({ path: p, mtime: st.mtimeMs });
        } catch {}
      }
      resolve(out);
    });
    proc.on("error", () => { clearTimeout(timer); resolve([]); });
  });
}

// Self-chat prefix — exported for bot-self.ts sync so the bridge never
// re-ingests its own "📄 filed N docs" ack as a fresh owner query.
export const DOC_INGEST_SELF_PREFIX = "📄 filed";
