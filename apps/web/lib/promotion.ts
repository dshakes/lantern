// Types + pure view-model helpers for agent lifecycle promotion (ADR 0054).
// JSON shapes mirror services/control-plane/internal/handlers/promotion.go.

export type PromoEnv = "sandbox" | "staging" | "prod";
export const PROMO_ENVS: readonly PromoEnv[] = ["sandbox", "staging", "prod"];

export type PromotionStatus =
  | "pending_approval"
  | "rejected"
  | "canary"
  | "promoted"
  | "rolled_back";

export interface Gate {
  name: string;
  status: string;
  detail?: string;
}

export interface EnvState {
  env: PromoEnv;
  version: string;
  previousVersion?: string | null;
  status: "active" | "canary";
  promotionId?: string | null;
  canaryPct?: number | null;
  lastSandboxRun?: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

export interface Promotion {
  guards?: Record<string, unknown> | null;
  id: string;
  agentName: string;
  env: PromoEnv;
  version: string;
  fromVersion?: string | null;
  status: PromotionStatus;
  canaryPct?: number | null;
  gates?: Gate[] | null;
  requestedBy: string;
  requestedByKind: "human" | "agent" | "system";
  approver?: string | null;
  note?: string | null;
  createdAt: string;
}

export interface AgentEnvironments {
  agentName: string;
  environments: EnvState[];
  promotions: Promotion[];
}

export interface AuditEntry {
  id: string;
  agentName: string;
  env?: string | null;
  promotionId?: string | null;
  action: string;
  actor: string;
  actorKind: "human" | "agent" | "system";
  detail?: Record<string, unknown> | string | null;
  createdAt: string;
}

export interface CanaryStats {
  Terminal: number;
  Failed: number;
  AvgCost: number;
}

export interface CanaryEvaluation {
  verdict: { verdict: "hold" | "pass" | "trip"; reasons?: string[] | null };
  action: "none" | "rolled_back" | "completed";
  candidate: CanaryStats;
  stable: CanaryStats;
  guards: { maxErrorRate: number; maxCostRatio: number; minEvalScore: number; minRuns: number };
}

/** Rollback needs a version to go back to (or an active canary to abort). */
export function canRollback(e: EnvState): boolean {
  return e.status === "canary" || (!!e.previousVersion && e.previousVersion !== e.version);
}

export function envBadgeLabel(e: EnvState): string {
  if (e.status === "canary") return `canary ${e.canaryPct ?? 0}%`;
  return "active";
}

export function errorRate(s: CanaryStats): number | null {
  return s.Terminal > 0 ? s.Failed / s.Terminal : null;
}

export function fmtPct(r: number | null): string {
  return r === null ? "—" : `${(r * 100).toFixed(1)}%`;
}

export function fmtCost(c: number): string {
  return `$${c.toFixed(4)}`;
}

export function proposedBy(p: Pick<Promotion, "requestedBy" | "requestedByKind">): string {
  return p.requestedByKind === "agent"
    ? `proposed by an agent (${p.requestedBy})`
    : `proposed by ${p.requestedBy}`;
}

export function gatesFailed(gates?: Gate[] | null): Gate[] {
  return (gates ?? []).filter((g) => g.status !== "pass" && g.status !== "passed");
}

export function gateTone(status: string): "ok" | "warn" | "danger" {
  if (status === "pass" || status === "passed") return "ok";
  if (status === "skipped" || status === "pending") return "warn";
  return "danger";
}

export interface ApiFail {
  status: number;
  code?: string;
  message: string;
  gates?: Gate[];
}

/** runtimeApi throws `API <status>: <body>`; recover status/code/gates/message. */
export function parseApiError(err: unknown): ApiFail {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /^API (\d+): ([\s\S]*)$/.exec(raw);
  if (!m) return { status: 0, message: raw };
  const status = Number(m[1]);
  try {
    const j = JSON.parse(m[2]) as Record<string, unknown>;
    const msg = [j.error, j.message].find((v) => typeof v === "string") as string | undefined;
    return {
      status,
      code: typeof j.code === "string" ? j.code : undefined,
      message: msg ?? m[2],
      gates: Array.isArray(j.gates) ? (j.gates as Gate[]) : undefined,
    };
  } catch {
    return { status, message: m[2] || raw };
  }
}

export function validatePromote(f: { env: PromoEnv; canaryPct: string }): string | null {
  if (f.env !== "prod" || f.canaryPct.trim() === "") return null;
  const n = Number(f.canaryPct);
  return Number.isInteger(n) && n >= 1 && n <= 99 ? null : "Canary % must be a whole number 1–99";
}

/** One-line summary of an audit detail object (the API sends JSON, not a string). */
export function summarizeDetail(d: unknown): string {
  if (d == null) return "";
  if (typeof d === "string") return d;
  if (typeof d !== "object") return String(d);
  return Object.entries(d as Record<string, unknown>)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: ${v.length} item${v.length === 1 ? "" : "s"}`;
      if (typeof v === "object") return `${k}: …`;
      return `${k}: ${String(v)}`;
    })
    .join(" · ")
    .slice(0, 240);
}
