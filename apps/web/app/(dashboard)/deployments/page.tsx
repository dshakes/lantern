"use client";

// Data Plane Command Center — "where your agents run".
//
// The control-plane/data-plane split is Lantern's core story: the control
// plane orchestrates, but agent workloads execute inside the customer's own
// Kubernetes clusters (EKS/GKE/AKS) in their VPC. This page is the fleet view
// of those data planes — health, heartbeat freshness, the outbound mTLS
// tunnel, capacity, and which agent versions are deployed where.
//
// Backed by /v1/data-planes + /v1/deployments. When NO planes are registered
// (empty) OR the API is unreachable (offline) we fall back to a clearly-
// labeled DEMO data-plane set (lib/dataplane-demo.ts) so the command center
// always reads populated — mirroring the Runtime cockpit convention.
//
// HONESTY GUARD: real planes are NEVER decorated with demo telemetry. The
// live DataPlane API exposes only { cloud, region, status, agentCount,
// lastHeartbeat }; the richer fields (tunnel health, capacity, workload
// counts, capacity sparkline) are demo-only. For a REAL plane those render
// real values where the API has them, and "—" otherwise — never fabricated.

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Cloud,
  Server,
  Plus,
  Copy,
  Terminal,
  Trash2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Network,
  Boxes,
  Layers,
  Globe2,
  RefreshCw,
} from "lucide-react";
import clsx from "clsx";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { PageSkeleton } from "@/components/skeleton";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/button";
import { Modal, ModalField } from "@/components/modal";
import { StateDot, StatePill, Sparkline, UtilBar } from "../runtime/cockpit-ui";
import type { VmState } from "@/lib/runtime-types";
import {
  DEMO_DATA_PLANES,
  DEMO_DEPLOYMENTS,
  type DemoDataPlane,
  type DemoDeployment,
} from "@/lib/dataplane-demo";

// ---------------------------------------------------------------------------
// Unified row model
//
// `PlaneRow` carries the union of real + demo fields. `demo` flags the source
// so the honesty guard can blank demo-only telemetry for real planes. Optional
// fields are `null` when the source can't supply them — rendered as "—".
// ---------------------------------------------------------------------------

interface PlaneRow {
  id: string;
  name: string;
  cloud: string;
  region: string;
  clusterName: string | null;
  status: string; // healthy | degraded | offline | provisioning
  demo: boolean;
  // Demo-only telemetry (null for real planes).
  tunnel: "up" | "down" | null;
  workloadCount: number | null;
  nodes: number | null;
  vcpuUsed: number | null;
  vcpuTotal: number | null;
  memUsedGib: number | null;
  memTotalGib: number | null;
  capacityHistory: number[] | null;
  // Available from both sources.
  agentCount: number;
  heartbeatAgoSec: number | null;
  version: string | null;
}

interface DeploymentRow {
  id: string;
  agentName: string;
  version: string;
  environment: string;
  status: string;
  deployedAgoSec: number | null;
  planeId: string | null;
}

// ---------------------------------------------------------------------------
// Cloud onboarding snippets (kept from the original page)
// ---------------------------------------------------------------------------

interface CloudSetup {
  name: string;
  cloud: string;
  icon: string;
  color: string;
  bgColor: string;
  blurb: string;
  steps: string[];
}

