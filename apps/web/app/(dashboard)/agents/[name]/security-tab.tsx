"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import clsx from "clsx";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Info,
  KeyRound,
  Pencil,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  LIST_FIELDS,
  diffPolicy,
  formatConnectors,
  normalizePolicy,
  parseApiError,
  parseConnectors,
  parseLines,
  policiesEqual,
  type AgentAuditEvent,
  type AgentIdentity,
  type AgentPolicy,
  type AgentPolicyDocument,
  type AgentPolicyProposal,
  type ListField,
} from "@/lib/agent-policy";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Modal, ModalField } from "@/components/modal";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";

const AUDIT_EVENTS = [
  "identity.created",
  "identity.rotated",
  "identity.revoked",
  "token.minted",
  "token.rejected",
  "policy.allowed",
  "policy.denied",
  "policy.updated",
  "a2a.invoke",
] as const;

const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : format(d, "MMM d, yyyy HH:mm:ss");
};

const errMsg = (e: unknown): string => parseApiError(e).message;

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-zinc-800 bg-surface-1 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: "warn" | "info" | "ok";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const cls = {
    warn: "border-amber-500/30 bg-amber-500/[0.08] text-amber-300",
    info: "border-sky-500/30 bg-sky-500/[0.08] text-sky-300",
    ok: "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-300",
  }[tone];
  return (
    <div className={clsx("flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs", cls)} role="status">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: "add" | "remove" }) {
  return (
    <span
      className={clsx(
        "inline-block max-w-full break-all rounded-md border px-2 py-0.5 font-mono text-[11px]",
        tone === "add" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
        tone === "remove" && "border-red-500/30 bg-red-500/10 text-red-300",
        !tone && "border-zinc-700 bg-surface-2 text-zinc-300",
      )}
    >
      {children}
    </span>
  );
}

function ChipList({ items, tone }: { items: string[]; tone?: "add" | "remove" }) {
  if (items.length === 0) return <span className="text-xs text-zinc-600">none</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <Chip key={i} tone={tone}>
          {i}
        </Chip>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: "active" | "revoked" }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        status === "active"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-red-500/30 bg-red-500/10 text-red-300",
      )}
    >
      {status}
    </span>
  );
}

function DecisionBadge({ decision }: { decision: AgentAuditEvent["decision"] }) {
  if (!decision) return <span className="text-zinc-600">—</span>;
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        decision === "allow"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-red-500/30 bg-red-500/10 text-red-300",
      )}
    >
      {decision}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Policy view
// ---------------------------------------------------------------------------

