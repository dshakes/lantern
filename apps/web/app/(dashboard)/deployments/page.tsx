"use client";

import { useState, useEffect } from "react";
import {
  Cloud,
  Server,
  Plus,
  X,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Copy,
  ArrowRight,
  RefreshCw,
  Activity,
  Globe,
  Shield,
  Terminal,
} from "lucide-react";
import clsx from "clsx";
import { useToast } from "@/components/toast";
import { HeaderSkeleton, Skeleton } from "@/components/skeleton";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DataPlane {
  id: string;
  name: string;
  cloud: "AWS" | "GCP" | "Azure" | "Self-hosted";
  region: string;
  status: "healthy" | "degraded" | "offline";
  agentsDeployed: number;
  lastHeartbeat: string;
}

interface Deployment {
  id: string;
  agentName: string;
  version: string;
  environment: "development" | "staging" | "production";
  status: "deploying" | "live" | "failed" | "rolled-back";
  deployedAt: string;
  deployedBy: string;
  logs?: string[];
}

interface Environment {
  name: string;
  label: string;
  url: string;
  agentCount: number;
  status: "healthy" | "degraded" | "offline";
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockDataPlanes: DataPlane[] = [
  { id: "dp_1", name: "us-east-production", cloud: "AWS", region: "us-east-1", status: "healthy", agentsDeployed: 12, lastHeartbeat: "2026-04-12T10:30:00Z" },
  { id: "dp_2", name: "eu-west-production", cloud: "AWS", region: "eu-west-1", status: "healthy", agentsDeployed: 8, lastHeartbeat: "2026-04-12T10:29:55Z" },
  { id: "dp_3", name: "gcp-staging", cloud: "GCP", region: "us-central1", status: "degraded", agentsDeployed: 5, lastHeartbeat: "2026-04-12T10:25:00Z" },
  { id: "dp_4", name: "azure-dev", cloud: "Azure", region: "eastus2", status: "healthy", agentsDeployed: 3, lastHeartbeat: "2026-04-12T10:30:01Z" },
];

const mockDeployments: Deployment[] = [
  { id: "dep_1", agentName: "research-agent", version: "v1.4.2", environment: "production", status: "live", deployedAt: "2026-04-12T09:15:00Z", deployedBy: "ci/github-actions", logs: ["Pulling bundle research-agent@v1.4.2...", "Bundle verified (sha256:a1b2c3...)", "Starting rollout (3 replicas)...", "Replica 1/3 healthy", "Replica 2/3 healthy", "Replica 3/3 healthy", "Deployment complete. All health checks passed."] },
  { id: "dep_2", agentName: "email-triage", version: "v2.1.0", environment: "staging", status: "live", deployedAt: "2026-04-12T08:45:00Z", deployedBy: "demo@lantern.dev", logs: ["Pulling bundle email-triage@v2.1.0...", "Bundle verified", "Starting rollout (1 replica)...", "Replica 1/1 healthy", "Deployment complete."] },
  { id: "dep_3", agentName: "connector-agent", version: "v0.9.8", environment: "production", status: "failed", deployedAt: "2026-04-11T16:30:00Z", deployedBy: "ci/github-actions", logs: ["Pulling bundle connector-agent@v0.9.8...", "Bundle verified", "Starting rollout (2 replicas)...", "Replica 1/2 healthy", "Replica 2/2 FAILED: health check timeout after 30s", "Rollback initiated...", "Rolled back to v0.9.7"] },
  { id: "dep_4", agentName: "chatbot", version: "v3.0.1", environment: "production", status: "live", deployedAt: "2026-04-11T14:00:00Z", deployedBy: "demo@lantern.dev", logs: ["Pulling bundle chatbot@v3.0.1...", "Bundle verified", "Starting rollout...", "Deployment complete."] },
  { id: "dep_5", agentName: "scheduler-bot", version: "v1.0.0", environment: "development", status: "live", deployedAt: "2026-04-11T11:20:00Z", deployedBy: "demo@lantern.dev" },
  { id: "dep_6", agentName: "research-agent", version: "v1.4.1", environment: "production", status: "rolled-back", deployedAt: "2026-04-10T22:00:00Z", deployedBy: "ci/github-actions", logs: ["Rolled back due to elevated error rate"] },
];

const mockEnvironments: Environment[] = [
  { name: "development", label: "Development", url: "dev.acme.lantern.run", agentCount: 5, status: "healthy" },
  { name: "staging", label: "Staging", url: "staging.acme.lantern.run", agentCount: 8, status: "healthy" },
  { name: "production", label: "Production", url: "acme.lantern.run", agentCount: 12, status: "healthy" },
];

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "lantern_deployments";

function loadState(): { dataPlanes: DataPlane[]; deployments: Deployment[] } {
  if (typeof window === "undefined") return { dataPlanes: mockDataPlanes, deployments: mockDeployments };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { dataPlanes: mockDataPlanes, deployments: mockDeployments };
}

function saveState(state: { dataPlanes: DataPlane[]; deployments: Deployment[] }) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        "h-2 w-2 rounded-full",
        status === "healthy" && "bg-emerald-400",
        status === "degraded" && "bg-amber-400",
        status === "offline" && "bg-red-400",
        status === "live" && "bg-emerald-400",
        status === "deploying" && "bg-blue-400 animate-pulse",
        status === "failed" && "bg-red-400",
        status === "rolled-back" && "bg-amber-400"
      )}
    />
  );
}