const cloudSetups: CloudSetup[] = [
  {
    name: "AWS", cloud: "aws", icon: "AWS", color: "text-orange-400", bgColor: "bg-orange-500/10",
    blurb: "Amazon EKS with Firecracker support",
    steps: [
      "# Install the Lantern data plane on AWS EKS",
      "terraform init",
      'terraform apply -var="cloud=aws" \\',
      '  -var="region=us-east-1" \\',
      '  -var="cluster_name=lantern-dp"',
      "",
      "# Install the Helm chart",
      "helm install lantern-data-plane lantern/data-plane \\",
      "  --set controlPlane.endpoint=api.lantern.run \\",
      "  --set controlPlane.token=<your-registration-token>",
    ],
  },
  {
    name: "GCP", cloud: "gcp", icon: "GCP", color: "text-blue-400", bgColor: "bg-blue-500/10",
    blurb: "Google GKE with nested virtualization",
    steps: [
      "# Install the Lantern data plane on GKE",
      "terraform init",
      'terraform apply -var="cloud=gcp" \\',
      '  -var="region=us-central1" \\',
      '  -var="cluster_name=lantern-dp"',
      "",
      "# Install the Helm chart",
      "helm install lantern-data-plane lantern/data-plane \\",
      "  --set controlPlane.endpoint=api.lantern.run \\",
      "  --set controlPlane.token=<your-registration-token>",
    ],
  },
  {
    name: "Azure", cloud: "azure", icon: "AZ", color: "text-sky-400", bgColor: "bg-sky-500/10",
    blurb: "Azure AKS with dedicated hosts",
    steps: [
      "# Install the Lantern data plane on AKS",
      "terraform init",
      'terraform apply -var="cloud=azure" \\',
      '  -var="region=eastus2" \\',
      '  -var="cluster_name=lantern-dp"',
      "",
      "# Install the Helm chart",
      "helm install lantern-data-plane lantern/data-plane \\",
      "  --set controlPlane.endpoint=api.lantern.run \\",
      "  --set controlPlane.token=<your-registration-token>",
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Map a data-plane status onto the cockpit VmState vocabulary so we reuse
// StateDot / StatePill verbatim (healthy→running, degraded→draining, etc.).
function planeVmState(status: string): VmState {
  switch (status) {
    case "healthy": return "running";
    case "degraded": return "draining";
    case "offline": return "failed";
    case "provisioning": return "spawning";
    default: return "pending";
  }
}

const CLOUD_STYLES: Record<string, { label: string; cls: string }> = {
  aws: { label: "AWS", cls: "bg-orange-500/10 text-orange-300 ring-orange-500/20" },
  gcp: { label: "GCP", cls: "bg-blue-500/10 text-blue-300 ring-blue-500/20" },
  azure: { label: "Azure", cls: "bg-sky-500/10 text-sky-300 ring-sky-500/20" },
};

function CloudBadge({ cloud, dense }: { cloud: string; dense?: boolean }) {
  const s = CLOUD_STYLES[cloud.toLowerCase()] ?? { label: cloud, cls: "bg-zinc-500/10 text-zinc-300 ring-zinc-500/20" };
  return (
    <span className={clsx(
      "inline-flex items-center rounded font-mono font-medium uppercase ring-1 ring-inset",
      dense ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]",
      s.cls,
    )}>
      {s.label}
    </span>
  );
}

function EnvBadge({ env }: { env: string }) {
  const colors: Record<string, string> = {
    development: "bg-zinc-500/10 text-zinc-400",
    staging: "bg-amber-500/10 text-amber-300",
    production: "bg-emerald-500/10 text-emerald-300",
  };
  return (
    <span className={clsx("rounded-md px-2 py-0.5 text-[11px] font-medium capitalize", colors[env] ?? "bg-zinc-500/10 text-zinc-400")}>
      {env}
    </span>
  );
}

// Color-coded heartbeat freshness. null → "—".
function Heartbeat({ ago, offline }: { ago: number | null; offline?: boolean }) {
  if (ago === null) return <span className="font-mono text-[11px] text-zinc-600">—</span>;
  const tone = offline || ago > 120 ? "text-red-400" : ago > 30 ? "text-amber-400" : "text-emerald-400";
  let label: string;
  if (ago < 60) label = `${ago}s ago`;
  else if (ago < 3600) label = `${Math.floor(ago / 60)}m ago`;
  else if (ago < 86400) label = `${Math.floor(ago / 3600)}h ago`;
  else label = `${Math.floor(ago / 86400)}d ago`;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx("h-1.5 w-1.5 rounded-full", offline || ago > 120 ? "bg-red-400" : ago > 30 ? "bg-amber-400" : "bg-emerald-400 animate-pulse")} />
      <span className={clsx("font-mono text-[11px] tabular-nums", tone)}>{label}</span>
    </span>
  );
}

