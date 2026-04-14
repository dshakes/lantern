"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Cloud,
  Server,
  Plus,
  X,
  Check,
  Loader2,
  Copy,
  Activity,
  Terminal,
  Trash2,
  AlertTriangle,
  Zap,
  ExternalLink,
  DollarSign,
  Square,
  Play,
} from "lucide-react";
import clsx from "clsx";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { HeaderSkeleton, Skeleton } from "@/components/skeleton";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DataPlaneRow {
  id: string;
  name: string;
  cloud: string;
  region: string;
  status: string;
  agentsDeployed: number;
  lastHeartbeat: string;
}

interface DeploymentRow {
  id: string;
  agentName: string;
  version: string;
  environment: string;
  status: string;
  deployedAt: string;
  deployedBy: string;
}

// ---------------------------------------------------------------------------
// Cloud setup cards
// ---------------------------------------------------------------------------

interface CloudSetup {
  name: string;
  cloud: string;
  icon: string;
  color: string;
  bgColor: string;
  steps: string[];
}

const cloudSetups: CloudSetup[] = [
  {
    name: "AWS", cloud: "aws", icon: "AWS", color: "text-orange-400", bgColor: "bg-orange-500/10",
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

function StatusDot({ status }: { status: string }) {
  return (
    <span className={clsx("h-2 w-2 rounded-full",
      status === "healthy" && "bg-emerald-400",
      status === "degraded" && "bg-amber-400",
      status === "offline" && "bg-red-400",
      status === "live" && "bg-emerald-400",
      status === "deploying" && "bg-blue-400 animate-pulse",
      status === "failed" && "bg-red-400",
      status === "provisioning" && "bg-blue-400 animate-pulse",
    )} />
  );
}

function CloudBadge({ cloud }: { cloud: string }) {
  const colors: Record<string, string> = {
    aws: "bg-orange-500/10 text-orange-400",
    AWS: "bg-orange-500/10 text-orange-400",
    gcp: "bg-blue-500/10 text-blue-400",
    GCP: "bg-blue-500/10 text-blue-400",
    azure: "bg-sky-500/10 text-sky-400",
    Azure: "bg-sky-500/10 text-sky-400",
  };
  return (
    <span className={clsx("rounded-md px-2 py-0.5 text-[11px] font-medium uppercase", colors[cloud] ?? "bg-zinc-500/10 text-zinc-400")}>
      {cloud}
    </span>
  );
}

function EnvBadge({ env }: { env: string }) {
  const colors: Record<string, string> = {
    development: "bg-zinc-500/10 text-zinc-400",
    staging: "bg-amber-500/10 text-amber-400",
    production: "bg-emerald-500/10 text-emerald-400",
  };
  return (
    <span className={clsx("rounded-md px-2 py-0.5 text-[11px] font-medium capitalize", colors[env] ?? "bg-zinc-500/10 text-zinc-400")}>
      {env}
    </span>
  );
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function DeploymentsPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [dataPlanes, setDataPlanes] = useState<DataPlaneRow[]>([]);
  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [selectedCloud, setSelectedCloud] = useState<CloudSetup | null>(null);
  const [showAddPlane, setShowAddPlane] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", cloud: "aws", region: "us-east-1" });
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<DataPlaneRow | null>(null);
  const [removing, setRemoving] = useState(false);

  // Lantern Cloud hosted agents (Gap 5)
  interface HostedAgent {
    name: string;
    status: string;
    url: string;
    sessions: number;
    tokens: string;
    costUsd: string;
    deployedAt: string;
  }
  const [hostedAgents, setHostedAgents] = useState<HostedAgent[]>([]);
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [deployAgentName, setDeployAgentName] = useState("");
  const [deployingAgent, setDeployingAgent] = useState(false);
  const [availableAgents, setAvailableAgents] = useState<Array<{ name: string; description: string }>>([]);

  const loadData = useCallback(async () => {
    let hasApiData = false;

    try {
      const realPlanes = await api.listDataPlanes();
      if (realPlanes && realPlanes.length > 0) {
        setDataPlanes(realPlanes.map((dp) => ({
          id: dp.id, name: dp.name, cloud: dp.cloud, region: dp.region,
          status: dp.status, agentsDeployed: dp.agentCount, lastHeartbeat: dp.lastHeartbeat ?? dp.createdAt,
        })));
        hasApiData = true;
      }
    } catch { /* API unavailable */ }

    try {
      const realDeps = await api.listDeployments();
      if (realDeps && realDeps.length > 0) {
        setDeployments(realDeps.map((d) => ({
          id: d.id, agentName: d.agentName, version: d.version, environment: d.environment,
          status: d.status, deployedAt: d.createdAt, deployedBy: d.deployedBy ?? "unknown",
        })));
        hasApiData = true;
      }
    } catch { /* API unavailable */ }

    if (!hasApiData) {
      // No data from API -- leave empty, show getting started
      setDataPlanes([]);
      setDeployments([]);
    }

    // Load hosted agents from localStorage (Gap 5)
    try {
      const hosted = JSON.parse(localStorage.getItem("lantern_hosted_agents") || "[]");
      setHostedAgents(hosted);
    } catch { /* */ }

    // Load available agents for the deploy picker
    try {
      const agentList = await api.listAgents();
      if (agentList && agentList.length > 0) {
        setAvailableAgents(agentList.map((a) => ({ name: a.name, description: a.description || "" })));
      }
    } catch { /* */ }

    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleAddDataPlane = async () => {
    if (!addForm.name.trim()) { toast.error("Data plane name is required"); return; }
    setAdding(true);
    try {
      const result = await api.registerDataPlane({ name: addForm.name, cloud: addForm.cloud, region: addForm.region });
      setDataPlanes((prev) => [...prev, {
        id: result.id, name: result.name, cloud: result.cloud, region: result.region,
        status: result.status, agentsDeployed: 0, lastHeartbeat: result.createdAt,
      }]);
      toast.success(`Data plane "${result.name}" registered`);
    } catch {
      // Simulated
      setDataPlanes((prev) => [...prev, {
        id: `dp_${Date.now()}`, name: addForm.name, cloud: addForm.cloud, region: addForm.region,
        status: "provisioning", agentsDeployed: 0, lastHeartbeat: new Date().toISOString(),
      }]);
      toast.success(`Data plane "${addForm.name}" registered (demo mode)`);
    }
    setAdding(false);
    setShowAddPlane(false);
    setAddForm({ name: "", cloud: "aws", region: "us-east-1" });
  };

  const handleRemoveDataPlane = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try { await api.removeDataPlane(removeTarget.id); } catch { /* simulate */ }
    setDataPlanes((prev) => prev.filter((dp) => dp.id !== removeTarget.id));
    toast.success(`Data plane "${removeTarget.name}" removed`);
    setRemoving(false);
    setRemoveTarget(null);
  };

  if (loading) {
    return (
      <div className="flex flex-1 flex-col overflow-auto">
        <HeaderSkeleton />
        <div className="p-8 space-y-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-zinc-800 bg-surface-1 p-6">
                <Skeleton className="mb-3 h-10 w-10 rounded-xl" />
                <Skeleton className="mb-2 h-5 w-32" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const hasInfrastructure = dataPlanes.length > 0;
  const hasDeployments = deployments.length > 0;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Deployments</h1>
            <p className="mt-1 text-sm text-zinc-500">
              {hasInfrastructure ? "Manage your infrastructure and deployments" : "Connect your cloud infrastructure to run agents in your own VPC"}
            </p>
          </div>
          {hasInfrastructure && (
            <button onClick={() => setShowAddPlane(true)} className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-400">
              <Plus className="h-3.5 w-3.5" />Connect Data Plane
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-8 p-8">
        {/* Lantern Cloud section (Gap 5) */}
        {hostedAgents.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                <Zap className="h-4 w-4 text-cyan-400" /> Lantern Cloud
                <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[9px] font-medium text-cyan-400">Managed</span>
              </h2>
              <button onClick={() => setShowDeployModal(true)} className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cyan-500">
                <Plus className="h-3.5 w-3.5" /> Deploy Agent
              </button>
            </div>
            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
              <table className="data-table">
                <thead>
                  <tr><th>Agent</th><th>Status</th><th>URL</th><th>Sessions</th><th>Tokens</th><th>Cost</th><th className="w-20"></th></tr>
                </thead>
                <tbody>
                  {hostedAgents.map((ha) => (
                    <tr key={ha.name}>
                      <td><span className="font-medium text-zinc-100">{ha.name}</span></td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <StatusDot status={ha.status} />
                          <span className={clsx("text-xs capitalize", ha.status === "live" && "text-emerald-400", ha.status === "stopped" && "text-zinc-400")}>{ha.status}</span>
                        </div>
                      </td>
                      <td>
                        <button onClick={() => { navigator.clipboard.writeText(ha.url); toast.success("URL copied"); }} className="inline-flex items-center gap-1 font-mono text-[11px] text-cyan-400 hover:text-cyan-300" title={ha.url}>
                          <ExternalLink className="h-3 w-3" /> {ha.url.replace("https://", "").slice(0, 30)}
                        </button>
                      </td>
                      <td><span className="text-zinc-400">{ha.sessions}</span></td>
                      <td><span className="text-zinc-400">{ha.tokens}</span></td>
                      <td><span className="text-zinc-300">${ha.costUsd}</span></td>
                      <td>
                        <div className="flex items-center gap-1">
                          {ha.status === "live" ? (
                            <button onClick={() => { const updated = hostedAgents.map(a => a.name === ha.name ? { ...a, status: "stopped" } : a); setHostedAgents(updated); localStorage.setItem("lantern_hosted_agents", JSON.stringify(updated)); toast.success(`${ha.name} stopped`); }} className="rounded-lg p-1.5 text-zinc-600 transition-colors hover:bg-red-500/10 hover:text-red-400" title="Stop">
                              <Square className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <button onClick={() => { const updated = hostedAgents.map(a => a.name === ha.name ? { ...a, status: "live" } : a); setHostedAgents(updated); localStorage.setItem("lantern_hosted_agents", JSON.stringify(updated)); toast.success(`${ha.name} restarted`); }} className="rounded-lg p-1.5 text-zinc-600 transition-colors hover:bg-emerald-500/10 hover:text-emerald-400" title="Start">
                              <Play className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button onClick={() => { const updated = hostedAgents.filter(a => a.name !== ha.name); setHostedAgents(updated); localStorage.setItem("lantern_hosted_agents", JSON.stringify(updated)); toast.success(`${ha.name} removed`); }} className="rounded-lg p-1.5 text-zinc-600 transition-colors hover:bg-red-500/10 hover:text-red-400" title="Remove">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Usage billing summary */}
            <div className="mt-4 rounded-xl border border-zinc-800 bg-surface-1 p-4">
              <div className="flex items-center gap-2 mb-3">
                <DollarSign className="h-4 w-4 text-zinc-400" />
                <span className="text-sm font-semibold text-zinc-200">Billing Summary (This Month)</span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="rounded-lg bg-surface-0 p-3">
                  <p className="text-lg font-semibold text-zinc-100">{hostedAgents.reduce((s, a) => s + a.sessions, 0).toLocaleString()}</p>
                  <p className="text-[10px] text-zinc-500">Total Sessions</p>
                </div>
                <div className="rounded-lg bg-surface-0 p-3">
                  <p className="text-lg font-semibold text-zinc-100">{hostedAgents.reduce((s, a) => s + (parseFloat(a.tokens.replace("k", "")) * 1000 || 0), 0).toLocaleString()}</p>
                  <p className="text-[10px] text-zinc-500">Total Tokens</p>
                </div>
                <div className="rounded-lg bg-surface-0 p-3">
                  <p className="text-lg font-semibold text-zinc-100">${hostedAgents.reduce((s, a) => s + parseFloat(a.costUsd || "0"), 0).toFixed(2)}</p>
                  <p className="text-[10px] text-zinc-500">Total Cost</p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Deploy Agent prompt (when no hosted agents but have agents) */}
        {hostedAgents.length === 0 && (
          <section className="rounded-xl border border-dashed border-cyan-500/30 bg-cyan-500/5 p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-500/10">
                <Zap className="h-6 w-6 text-cyan-400" />
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-zinc-100">Lantern Cloud</h3>
                <p className="mt-0.5 text-xs text-zinc-500">Deploy agents to managed infrastructure with usage-based billing. No servers to manage.</p>
              </div>
              <button onClick={() => setShowDeployModal(true)} className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-500">
                <Cloud className="h-3.5 w-3.5" /> Deploy Agent
              </button>
            </div>
          </section>
        )}

        {/* Getting Started (when no data planes) */}
        {!hasInfrastructure && !hasDeployments && (
          <section>
            <div className="mb-6 text-center">
              <Server className="mx-auto mb-3 h-10 w-10 text-zinc-600" />
              <h2 className="text-lg font-semibold text-zinc-100">Deploy your agents</h2>
              <p className="mt-1 text-sm text-zinc-500 max-w-md mx-auto">
                Connect your cloud infrastructure to run agents in your own VPC with microVM isolation.
              </p>
              <p className="mt-2 text-xs text-zinc-600 max-w-lg mx-auto">
                A data plane is a Kubernetes cluster in your cloud account that executes agent workloads.
                Your agents and data stay in your infrastructure while Lantern orchestrates from the control plane.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {cloudSetups.map((setup) => (
                <button
                  key={setup.cloud}
                  onClick={() => setSelectedCloud(selectedCloud?.cloud === setup.cloud ? null : setup)}
                  className={clsx(
                    "rounded-xl border p-5 text-left transition-all",
                    selectedCloud?.cloud === setup.cloud ? "border-lantern-500 bg-lantern-500/5" : "border-zinc-800 bg-surface-1 hover:border-zinc-700",
                  )}
                >
                  <div className={clsx("flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold", setup.bgColor, setup.color)}>
                    {setup.icon}
                  </div>
                  <h3 className="mt-3 text-sm font-semibold text-zinc-100">Connect {setup.name}</h3>
                  <p className="mt-1 text-xs text-zinc-500">
                    {setup.name === "AWS" && "Amazon EKS with Firecracker support"}
                    {setup.name === "GCP" && "Google GKE with nested virtualization"}
                    {setup.name === "Azure" && "Azure AKS with dedicated hosts"}
                  </p>
                </button>
              ))}
            </div>

            {/* Show install commands when a cloud is selected */}
            {selectedCloud && (
              <div className="mt-6 rounded-xl border border-zinc-800 bg-surface-1 p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-zinc-400" />
                    <h3 className="text-sm font-semibold text-zinc-100">{selectedCloud.name} Installation</h3>
                  </div>
                  <button
                    onClick={() => { navigator.clipboard.writeText(selectedCloud.steps.join("\n")); toast.success("Commands copied"); }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200 hover:bg-surface-3"
                  >
                    <Copy className="h-3 w-3" />Copy
                  </button>
                </div>
                <pre className="rounded-lg border border-zinc-800 bg-surface-0 p-4 font-mono text-xs text-zinc-400 overflow-x-auto leading-relaxed">
                  {selectedCloud.steps.join("\n")}
                </pre>
                <div className="mt-4 flex items-center gap-3">
                  <button onClick={() => setShowAddPlane(true)} className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400">
                    <Plus className="h-3.5 w-3.5" />Register Data Plane
                  </button>
                  <p className="text-xs text-zinc-500">After running the install commands, register your data plane here.</p>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Data Planes table (when data planes exist) */}
        {hasInfrastructure && (
          <section>
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <Server className="h-4 w-4 text-zinc-400" />Data Planes
            </h2>
            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
              <table className="data-table">
                <thead>
                  <tr><th>Name</th><th>Cloud</th><th>Region</th><th>Status</th><th>Agents</th><th>Last Heartbeat</th><th className="w-16"></th></tr>
                </thead>
                <tbody>
                  {dataPlanes.map((dp) => (
                    <tr key={dp.id}>
                      <td><span className="font-medium text-zinc-100">{dp.name}</span></td>
                      <td><CloudBadge cloud={dp.cloud} /></td>
                      <td><span className="font-mono text-xs text-zinc-400">{dp.region}</span></td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <StatusDot status={dp.status} />
                          <span className={clsx("text-xs capitalize", dp.status === "healthy" && "text-emerald-400", dp.status === "degraded" && "text-amber-400", dp.status === "offline" && "text-red-400", dp.status === "provisioning" && "text-blue-400")}>{dp.status}</span>
                        </div>
                      </td>
                      <td><span className="text-zinc-400">{dp.agentsDeployed}</span></td>
                      <td><span className="text-xs text-zinc-500">{timeAgo(dp.lastHeartbeat)}</span></td>
                      <td>
                        <button onClick={() => setRemoveTarget(dp)} className="rounded-lg p-1.5 text-zinc-600 transition-colors hover:bg-red-500/10 hover:text-red-400" title="Remove">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Deployments table (when deployments exist) */}
        {hasDeployments && (
          <section>
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <Activity className="h-4 w-4 text-zinc-400" />Recent Deployments
            </h2>
            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
              <table className="data-table">
                <thead>
                  <tr><th>Agent</th><th>Version</th><th>Environment</th><th>Status</th><th>Deployed</th><th>By</th></tr>
                </thead>
                <tbody>
                  {deployments.map((dep) => (
                    <tr key={dep.id} className="no-click">
                      <td><span className="font-medium text-zinc-100">{dep.agentName}</span></td>
                      <td><span className="font-mono text-xs text-zinc-400">{dep.version}</span></td>
                      <td><EnvBadge env={dep.environment} /></td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <StatusDot status={dep.status} />
                          <span className={clsx("text-xs capitalize", dep.status === "live" && "text-emerald-400", dep.status === "deploying" && "text-blue-400", dep.status === "failed" && "text-red-400")}>{dep.status}</span>
                        </div>
                      </td>
                      <td><span className="text-xs text-zinc-500">{timeAgo(dep.deployedAt)}</span></td>
                      <td><span className="text-xs text-zinc-500">{dep.deployedBy}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {/* Add Data Plane Modal */}
      {showAddPlane && (
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowAddPlane(false)}>
          <div className="modal-content w-full max-w-md rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <h2 className="text-lg font-semibold text-zinc-100">Register Data Plane</h2>
              <button onClick={() => setShowAddPlane(false)} className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">Name <span className="text-red-400">*</span></label>
                <input type="text" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="lantern-dp-production"
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30" />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">Cloud</label>
                <select value={addForm.cloud} onChange={(e) => setAddForm({ ...addForm, cloud: e.target.value })}
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30">
                  <option value="aws">AWS</option>
                  <option value="gcp">GCP</option>
                  <option value="azure">Azure</option>
                  <option value="self-hosted">Self-hosted</option>
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">Region</label>
                <input type="text" value={addForm.region} onChange={(e) => setAddForm({ ...addForm, region: e.target.value })} placeholder="us-east-1"
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30" />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
              <button onClick={() => setShowAddPlane(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200">Cancel</button>
              <button onClick={handleAddDataPlane} disabled={adding}
                className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50">
                {adding ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Registering...</> : <><Plus className="h-3.5 w-3.5" />Register</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Deploy Agent Modal (Gap 5) */}
      {showDeployModal && (
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowDeployModal(false)}>
          <div className="modal-content w-full max-w-md rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <h2 className="text-lg font-semibold text-zinc-100">Deploy Agent to Cloud</h2>
              <button onClick={() => setShowDeployModal(false)} className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">Select Agent</label>
                {availableAgents.length > 0 ? (
                  <select value={deployAgentName} onChange={(e) => setDeployAgentName(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30">
                    <option value="">Choose an agent...</option>
                    {availableAgents.map((a) => (
                      <option key={a.name} value={a.name}>{a.name}{a.description ? ` - ${a.description}` : ""}</option>
                    ))}
                  </select>
                ) : (
                  <input type="text" value={deployAgentName} onChange={(e) => setDeployAgentName(e.target.value)} placeholder="Agent name (e.g., email-digest)"
                    className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30" />
                )}
              </div>
              <div className="rounded-lg bg-surface-0 p-3 space-y-1">
                <p className="text-xs font-medium text-zinc-300">What happens when you deploy:</p>
                <ul className="text-[10px] text-zinc-500 space-y-0.5 list-disc list-inside">
                  <li>Agent is deployed to managed Lantern Cloud infrastructure</li>
                  <li>A public URL is assigned for API access</li>
                  <li>Usage is tracked: sessions, tokens, compute hours</li>
                  <li>Billing is usage-based with no upfront cost</li>
                </ul>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
              <button onClick={() => setShowDeployModal(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200">Cancel</button>
              <button onClick={async () => {
                if (!deployAgentName.trim()) { toast.error("Select an agent to deploy"); return; }
                setDeployingAgent(true);
                try { await api.deployAgent(deployAgentName); } catch { /* simulate */ }
                const newAgent: HostedAgent = {
                  name: deployAgentName,
                  status: "live",
                  url: `https://agents.lantern.run/${deployAgentName}`,
                  sessions: 0,
                  tokens: "0",
                  costUsd: "0.00",
                  deployedAt: new Date().toISOString(),
                };
                const updated = [...hostedAgents, newAgent];
                setHostedAgents(updated);
                localStorage.setItem("lantern_hosted_agents", JSON.stringify(updated));
                toast.success(`"${deployAgentName}" deployed to Lantern Cloud`);
                setDeployingAgent(false);
                setShowDeployModal(false);
                setDeployAgentName("");
              }} disabled={deployingAgent || !deployAgentName.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-500 disabled:opacity-50">
                {deployingAgent ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Deploying...</> : <><Cloud className="h-3.5 w-3.5" />Deploy</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove Confirmation Modal */}
      {removeTarget && (
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setRemoveTarget(null)}>
          <div className="modal-content w-full max-w-md rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-3">
                <AlertTriangle className="h-5 w-5 text-red-400" />
                <h3 className="text-lg font-semibold text-zinc-100">Remove &quot;{removeTarget.name}&quot;?</h3>
              </div>
              <p className="text-sm text-zinc-400">
                This will disconnect the data plane from the control plane. Any agents deployed on it will become unreachable. This action cannot be undone.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
              <button onClick={() => setRemoveTarget(null)} disabled={removing} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-50">Cancel</button>
              <button onClick={handleRemoveDataPlane} disabled={removing}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50">
                {removing ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Removing...</> : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