function PolicyView({ policy }: { policy: AgentPolicy }) {
  const connectorIds = Object.keys(policy.connectors).sort();
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      {LIST_FIELDS.map((f) => (
        <div key={f.key} className="min-w-0">
          <dt className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{f.label}</dt>
          <dd>
            <ChipList items={policy[f.key]} />
          </dd>
        </div>
      ))}
      <div className="min-w-0 sm:col-span-2">
        <dt className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Connectors → actions</dt>
        <dd className="space-y-1.5">
          {connectorIds.length === 0 && <span className="text-xs text-zinc-600">none</span>}
          {connectorIds.map((id) => (
            <div key={id} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-zinc-300">{id}</span>
              <span className="text-zinc-600">→</span>
              <ChipList items={policy.connectors[id]} />
            </div>
          ))}
        </dd>
      </div>
      <div className="min-w-0 sm:col-span-2">
        <dt className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Budget</dt>
        <dd className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-300">
          <span>
            Tool calls / run:{" "}
            <b className="tabular-nums">{policy.budget.maxToolCallsPerRun || "unlimited"}</b>
          </span>
          <span>
            Inbound A2A / min:{" "}
            <b className="tabular-nums">{policy.budget.maxA2AInboundPerMinute || "unlimited"}</b>
          </span>
        </dd>
      </div>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Policy editor
// ---------------------------------------------------------------------------

interface Draft {
  mode: AgentPolicy["mode"];
  lists: Record<ListField, string>;
  connectors: string;
  maxToolCallsPerRun: string;
  maxA2AInboundPerMinute: string;
}

function toDraft(p: AgentPolicy): Draft {
  const lists = Object.fromEntries(LIST_FIELDS.map((f) => [f.key, p[f.key].join("\n")])) as Record<ListField, string>;
  return {
    mode: p.mode,
    lists,
    connectors: formatConnectors(p.connectors),
    maxToolCallsPerRun: String(p.budget.maxToolCallsPerRun),
    maxA2AInboundPerMinute: String(p.budget.maxA2AInboundPerMinute),
  };
}

function fromDraft(d: Draft, version: number): { ok: true; policy: AgentPolicy } | { ok: false; error: string } {
  const conns = parseConnectors(d.connectors);
  if (!conns.ok) return { ok: false, error: conns.error };
  const num = (s: string, label: string): number | string => {
    const n = Number(s.trim() === "" ? "0" : s);
    return Number.isInteger(n) && n >= 0 ? n : `${label} must be a whole number ≥ 0`;
  };
  const a = num(d.maxToolCallsPerRun, "Tool calls per run");
  const b = num(d.maxA2AInboundPerMinute, "Inbound A2A per minute");
  if (typeof a === "string") return { ok: false, error: a };
  if (typeof b === "string") return { ok: false, error: b };
  const policy = normalizePolicy({
    mode: d.mode,
    tools: parseLines(d.lists.tools),
    connectors: conns.value,
    mcpServers: parseLines(d.lists.mcpServers),
    egressHosts: parseLines(d.lists.egressHosts),
    a2aTargets: parseLines(d.lists.a2aTargets),
    a2aInbound: parseLines(d.lists.a2aInbound),
    secrets: parseLines(d.lists.secrets),
    budget: { maxToolCallsPerRun: a, maxA2AInboundPerMinute: b },
    version,
  });
  return { ok: true, policy };
}

const inputCls =
  "w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-pal-500/50";

function PolicyEditor({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ModalField label="Mode">
        <select
          value={draft.mode}
          onChange={(e) => onChange({ ...draft, mode: e.target.value as Draft["mode"] })}
          className={inputCls}
        >
          <option value="enforce">enforce (default-deny)</option>
          <option value="legacy_permissive">legacy_permissive (allow everything, audited)</option>
        </select>
      </ModalField>
      <div className="hidden sm:block" />
      {LIST_FIELDS.map((f) => (
        <ModalField key={f.key} label={f.label}>
          <textarea
            rows={4}
            value={draft.lists[f.key]}
            onChange={(e) => onChange({ ...draft, lists: { ...draft.lists, [f.key]: e.target.value } })}
            placeholder="one per line"
            className={clsx(inputCls, "font-mono")}
            aria-label={f.label}
          />
          <p className="mt-1 text-[11px] text-zinc-600">{f.hint}</p>
        </ModalField>
      ))}
      <div className="sm:col-span-2">
        <ModalField label="Connectors (connector: action, action)">
          <textarea
            rows={4}
            value={draft.connectors}
            onChange={(e) => onChange({ ...draft, connectors: e.target.value })}
            placeholder={"github: list_*, get_issue\nslack: post_message"}
            className={clsx(inputCls, "font-mono")}
            aria-label="Connectors"
          />
        </ModalField>
      </div>
      <ModalField label="Max tool calls per run (0 = unlimited)">
        <input
          inputMode="numeric"
          value={draft.maxToolCallsPerRun}
          onChange={(e) => onChange({ ...draft, maxToolCallsPerRun: e.target.value })}
          className={inputCls}
        />
      </ModalField>
      <ModalField label="Max inbound A2A per minute (0 = unlimited)">
        <input
          inputMode="numeric"
          value={draft.maxA2AInboundPerMinute}
          onChange={(e) => onChange({ ...draft, maxA2AInboundPerMinute: e.target.value })}
          className={inputCls}
        />
      </ModalField>
    </div>
  );
}

function DiffView({ current, next }: { current: AgentPolicy; next: AgentPolicy }) {
  const diff = diffPolicy(current, next);
  if (diff.length === 0) return <p className="text-xs text-zinc-500">No changes versus the current policy.</p>;
  return (
    <div className="space-y-3">
      {diff.map((d) => (
        <div key={d.field} className="min-w-0">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{d.field}</div>
          <div className="space-y-1.5">
            {d.added.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-emerald-300">+</span>
                <ChipList items={d.added} tone="add" />
              </div>
            )}
            {d.removed.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-red-300">−</span>
                <ChipList items={d.removed} tone="remove" />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------

type Verify = { state: "ok" } | { state: "mismatch" } | null;

export function SecurityTab({ name }: { name: string }) {
  const toast = useToast();

  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [identityErr, setIdentityErr] = useState<string | null>(null);
  const [doc, setDoc] = useState<AgentPolicyDocument | null>(null);
  const [policyErr, setPolicyErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [audit, setAudit] = useState<AgentAuditEvent[]>([]);
  const [chainValid, setChainValid] = useState<boolean | null>(null);
  const [auditErr, setAuditErr] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(true);
  const [eventFilter, setEventFilter] = useState("");

  const [dialog, setDialog] = useState<"rotate" | "revoke" | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);

  const [proposal, setProposal] = useState<AgentPolicyProposal | null>(null);
  const [proposing, setProposing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [verify, setVerify] = useState<Verify>(null);

  const loadAudit = useCallback(
    async (event: string) => {
      setAuditLoading(true);
      try {
        const r = await api.listAgentAudit(name, { limit: 100, event: event || undefined });
        setAudit(r.events ?? []);
        setChainValid(r.chainValid);
        setAuditErr(null);
      } catch (e) {
        setAuditErr(errMsg(e));
      } finally {
        setAuditLoading(false);
      }
    },
    [name],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const [i, p] = await Promise.allSettled([api.getAgentIdentity(name), api.getAgentPolicy(name)]);
    if (i.status === "fulfilled") {
      setIdentity(i.value);
      setIdentityErr(null);
    } else setIdentityErr(errMsg(i.reason));
    if (p.status === "fulfilled") {
      setDoc({ ...p.value, policy: normalizePolicy(p.value.policy), warnings: p.value.warnings ?? [] });
      setPolicyErr(null);
    } else setPolicyErr(errMsg(p.reason));
    setLoading(false);
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadAudit(eventFilter);
  }, [loadAudit, eventFilter]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed");
    }
  };

  const doRotate = async () => {
    setBusy(true);
    try {
      setIdentity(await api.rotateAgentIdentity(name));
      toast.success("Identity key rotated; tokens from the old generation no longer verify");
      setDialog(null);
      void loadAudit(eventFilter);
    } catch (e) {
      toast.error(`Rotate failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = async () => {
    setBusy(true);
    try {
      setIdentity(await api.revokeAgentIdentity(name, revokeReason.trim()));
      toast.success("Identity revoked");
      setDialog(null);
      setRevokeReason("");
      void loadAudit(eventFilter);
    } catch (e) {
      toast.error(`Revoke failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  /** PUT then re-GET. Returns the read-back doc, or null on handled failure. */
  const putAndReadBack = async (policy: AgentPolicy): Promise<AgentPolicyDocument | null> => {
    if (!doc) return null;
    try {
      await api.putAgentPolicy(name, { ...policy, version: doc.policy.version });
    } catch (e) {
      const pe = parseApiError(e);
      if (pe.status === 409 && pe.code === "version_conflict") {
        toast.warning("The policy changed since you loaded it. Reloaded the latest; please review and retry.");
        setEditing(false);
        setProposal(null);
        await load();
      } else if (pe.status === 400) {
        const msg = pe.field ? `${pe.field}: ${pe.message}` : pe.message;
        setEditErr(msg);
        toast.error(`Invalid policy: ${msg}`);
      } else {
        toast.error(`Save failed: ${pe.message}`);
      }
      return null;
    }
    try {
      const fresh = await api.getAgentPolicy(name);
      const next = { ...fresh, policy: normalizePolicy(fresh.policy), warnings: fresh.warnings ?? [] };
      setDoc(next);
      void loadAudit(eventFilter);
      return next;
    } catch (e) {
      toast.error(`Saved, but the read-back failed: ${errMsg(e)}`);
      return null;
    }
  };

  const startEdit = () => {
    if (!doc) return;
    setDraft(toDraft(doc.policy));
    setEditErr(null);
    setEditing(true);
    setVerify(null);
  };

  const saveEdit = async () => {
    if (!doc || !draft) return;
    const r = fromDraft(draft, doc.policy.version);
    if (!r.ok) {
      setEditErr(r.error);
      return;
    }
    setSaving(true);
    setEditErr(null);
    const fresh = await putAndReadBack(r.policy);
    setSaving(false);
    if (fresh) {
      setEditing(false);
      if (policiesEqual(fresh.policy, r.policy)) toast.success("Policy saved");
      else toast.warning("Saved, but the read-back differs from what you submitted");
    }
  };

  const propose = async () => {
    setProposing(true);
    setVerify(null);
    try {
      const p = await api.proposeAgentPolicy(name);
      setProposal({
        ...p,
        proposal: normalizePolicy(p.proposal),
        rationale: p.rationale ?? [],
        sources: p.sources ?? [],
        unresolved: p.unresolved ?? [],
      });
    } catch (e) {
      toast.error(`Could not propose a policy: ${errMsg(e)}`);
    } finally {
      setProposing(false);
    }
  };

  const applyProposal = async () => {
    if (!proposal) return;
    setApplying(true);
    const fresh = await putAndReadBack(proposal.proposal);
    setApplying(false);
    if (fresh) {
      const ok = policiesEqual(fresh.policy, proposal.proposal);
      setVerify(ok ? { state: "ok" } : { state: "mismatch" });
      setProposal(null);
    }
  };

  // ---- render --------------------------------------------------------------

  const policy = doc?.policy;
  const isLegacy = policy?.mode === "legacy_permissive";
  const isEmptyEnforce =
    policy?.mode === "enforce" &&
    policy.tools.length === 0 &&
    Object.keys(policy.connectors).length === 0 &&
    policy.mcpServers.length === 0 &&
    policy.egressHosts.length === 0 &&
    policy.a2aTargets.length === 0 &&
    policy.secrets.length === 0;

  return (
    <div className="mx-auto w-full max-w-5xl min-w-0 space-y-6">
      {/* Identity ------------------------------------------------------- */}
      <Card
        title="Identity"
        action={
          identity && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setDialog("rotate")}>
                Rotate key
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={<ShieldOff className="h-3.5 w-3.5" />}
                disabled={identity.status === "revoked"}
                onClick={() => setDialog("revoke")}
              >
                Revoke
              </Button>
            </div>
          )
        }
      >
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : identityErr || !identity ? (
          <p className="text-xs text-red-300" role="alert">
            Could not load identity: {identityErr ?? "unknown error"}
          </p>
        ) : (
          <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
            <div className="min-w-0 sm:col-span-2">
              <dt className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">SPIFFE ID</dt>
              <dd className="flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-zinc-200">
                  {identity.spiffeId}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Copy SPIFFE ID"
                  icon={<Copy className="h-3.5 w-3.5" />}
                  onClick={() => void copy(identity.spiffeId)}
                >
                  Copy
                </Button>
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Status</dt>
              <dd className="flex items-center gap-2">
                <StatusBadge status={identity.status} />
                {identity.status === "revoked" && identity.revokedReason && (
                  <span className="min-w-0 break-words text-zinc-500">{identity.revokedReason}</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Key generation</dt>
              <dd className="tabular-nums text-zinc-200">{identity.keyGeneration}</dd>
            </div>
            <div>
              <dt className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Token TTL</dt>
              <dd className="tabular-nums text-zinc-200">{identity.tokenTtlSeconds}s</dd>
            </div>
            <div>
              <dt className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Created</dt>
              <dd className="text-zinc-300">{fmtTime(identity.createdAt)}</dd>
            </div>
            <div>
              <dt className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Last rotated</dt>
              <dd className="text-zinc-300">{fmtTime(identity.rotatedAt)}</dd>
            </div>
            <div>
              <dt className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Revoked</dt>
              <dd className="text-zinc-300">{fmtTime(identity.revokedAt)}</dd>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <dt className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Public keys (JWKS)</dt>
              <dd>
                <a
                  href={identity.jwksUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1 break-all text-pal-300 hover:underline"
                >
                  {identity.jwksUri} <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </dd>
            </div>
          </dl>
        )}
      </Card>

      {/* Policy --------------------------------------------------------- */}
      <Card
        title="Policy"
        action={
          doc &&
          !editing && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                icon={<Sparkles className="h-3.5 w-3.5" />}
                loading={proposing}
                onClick={() => void propose()}
              >
                Propose least-privilege policy
              </Button>
              <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={startEdit}>
                Edit
              </Button>
            </div>
          )
        }
      >
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : policyErr || !doc || !policy ? (
          <p className="text-xs text-red-300" role="alert">
            Could not load policy: {policyErr ?? "unknown error"}
          </p>
        ) : (
          <div className="space-y-4">
            {isLegacy && (
              <Banner tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
                <p>
                  <b>Legacy permissive.</b> This agent predates per-agent policy and can use every tool/connector
                  installed in the workspace. Every call is still audited.
                </p>
                {!editing && (
                  <Button size="sm" loading={proposing} onClick={() => void propose()}>
                    Propose least-privilege policy
                  </Button>
                )}
              </Banner>
            )}
            {isEmptyEnforce && (
              <Banner tone="info" icon={<Info className="h-4 w-4" />}>
                <p>Default-deny: this agent cannot call any tool yet.</p>
              </Banner>
            )}
            {doc.warnings.map((w) => (
              <Banner key={w} tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
                <p>{w}</p>
              </Banner>
            ))}
            {verify?.state === "ok" && (
              <Banner tone="ok" icon={<CheckCircle2 className="h-4 w-4" />}>
                <p>
                  <b>Verified:</b> read-back matches the policy you confirmed.
                </p>
              </Banner>
            )}
            {verify?.state === "mismatch" && (
              <Banner tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
                <p>
                  <b>Not verified:</b> the stored policy differs from what you applied. Review it below.
                </p>
              </Banner>
            )}

            {editing && draft ? (
              <div className="space-y-4">
                <PolicyEditor draft={draft} onChange={setDraft} />
                {editErr && (
                  <p className="text-xs text-red-300" role="alert">
                    {editErr}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" loading={saving} onClick={() => void saveEdit()}>
                    Save policy
                  </Button>
                  <Button variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
                  <span>
                    Mode:{" "}
                    <b className={isLegacy ? "text-amber-300" : "text-zinc-300"}>{policy.mode}</b>
                  </span>
                  <span>Version {policy.version}</span>
                  <span>
                    Updated {fmtTime(doc.updatedAt)}
                    {doc.updatedBy ? ` by ${doc.updatedBy}` : ""}
                  </span>
                </div>
                <PolicyView policy={policy} />
                <p className="text-[11px] text-zinc-600">
                  Cost ceilings live in{" "}
                  <Link href="/budgets" className="text-pal-300 hover:underline">
                    Budgets
                  </Link>
                  .
                </p>
              </>
            )}

            {proposal && policy && (
              <div className="space-y-4 rounded-lg border border-pal-500/30 bg-surface-2 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                  <Sparkles className="h-4 w-4 text-pal-300" /> Proposed policy
                </div>
                <p className="text-[11px] text-zinc-500">
                  Nothing is saved until you apply it. Changes versus the current policy:
                </p>
                <DiffView current={policy} next={proposal.proposal} />
                {proposal.rationale.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Why</div>
                    <ul className="space-y-1 text-xs text-zinc-300">
                      {proposal.rationale.map((r, i) => (
                        <li key={`${r.field}-${i}`} className="break-words">
                          <code className="font-mono text-[11px] text-zinc-400">{r.field}</code> — {r.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {proposal.unresolved.length > 0 && (
                  <Banner tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
                    <p>Could not resolve (review manually):</p>
                    <ChipList items={proposal.unresolved} />
                  </Banner>
                )}
                {proposal.sources.length > 0 && (
                  <p className="break-words text-[11px] text-zinc-600">Derived from: {proposal.sources.join(", ")}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" loading={applying} onClick={() => void applyProposal()}>
                    Apply policy
                  </Button>
                  <Button variant="ghost" disabled={applying} onClick={() => setProposal(null)}>
                    Discard
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Audit ---------------------------------------------------------- */}
      <Card
        title="Audit log"
        action={
          <div className="flex flex-wrap items-center gap-2">
            {chainValid !== null && (
              <span
                className={clsx(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  chainValid
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-red-500/30 bg-red-500/10 text-red-300",
                )}
                title="Recomputed hash chain over the append-only audit log"
              >
                {chainValid ? <ShieldCheck className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                {chainValid ? "Chain intact" : "Chain broken — possible tampering"}
              </span>
            )}
            <select
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              aria-label="Filter by event"
              className="rounded-lg border border-zinc-800 bg-surface-0 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-pal-500/50"
            >
              <option value="">All events</option>
              {AUDIT_EVENTS.map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {auditLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : auditErr ? (
          <p className="text-xs text-red-300" role="alert">
            Could not load audit log: {auditErr}
          </p>
        ) : audit.length === 0 ? (
          <EmptyState
            size="compact"
            icon={KeyRound}
            title="No audit events"
            description={eventFilter ? "No events match this filter." : "Identity and policy decisions will appear here."}
          />
        ) : (
          <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="px-2 py-2 font-medium">Time</th>
                  <th className="px-2 py-2 font-medium">Event</th>
                  <th className="px-2 py-2 font-medium">Kind</th>
                  <th className="px-2 py-2 font-medium">Target</th>
                  <th className="px-2 py-2 font-medium">Decision</th>
                  <th className="px-2 py-2 font-medium">Reason</th>
                  <th className="px-2 py-2 font-medium">Run</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((ev) => (
                  <tr key={ev.id} className="border-b border-zinc-800/60 align-top">
                    <td className="whitespace-nowrap px-2 py-2 text-zinc-400">{fmtTime(ev.createdAt)}</td>
                    <td className="px-2 py-2 font-mono text-[11px] text-zinc-200">{ev.event}</td>
                    <td className="px-2 py-2 text-zinc-300">{ev.actionKind || "—"}</td>
                    <td className="max-w-[16rem] break-all px-2 py-2 font-mono text-[11px] text-zinc-300">
                      {ev.target || "—"}
                    </td>
                    <td className="px-2 py-2">
                      <DecisionBadge decision={ev.decision} />
                    </td>
                    <td className="max-w-[18rem] break-words px-2 py-2 text-zinc-400">{ev.reason || "—"}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      {ev.runId ? (
                        <Link href={`/runs/${encodeURIComponent(ev.runId)}`} className="text-pal-300 hover:underline">
                          {ev.runId.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Dialogs -------------------------------------------------------- */}
      <Modal
        open={dialog === "rotate"}
        onClose={() => !busy && setDialog(null)}
        title="Rotate identity key?"
        description="A new signing key is generated. Every token issued under the current key stops verifying immediately."
        size="sm"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void doRotate()}>
              Rotate
            </Button>
          </>
        }
      >
        <p className="text-xs text-zinc-400">In-flight runs re-mint their token automatically.</p>
      </Modal>

      <Modal
        open={dialog === "revoke"}
        onClose={() => !busy && setDialog(null)}
        title="Revoke identity?"
        description="A revoked agent cannot mint or present tokens, and its runs fail until the identity is rotated back to life."
        size="sm"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} disabled={!revokeReason.trim()} onClick={() => void doRevoke()}>
              Revoke identity
            </Button>
          </>
        }
      >
        <ModalField label="Reason (recorded in the audit log)">
          <input
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            placeholder="e.g. suspected prompt injection"
            className={inputCls}
            maxLength={500}
          />
        </ModalField>
      </Modal>
    </div>
  );
}