function TunnelBadge({ tunnel }: { tunnel: "up" | "down" | null }) {
  if (tunnel === null) return <span className="font-mono text-[11px] text-zinc-600">—</span>;
  const up = tunnel === "up";
  return (
    <span className={clsx(
      "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
      up ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20" : "bg-red-500/10 text-red-300 ring-red-500/20",
    )} title="Outbound control → data-plane mTLS tunnel">
      <Network className="h-2.5 w-2.5" />
      mTLS {up ? "up" : "down"}
    </span>
  );
}

function timeAgoSec(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function capTone(u: number): "ok" | "accent" | "warn" | "danger" {
  if (u >= 0.85) return "danger";
  if (u >= 0.65) return "warn";
  if (u >= 0.3) return "accent";
  return "ok";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DeploymentsPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [planes, setPlanes] = useState<PlaneRow[]>([]);
  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [usingDemo, setUsingDemo] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());
  const [refreshing, setRefreshing] = useState(false);

  // Disclosure state
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showOnboard, setShowOnboard] = useState(false);
  const [selectedCloud, setSelectedCloud] = useState<CloudSetup | null>(null);

  // Modals
  const [showAddPlane, setShowAddPlane] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", cloud: "aws", region: "us-east-1" });
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PlaneRow | null>(null);
  const [removing, setRemoving] = useState(false);

  const loadData = useCallback(async () => {
    let realPlanes: PlaneRow[] = [];
    let realDeps: DeploymentRow[] = [];
    let planesErrored = false;

    try {
      const dp = await api.listDataPlanes();
      realPlanes = (dp ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        cloud: p.cloud,
        region: p.region,
        clusterName: p.clusterName ?? null,
        status: p.status,
        demo: false,
        // Real API doesn't expose these yet — honest "—".
        tunnel: null,
        workloadCount: null,
        nodes: null,
        vcpuUsed: null,
        vcpuTotal: null,
        memUsedGib: null,
        memTotalGib: null,
        capacityHistory: null,
        agentCount: p.agentCount,
        heartbeatAgoSec: p.lastHeartbeat
          ? Math.max(0, Math.floor((Date.now() - new Date(p.lastHeartbeat).getTime()) / 1000))
          : null,
        version: null,
      }));
    } catch {
      planesErrored = true;
    }

    try {
      const deps = await api.listDeployments();
      realDeps = (deps ?? []).map((d) => ({
        id: d.id,
        agentName: d.agentName,
        version: d.version,
        environment: d.environment,
        status: d.status,
        deployedAgoSec: d.createdAt
          ? Math.max(0, Math.floor((Date.now() - new Date(d.createdAt).getTime()) / 1000))
          : null,
        planeId: null,
      }));
    } catch { /* deployments optional */ }

    if (realPlanes.length === 0) {
      // No registered planes (or API down) → demo fleet behind a badge.
      setPlanes(DEMO_DATA_PLANES.map(demoToRow));
      setDeployments(DEMO_DEPLOYMENTS.map(demoDepToRow));
      setUsingDemo(true);
    } else {
      setPlanes(realPlanes);
      // Real deployments if present; otherwise leave empty (don't fabricate).
      setDeployments(realDeps);
      setUsingDemo(false);
    }
    void planesErrored; // demo fallback already covers the error path

    setLoading(false);
    setLastUpdated(Date.now());
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleAddDataPlane = async () => {
    if (!addForm.name.trim()) { toast.error("Data plane name is required"); return; }
    setAdding(true);
    try {
      await api.registerDataPlane({ name: addForm.name, cloud: addForm.cloud, region: addForm.region });
      toast.success(`Data plane "${addForm.name}" registered`);
      setShowAddPlane(false);
      setAddForm({ name: "", cloud: "aws", region: "us-east-1" });
      loadData();
    } catch (e) {
      if (usingDemo) {
        // Genuine demo mode (no API / no real planes) — the register is a no-op
        // we surface as success so the demo command center stays coherent.
        toast.success(`Data plane "${addForm.name}" registered (demo mode)`);
        setShowAddPlane(false);
        setAddForm({ name: "", cloud: "aws", region: "us-east-1" });
        loadData();
      } else {
        // Real registration that actually failed — do NOT claim success.
        // Keep the modal open so the user can retry.
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`Failed to register data plane — ${msg}`);
      }
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveDataPlane = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    if (removeTarget.demo) {
      toast.success(`"${removeTarget.name}" removed (demo)`);
      setRemoving(false);
      setRemoveTarget(null);
      loadData();
      return;
    }
    try {
      await api.removeDataPlane(removeTarget.id);
      toast.success(`Data plane "${removeTarget.name}" removed`);
      setRemoveTarget(null);
      loadData();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to remove "${removeTarget.name}" — ${msg}`);
    } finally {
      setRemoving(false);
    }
  };

  const stats = useMemo(() => {
    const healthy = planes.filter((p) => p.status === "healthy").length;
    const degraded = planes.filter((p) => p.status === "degraded").length;
    const offline = planes.filter((p) => p.status === "offline").length;
    const clouds = new Set(planes.map((p) => p.cloud.toLowerCase())).size;
    const regions = new Set(planes.map((p) => p.region)).size;
    // Capacity is demo-only; sum across planes that report it.
    const vcpuTotal = planes.reduce((s, p) => s + (p.vcpuTotal ?? 0), 0);
    const workloads = planes.reduce((s, p) => s + (p.workloadCount ?? 0), 0);
    const agents = planes.reduce((s, p) => s + p.agentCount, 0);
    return { total: planes.length, healthy, degraded, offline, clouds, regions, vcpuTotal, workloads, agents };
  }, [planes]);

  if (loading) return <PageSkeleton />;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Data Plane Command Center"
        description="Where your agents run — customer-cloud Kubernetes data planes (EKS/GKE/AKS). Prompts and customer data never leave your VPC; the control plane orchestrates over an outbound mTLS tunnel."
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw className={clsx("h-3.5 w-3.5", refreshing && "animate-spin")} />}
              onClick={async () => { setRefreshing(true); await loadData(); setRefreshing(false); }}
            >
              Refresh
            </Button>
            <Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowAddPlane(true)}>
              Connect data plane
            </Button>
          </div>
        }
      />

      <CommandStrip stats={stats} usingDemo={usingDemo} lastUpdated={lastUpdated} />

      <div className="space-y-8 p-6 md:p-8">
        {/* PRIMARY: data-plane fleet + region map */}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_360px]">
          {/* Fleet (centerpiece) */}
          <section className="min-w-0">
            <h2 className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              <Server className="h-3.5 w-3.5" /> Data plane fleet
            </h2>
            <div className="space-y-2.5">
              {planes.map((p) => (
                <PlaneCard
                  key={p.id}
                  plane={p}
                  open={expanded.has(p.id)}
                  onToggle={() => toggle(p.id)}
                  deployments={deployments.filter((d) => d.planeId === p.id)}
                  onRemove={() => setRemoveTarget(p)}
                />
              ))}
            </div>
          </section>

          {/* Region / cloud map */}
          <div className="space-y-6">
            <RegionMap planes={planes} />
          </div>
        </div>

        {/* SECONDARY: deployments */}
        <DeploymentsSection deployments={deployments} planes={planes} />

        {/* SECONDARY (progressive disclosure): onboard a data plane */}
        <section>
          <button
            onClick={() => setShowOnboard((v) => !v)}
            className="flex w-full items-center justify-between rounded-xl border border-zinc-800 bg-surface-1 px-5 py-4 text-left transition-colors hover:border-zinc-700"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-lantern-500/10">
                <Cloud className="h-5 w-5 text-lantern-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Connect a data plane</h3>
                <p className="text-xs text-zinc-500">Terraform + Helm onboarding for EKS / GKE / AKS — agents run in your VPC.</p>
              </div>
            </div>
            {showOnboard ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
          </button>

          {showOnboard && (
            <div className="mt-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {cloudSetups.map((setup) => (
                  <button
                    key={setup.cloud}
                    onClick={() => setSelectedCloud(selectedCloud?.cloud === setup.cloud ? null : setup)}
                    className={clsx(
                      "rounded-xl border p-4 text-left transition-all",
                      selectedCloud?.cloud === setup.cloud ? "border-lantern-500 bg-lantern-500/5" : "border-zinc-800 bg-surface-1 hover:border-zinc-700",
                    )}
                  >
                    <div className={clsx("flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold", setup.bgColor, setup.color)}>
                      {setup.icon}
                    </div>
                    <h4 className="mt-2.5 text-sm font-semibold text-zinc-100">Connect {setup.name}</h4>
                    <p className="mt-0.5 text-xs text-zinc-500">{setup.blurb}</p>
                  </button>
                ))}
              </div>

              {selectedCloud && (
                <div className="mt-4 rounded-xl border border-zinc-800 bg-surface-1 p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Terminal className="h-4 w-4 text-zinc-400" />
                      <h4 className="text-sm font-semibold text-zinc-100">{selectedCloud.name} installation</h4>
                    </div>
                    <button
                      onClick={() => { navigator.clipboard.writeText(selectedCloud.steps.join("\n")); toast.success("Commands copied"); }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:bg-surface-3 hover:text-zinc-200"
                    >
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                  </div>
                  <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-surface-0 p-4 font-mono text-xs leading-relaxed text-zinc-400">
                    {selectedCloud.steps.join("\n")}
                  </pre>
                  <div className="mt-4 flex items-center gap-3">
                    <Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowAddPlane(true)}>
                      Register data plane
                    </Button>
                    <p className="text-xs text-zinc-500">After the install completes, register your data plane here.</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Add Data Plane Modal */}
      <Modal
        open={showAddPlane}
        onClose={() => setShowAddPlane(false)}
        title="Register data plane"
        size="sm"
        footer={
          <>
            <button onClick={() => setShowAddPlane(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200">Cancel</button>
            <Button variant="primary" size="sm" loading={adding} icon={<Plus className="h-3.5 w-3.5" />} onClick={handleAddDataPlane}>
              {adding ? "Registering…" : "Register"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <ModalField label="Name *">
            <input type="text" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="lantern-dp-production"
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30" />
          </ModalField>
          <ModalField label="Cloud">
            <select value={addForm.cloud} onChange={(e) => setAddForm({ ...addForm, cloud: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30">
              <option value="aws">AWS</option>
              <option value="gcp">GCP</option>
              <option value="azure">Azure</option>
              <option value="self-hosted">Self-hosted</option>
            </select>
          </ModalField>
          <ModalField label="Region">
            <input type="text" value={addForm.region} onChange={(e) => setAddForm({ ...addForm, region: e.target.value })} placeholder="us-east-1"
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30" />
          </ModalField>
        </div>
      </Modal>

      {/* Remove Confirmation Modal */}
      <Modal
        open={removeTarget !== null}
        onClose={() => { if (!removing) setRemoveTarget(null); }}
        title={removeTarget ? `Remove "${removeTarget.name}"?` : "Remove data plane?"}
        size="sm"
        footer={
          <>
            <button onClick={() => setRemoveTarget(null)} disabled={removing} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-50">Cancel</button>
            <Button variant="danger" size="sm" loading={removing} onClick={handleRemoveDataPlane}>
              {removing ? "Removing…" : "Remove"}
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
          <p className="text-sm text-zinc-400">
            This disconnects the data plane from the control plane. Any agents deployed on it become unreachable. This cannot be undone.
          </p>
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo → row adapters
// ---------------------------------------------------------------------------

function demoToRow(p: DemoDataPlane): PlaneRow {
  return {
    id: p.id,
    name: p.name,
    cloud: p.cloud,
    region: p.region,
    clusterName: p.clusterName,
    status: p.status,
    demo: true,
    tunnel: p.tunnel,
    workloadCount: p.workloadCount,
    nodes: p.nodes,
    vcpuUsed: p.vcpuUsed,
    vcpuTotal: p.vcpuTotal,
    memUsedGib: p.memUsedGib,
    memTotalGib: p.memTotalGib,
    capacityHistory: p.capacityHistory,
    agentCount: p.agentCount,
    heartbeatAgoSec: p.heartbeatAgoSec,
    version: p.version,
  };
}

function demoDepToRow(d: DemoDeployment): DeploymentRow {
  return {
    id: d.id,
    agentName: d.agentName,
    version: d.version,
    environment: d.environment,
    status: d.status,
    deployedAgoSec: d.deployedAgoSec,
    planeId: d.planeId,
  };
}

// ---------------------------------------------------------------------------
// Command strip
// ---------------------------------------------------------------------------

function CommandStrip({
  stats,
  usingDemo,
  lastUpdated,
}: {
  stats: { total: number; healthy: number; degraded: number; offline: number; clouds: number; regions: number; vcpuTotal: number; workloads: number; agents: number };
  usingDemo: boolean;
  lastUpdated: number;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const agoS = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000));

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-zinc-800 bg-surface-0 px-6 py-3 md:px-8">
      <div className="flex items-center gap-2">
        <span className="relative inline-flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-widest text-emerald-300">Live</span>
      </div>

      <Metric icon={<Boxes className="h-3.5 w-3.5" />} label="Data planes" value={stats.total} />
      <Metric icon={<span className="h-2 w-2 rounded-full bg-emerald-400" />} label="Healthy" value={stats.healthy} tone="emerald" />
      <Metric icon={<span className="h-2 w-2 rounded-full bg-amber-400" />} label="Degraded" value={stats.degraded} tone="amber" />
      <Metric icon={<span className="h-2 w-2 rounded-full bg-red-400" />} label="Offline" value={stats.offline} tone="red" />
      <Metric icon={<Cloud className="h-3.5 w-3.5 text-sky-400" />} label="Clouds" value={stats.clouds} tone="sky" />
      <Metric icon={<Globe2 className="h-3.5 w-3.5 text-lantern-400" />} label="Regions" value={stats.regions} tone="lantern" />
      <Metric icon={<Layers className="h-3.5 w-3.5" />} label="Workloads" value={stats.workloads} />
      <Metric icon={<Server className="h-3.5 w-3.5" />} label="Agents" value={stats.agents} />

      <div className="ml-auto flex items-center gap-3 text-[11px] text-zinc-500">
        {usingDemo && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20">
            <AlertTriangle className="h-3 w-3" />
            Demo data planes — none registered
          </span>
        )}
        <span className="tabular-nums">updated {agoS}s ago</span>
      </div>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  tone = "zinc",
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "zinc" | "emerald" | "amber" | "red" | "sky" | "lantern";
}) {
  const valueTone: Record<string, string> = {
    zinc: "text-zinc-100",
    emerald: "text-emerald-300",
    amber: value > 0 ? "text-amber-300" : "text-zinc-100",
    red: value > 0 ? "text-red-300" : "text-zinc-100",
    sky: "text-sky-300",
    lantern: "text-lantern-300",
  };
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
      <span className={clsx("font-mono text-[14px] font-semibold tabular-nums", valueTone[tone])}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plane card (centerpiece, expandable)
// ---------------------------------------------------------------------------

function PlaneCard({
  plane,
  open,
  onToggle,
  deployments,
  onRemove,
}: {
  plane: PlaneRow;
  open: boolean;
  onToggle: () => void;
  deployments: DeploymentRow[];
  onRemove: () => void;
}) {
  const offline = plane.status === "offline";
  const cpuUtil = plane.vcpuTotal && plane.vcpuTotal > 0 ? (plane.vcpuUsed ?? 0) / plane.vcpuTotal : null;
  const memUtil = plane.memTotalGib && plane.memTotalGib > 0 ? (plane.memUsedGib ?? 0) / plane.memTotalGib : null;

  return (
    <div className={clsx(
      "overflow-hidden rounded-xl border bg-surface-1 transition-colors",
      open ? "border-zinc-700" : "border-zinc-800 hover:border-zinc-700",
      offline && "border-red-500/20",
    )}>
      {/* Summary row */}
      <button onClick={onToggle} className="flex w-full items-center gap-4 px-4 py-3.5 text-left">
        <span className="text-zinc-600">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>

        <div className="flex min-w-0 flex-1 items-center gap-3">
          <CloudBadge cloud={plane.cloud} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-zinc-100">{plane.name}</span>
              <StatePill state={planeVmState(plane.status)} />
            </div>
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-zinc-500">
              <span>{plane.region}</span>
              {plane.clusterName && <><span className="text-zinc-700">·</span><span className="truncate">{plane.clusterName}</span></>}
            </div>
          </div>
        </div>

        {/* Telemetry cluster (hidden on small screens; expand to see all) */}
        <div className="hidden items-center gap-5 lg:flex">
          <TunnelBadge tunnel={plane.tunnel} />
          <div className="w-24">
            <Heartbeat ago={plane.heartbeatAgoSec} offline={offline} />
          </div>
          <div className="w-28">
            {cpuUtil !== null ? (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-zinc-600">vCPU</span>
                <div className="flex-1"><UtilBar value={cpuUtil} tone={capTone(cpuUtil)} /></div>
              </div>
            ) : (
              <span className="font-mono text-[11px] text-zinc-600">—</span>
            )}
          </div>
          <div className="flex w-20 items-center gap-1.5 text-[11px] text-zinc-400">
            <Layers className="h-3 w-3 text-zinc-600" />
            <span className="font-mono tabular-nums">{plane.workloadCount ?? "—"}</span>
            <span className="text-zinc-600">wl</span>
          </div>
          <Sparkline data={plane.capacityHistory ?? []} color={offline ? "#f87171" : "var(--color-accent)"} />
        </div>
      </button>

      {/* Expanded detail */}
      {open && (
        <div className="border-t border-zinc-800 bg-surface-0/40 px-4 py-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <Detail label="Region" value={plane.region} mono />
            <Detail label="Cluster" value={plane.clusterName ?? "—"} mono />
            <Detail label="Data-plane version" value={plane.version ?? "—"} mono />
            <Detail label="Nodes" value={plane.nodes != null ? String(plane.nodes) : "—"} mono />
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Tunnel</p>
              <TunnelBadge tunnel={plane.tunnel} />
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Last heartbeat</p>
              <Heartbeat ago={plane.heartbeatAgoSec} offline={offline} />
            </div>
            <Detail label="Agents" value={String(plane.agentCount)} mono />
            <Detail label="Workloads" value={plane.workloadCount != null ? String(plane.workloadCount) : "—"} mono />
          </div>

          {/* Capacity bars */}
          {(cpuUtil !== null || memUtil !== null) && (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {cpuUtil !== null && (
                <CapacityRow
                  label="vCPU"
                  util={cpuUtil}
                  detail={`${plane.vcpuUsed}/${plane.vcpuTotal}`}
                />
              )}
              {memUtil !== null && (
                <CapacityRow
                  label="Memory"
                  util={memUtil}
                  detail={`${plane.memUsedGib}/${plane.memTotalGib} GiB`}
                />
              )}
            </div>
          )}

          {/* Deployments on this plane */}
          <div className="mt-4">
            <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">Deployed here</p>
            {deployments.length === 0 ? (
              <p className="text-xs text-zinc-600">
                {plane.demo ? "No deployments on this plane." : "Deployment-to-plane mapping not reported by the API."}
              </p>
            ) : (
              <div className="space-y-1.5">
                {deployments.map((d) => (
                  <div key={d.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-surface-1 px-3 py-2">
                    <StateDot state={d.status === "live" ? "running" : d.status === "failed" ? "failed" : "spawning"} />
                    <span className="text-xs font-medium text-zinc-200">{d.agentName}</span>
                    <span className="font-mono text-[11px] text-zinc-500">{d.version}</span>
                    <EnvBadge env={d.environment} />
                    <span className="ml-auto text-[11px] text-zinc-600">{timeAgoSec(d.deployedAgoSec)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Plane actions */}
          <div className="mt-4 flex justify-end">
            <button
              onClick={onRemove}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 py-1 text-[11px] text-zinc-500 transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
            >
              <Trash2 className="h-3 w-3" /> Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={clsx("text-sm text-zinc-200", mono && "font-mono text-[12px]")}>{value}</p>
    </div>
  );
}

function CapacityRow({ label, util, detail }: { label: string; util: number; detail: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 font-mono text-[11px] text-zinc-500">{label}</span>
      <div className="flex-1"><UtilBar value={util} tone={capTone(util)} /></div>
      <span className="w-24 text-right font-mono text-[11px] tabular-nums text-zinc-500">{detail}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Region / cloud map — "where agents run" at a glance (grid, not a geo map).
// ---------------------------------------------------------------------------

function RegionMap({ planes }: { planes: PlaneRow[] }) {
  // Group by cloud → region.
  const byCloud = new Map<string, Map<string, PlaneRow[]>>();
  for (const p of planes) {
    const c = p.cloud.toLowerCase();
    if (!byCloud.has(c)) byCloud.set(c, new Map());
    const regions = byCloud.get(c)!;
    const arr = regions.get(p.region) ?? [];
    arr.push(p);
    regions.set(p.region, arr);
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
        <Globe2 className="h-3.5 w-3.5" /> Where agents run
      </div>
      <div className="space-y-4 p-4">
        {[...byCloud.entries()].map(([cloud, regions]) => (
          <div key={cloud}>
            <div className="mb-2 flex items-center gap-2">
              <CloudBadge cloud={cloud} dense />
              <span className="text-[10px] text-zinc-600">
                {regions.size} region{regions.size === 1 ? "" : "s"}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {[...regions.entries()].map(([region, rps]) => {
                const worst = rps.some((p) => p.status === "offline")
                  ? "offline"
                  : rps.some((p) => p.status === "degraded")
                    ? "degraded"
                    : "healthy";
                const workloads = rps.reduce((s, p) => s + (p.workloadCount ?? 0), 0);
                const agents = rps.reduce((s, p) => s + p.agentCount, 0);
                const anyWorkloads = rps.some((p) => p.workloadCount != null);
                return (
                  <div
                    key={region}
                    className={clsx(
                      "rounded-lg border bg-surface-0 px-3 py-2.5",
                      worst === "offline" ? "border-red-500/20" : worst === "degraded" ? "border-amber-500/25" : "border-zinc-800",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <StateDot state={planeVmState(worst)} />
                        <span className="font-mono text-[11px] text-zinc-200">{region}</span>
                      </div>
                      <span className="font-mono text-[10px] tabular-nums text-zinc-500">
                        {rps.length} plane{rps.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-[10px] text-zinc-500">
                      <span className="inline-flex items-center gap-1">
                        <Layers className="h-2.5 w-2.5" />
                        {anyWorkloads ? `${workloads} workloads` : "—"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Server className="h-2.5 w-2.5" />
                        {agents} agents
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deployments section (compact, secondary)
// ---------------------------------------------------------------------------

function DeploymentsSection({ deployments, planes }: { deployments: DeploymentRow[]; planes: PlaneRow[] }) {
  if (deployments.length === 0) return null;
  const planeName = (id: string | null) => (id ? planes.find((p) => p.id === id)?.name ?? null : null);

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
        <Layers className="h-3.5 w-3.5" /> Deployments
      </h2>
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
        <table className="data-table">
          <thead>
            <tr><th>Agent</th><th>Version</th><th>Environment</th><th>Data plane</th><th>Status</th><th>Deployed</th></tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.id} className="no-click">
                <td><span className="font-medium text-zinc-100">{d.agentName}</span></td>
                <td><span className="font-mono text-xs text-zinc-400">{d.version}</span></td>
                <td><EnvBadge env={d.environment} /></td>
                <td><span className="font-mono text-[11px] text-zinc-400">{planeName(d.planeId) ?? "—"}</span></td>
                <td>
                  <div className="flex items-center gap-1.5">
                    <StateDot state={d.status === "live" ? "running" : d.status === "failed" ? "failed" : "spawning"} />
                    <span className={clsx("text-xs capitalize",
                      d.status === "live" && "text-emerald-400",
                      d.status === "deploying" && "text-lantern-400",
                      d.status === "failed" && "text-red-400",
                    )}>{d.status}</span>
                  </div>
                </td>
                <td><span className="text-xs text-zinc-500">{timeAgoSec(d.deployedAgoSec)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