function CloudBadge({ cloud }: { cloud: string }) {
  const colors: Record<string, string> = {
    AWS: "bg-orange-500/10 text-orange-400",
    GCP: "bg-blue-500/10 text-blue-400",
    Azure: "bg-sky-500/10 text-sky-400",
    "Self-hosted": "bg-zinc-500/10 text-zinc-400",
  };
  return (
    <span className={clsx("rounded-md px-2 py-0.5 text-[11px] font-medium", colors[cloud] ?? colors["Self-hosted"])}>
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
    <span className={clsx("rounded-md px-2 py-0.5 text-[11px] font-medium capitalize", colors[env] ?? colors["development"])}>
      {env}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function DeploymentsPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [dataPlanes, setDataPlanes] = useState<DataPlane[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [expandedDep, setExpandedDep] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardForm, setWizardForm] = useState({ cloud: "AWS", region: "us-east-1", clusterName: "", instanceType: "m6i.xlarge" });
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    const state = loadState();
    setDataPlanes(state.dataPlanes);
    setDeployments(state.deployments);
    setLoading(false);
  }, []);

  const handleAddDataPlane = async () => {
    if (wizardStep < 2) {
      setWizardStep(wizardStep + 1);
      return;
    }
    // Step 3: verify
    setVerifying(true);
    await new Promise((r) => setTimeout(r, 2000));
    setVerifying(false);
    setVerified(true);

    const newDp: DataPlane = {
      id: `dp_${Date.now()}`,
      name: wizardForm.clusterName || `${wizardForm.cloud.toLowerCase()}-${wizardForm.region}-new`,
      cloud: wizardForm.cloud as DataPlane["cloud"],
      region: wizardForm.region,
      status: "healthy",
      agentsDeployed: 0,
      lastHeartbeat: new Date().toISOString(),
    };
    const updated = [...dataPlanes, newDp];
    setDataPlanes(updated);
    saveState({ dataPlanes: updated, deployments });
    toast.success(`Data plane "${newDp.name}" connected successfully`);
  };

  const closeWizard = () => {
    setShowWizard(false);
    setWizardStep(0);
    setWizardForm({ cloud: "AWS", region: "us-east-1", clusterName: "", instanceType: "m6i.xlarge" });
    setVerifying(false);
    setVerified(false);
  };

  const terraformCommands = `# 1. Initialize Terraform
terraform init

# 2. Apply the Lantern data plane module
terraform apply -var="cloud=${wizardForm.cloud.toLowerCase()}" \\
  -var="region=${wizardForm.region}" \\
  -var="cluster_name=${wizardForm.clusterName || "lantern-dp"}" \\
  -var="instance_type=${wizardForm.instanceType}"

# 3. Install the Helm chart
helm install lantern-data-plane lantern/data-plane \\
  --set controlPlane.endpoint=api.lantern.run \\
  --set controlPlane.token=<your-registration-token>`;

  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  if (loading) {
    return (
      <div className="flex flex-1 flex-col overflow-auto">
        <HeaderSkeleton />
        <div className="p-8 space-y-8">
          <div className="rounded-xl border border-zinc-800 bg-surface-1 p-6">
            <Skeleton className="mb-4 h-5 w-32" />
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <h1 className="text-xl font-semibold text-zinc-100">Deployments</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Manage your infrastructure and data planes
        </p>
      </div>

      <div className="flex-1 space-y-8 p-8">
        {/* Data Planes section */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <Server className="h-4 w-4 text-zinc-400" />
              Data Planes
            </h2>
            <button
              onClick={() => setShowWizard(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-400"
            >
              <Plus className="h-3.5 w-3.5" />
              Connect Data Plane
            </button>
          </div>

          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Cloud</th>
                  <th>Region</th>
                  <th>Status</th>
                  <th>Agents</th>
                  <th>Last Heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {dataPlanes.map((dp) => (
                  <tr key={dp.id}>
                    <td>
                      <span className="font-medium text-zinc-100">{dp.name}</span>
                    </td>
                    <td>
                      <CloudBadge cloud={dp.cloud} />
                    </td>
                    <td>
                      <span className="font-mono text-xs text-zinc-400">{dp.region}</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={dp.status} />
                        <span className={clsx(
                          "text-xs capitalize",
                          dp.status === "healthy" && "text-emerald-400",
                          dp.status === "degraded" && "text-amber-400",
                          dp.status === "offline" && "text-red-400"
                        )}>
                          {dp.status}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="text-zinc-400">{dp.agentsDeployed}</span>
                    </td>
                    <td>
                      <span className="text-xs text-zinc-500">{timeAgo(dp.lastHeartbeat)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Recent Deployments section */}
        <section>
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Activity className="h-4 w-4 text-zinc-400" />
            Recent Deployments
          </h2>

          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
            <table className="data-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Agent</th>
                  <th>Version</th>
                  <th>Environment</th>
                  <th>Status</th>
                  <th>Deployed At</th>
                  <th>Deployed By</th>
                </tr>
              </thead>
              <tbody>
                {deployments.map((dep) => (
                  <>
                    <tr
                      key={dep.id}
                      onClick={() => setExpandedDep(expandedDep === dep.id ? null : dep.id)}
                      className="cursor-pointer"
                    >
                      <td className="w-8">
                        {dep.logs && dep.logs.length > 0 ? (
                          expandedDep === dep.id ? (
                            <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
                          )
                        ) : null}
                      </td>
                      <td>
                        <span className="font-medium text-zinc-100">{dep.agentName}</span>
                      </td>
                      <td>
                        <span className="font-mono text-xs text-zinc-400">{dep.version}</span>
                      </td>
                      <td>
                        <EnvBadge env={dep.environment} />
                      </td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <StatusDot status={dep.status} />
                          <span className={clsx(
                            "text-xs capitalize",
                            dep.status === "live" && "text-emerald-400",
                            dep.status === "deploying" && "text-blue-400",
                            dep.status === "failed" && "text-red-400",
                            dep.status === "rolled-back" && "text-amber-400"
                          )}>
                            {dep.status}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="text-xs text-zinc-500">{timeAgo(dep.deployedAt)}</span>
                      </td>
                      <td>
                        <span className="text-xs text-zinc-500">{dep.deployedBy}</span>
                      </td>
                    </tr>
                    {expandedDep === dep.id && dep.logs && (
                      <tr key={`${dep.id}-logs`}>
                        <td colSpan={7} className="!p-0">
                          <div className="border-t border-zinc-800/50 bg-surface-0 px-6 py-3">
                            <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-zinc-600">
                              Deployment Logs
                            </p>
                            <div className="rounded-lg border border-zinc-800 bg-surface-2 p-3 font-mono text-xs text-zinc-400 space-y-0.5">
                              {dep.logs.map((line, i) => (
                                <div key={i} className="flex gap-2">
                                  <span className="select-none text-zinc-700">{String(i + 1).padStart(2, " ")}.</span>
                                  <span className={clsx(
                                    line.includes("FAILED") && "text-red-400",
                                    line.includes("Rollback") && "text-amber-400",
                                    line.includes("complete") && "text-emerald-400",
                                    line.includes("healthy") && !line.includes("FAILED") && "text-emerald-400/70",
                                  )}>
                                    {line}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Environments section */}
        <section>
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Globe className="h-4 w-4 text-zinc-400" />
            Environments
          </h2>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {mockEnvironments.map((env) => (
              <div
                key={env.name}
                className="rounded-xl border border-zinc-800 bg-surface-1 p-5"
                style={{
                  backdropFilter: "blur(12px)",
                  background: "linear-gradient(135deg, rgba(15,15,18,0.9), rgba(24,24,27,0.9))",
                }}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-100">{env.label}</h3>
                  <div className="flex items-center gap-1.5">
                    <StatusDot status={env.status} />
                    <span className={clsx(
                      "text-xs capitalize",
                      env.status === "healthy" && "text-emerald-400",
                      env.status === "degraded" && "text-amber-400",
                    )}>
                      {env.status}
                    </span>
                  </div>
                </div>
                <p className="mt-2 font-mono text-xs text-zinc-500">{env.url}</p>
                <p className="mt-1 text-xs text-zinc-500">{env.agentCount} agents deployed</p>
                {env.name !== "production" && (
                  <button
                    onClick={() => toast.info(`Promote to ${env.name === "development" ? "staging" : "production"}?`)}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
                  >
                    <ArrowRight className="h-3 w-3" />
                    Promote to {env.name === "development" ? "Staging" : "Production"}
                  </button>
                )}
                {env.name === "production" && (
                  <div className="mt-3 flex items-center gap-1.5 text-xs text-zinc-600">
                    <Shield className="h-3 w-3" />
                    Production environment
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Connect Data Plane Wizard */}
      {showWizard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <h2 className="text-lg font-semibold text-zinc-100">Connect Data Plane</h2>
              <button
                onClick={closeWizard}
                className="rounded-lg p-1 text-zinc-500 hover:bg-surface-3 hover:text-zinc-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Step indicator */}
            <div className="flex items-center gap-2 px-6 py-3 border-b border-zinc-800/50">
              {["Select Cloud", "Configure", "Install", "Verify"].map((label, i) => (
                <div key={label} className="flex items-center gap-2">
                  <div
                    className={clsx(
                      "flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold",
                      i < wizardStep
                        ? "bg-emerald-500/20 text-emerald-400"
                        : i === wizardStep
                          ? "bg-lantern-500/20 text-lantern-400"
                          : "bg-surface-3 text-zinc-600"
                    )}
                  >
                    {i < wizardStep ? <Check className="h-3 w-3" /> : i + 1}
                  </div>
                  <span className={clsx(
                    "text-xs",
                    i === wizardStep ? "text-zinc-300" : "text-zinc-600"
                  )}>
                    {label}
                  </span>
                  {i < 3 && <ChevronRight className="h-3 w-3 text-zinc-700" />}
                </div>
              ))}
            </div>

            {/* Step content */}
            <div className="px-6 py-5">
              {wizardStep === 0 && (
                <div className="space-y-3">
                  <p className="text-sm text-zinc-400 mb-4">Select where your data plane will run.</p>
                  {(["AWS", "GCP", "Azure", "Self-hosted"] as const).map((cloud) => (
                    <button
                      key={cloud}
                      onClick={() => setWizardForm({ ...wizardForm, cloud })}
                      className={clsx(
                        "flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-all",
                        wizardForm.cloud === cloud
                          ? "border-lantern-500 bg-lantern-500/10"
                          : "border-zinc-800 hover:border-zinc-600"
                      )}
                    >
                      <Cloud className={clsx("h-5 w-5", wizardForm.cloud === cloud ? "text-lantern-400" : "text-zinc-500")} />
                      <div>
                        <span className={clsx("text-sm font-medium", wizardForm.cloud === cloud ? "text-zinc-100" : "text-zinc-300")}>{cloud}</span>
                        <p className="text-[11px] text-zinc-600">
                          {cloud === "AWS" && "Amazon EKS with Firecracker support"}
                          {cloud === "GCP" && "Google GKE with nested virtualization"}
                          {cloud === "Azure" && "Azure AKS with dedicated hosts"}
                          {cloud === "Self-hosted" && "Bare metal or on-premises Kubernetes"}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {wizardStep === 1 && (
                <div className="space-y-4">
                  <p className="text-sm text-zinc-400 mb-4">Configure your data plane deployment.</p>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-zinc-300">Region</label>
                    <select
                      value={wizardForm.region}
                      onChange={(e) => setWizardForm({ ...wizardForm, region: e.target.value })}
                      className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
                    >
                      {wizardForm.cloud === "AWS" && <>
                        <option value="us-east-1">us-east-1 (N. Virginia)</option>
                        <option value="us-west-2">us-west-2 (Oregon)</option>
                        <option value="eu-west-1">eu-west-1 (Ireland)</option>
                        <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                      </>}
                      {wizardForm.cloud === "GCP" && <>
                        <option value="us-central1">us-central1 (Iowa)</option>
                        <option value="us-east1">us-east1 (South Carolina)</option>
                        <option value="europe-west1">europe-west1 (Belgium)</option>
                      </>}
                      {wizardForm.cloud === "Azure" && <>
                        <option value="eastus2">eastus2 (East US 2)</option>
                        <option value="westeurope">westeurope (West Europe)</option>
                        <option value="southeastasia">southeastasia (Southeast Asia)</option>
                      </>}
                      {wizardForm.cloud === "Self-hosted" && <>
                        <option value="on-premises">On-premises</option>
                      </>}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-zinc-300">Cluster Name</label>
                    <input
                      type="text"
                      value={wizardForm.clusterName}
                      onChange={(e) => setWizardForm({ ...wizardForm, clusterName: e.target.value })}
                      placeholder="lantern-dp-production"
                      className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-zinc-300">Instance Type</label>
                    <select
                      value={wizardForm.instanceType}
                      onChange={(e) => setWizardForm({ ...wizardForm, instanceType: e.target.value })}
                      className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
                    >
                      <option value="m6i.xlarge">m6i.xlarge (4 vCPU, 16 GB)</option>
                      <option value="m6i.2xlarge">m6i.2xlarge (8 vCPU, 32 GB)</option>
                      <option value="m6i.4xlarge">m6i.4xlarge (16 vCPU, 64 GB)</option>
                      <option value="m5.metal">m5.metal (96 vCPU, 384 GB - Firecracker)</option>
                    </select>
                  </div>
                </div>
              )}

              {wizardStep === 2 && (
                <div className="space-y-4">
                  <p className="text-sm text-zinc-400 mb-4">Run the following commands to install the data plane.</p>
                  <div className="relative">
                    <div className="flex items-center gap-2 mb-2">
                      <Terminal className="h-4 w-4 text-zinc-400" />
                      <span className="text-xs font-medium text-zinc-300">Installation commands</span>
                    </div>
                    <pre className="rounded-lg border border-zinc-800 bg-surface-2 p-4 font-mono text-xs text-zinc-400 overflow-x-auto leading-relaxed">
                      {terraformCommands}
                    </pre>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(terraformCommands);
                        toast.success("Commands copied to clipboard");
                      }}
                      className="absolute right-2 top-8 rounded-md bg-surface-3 p-1.5 text-zinc-400 hover:text-zinc-200"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {wizardStep === 3 && (
                <div className="flex flex-col items-center justify-center py-8">
                  {verifying ? (
                    <>
                      <Loader2 className="mb-4 h-8 w-8 animate-spin text-lantern-400" />
                      <p className="text-sm text-zinc-300">Verifying connection...</p>
                      <p className="mt-1 text-xs text-zinc-500">Checking gRPC tunnel and heartbeat</p>
                    </>
                  ) : verified ? (
                    <>
                      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
                        <Check className="h-6 w-6 text-emerald-400" />
                      </div>
                      <p className="text-sm font-medium text-emerald-400">Connection verified</p>
                      <p className="mt-1 text-xs text-zinc-500">Data plane is healthy and receiving heartbeats</p>
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mb-4 h-8 w-8 text-zinc-500" />
                      <p className="text-sm text-zinc-300">Ready to verify</p>
                      <p className="mt-1 text-xs text-zinc-500">Click verify to check the connection</p>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-zinc-800 px-6 py-4">
              <button
                onClick={wizardStep === 0 ? closeWizard : () => setWizardStep(wizardStep - 1)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
              >
                {wizardStep === 0 ? "Cancel" : "Back"}
              </button>
              {verified ? (
                <button
                  onClick={closeWizard}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
                >
                  <Check className="h-3.5 w-3.5" />
                  Done
                </button>
              ) : (
                <button
                  onClick={handleAddDataPlane}
                  disabled={verifying}
                  className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50"
                >
                  {verifying ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Verifying...
                    </>
                  ) : wizardStep === 3 ? (
                    "Verify Connection"
                  ) : (
                    <>
                      Next
                      <ArrowRight className="h-3.5 w-3.5" />
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
