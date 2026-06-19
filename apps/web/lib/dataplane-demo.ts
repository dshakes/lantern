// Demo data-plane set — a clearly-labeled, fabricated fleet of customer-cloud
// data planes used to populate the Data Plane Command Center when the live API
// returns no registered planes (empty) OR is unreachable (offline).
//
// HONESTY CONTRACT: this data is ONLY ever rendered behind a visible
// "Demo data planes — none registered" badge. Real planes returned by
// /v1/data-planes are NEVER merged with or decorated by this set. Demo planes
// carry capacity / tunnel / heartbeat / workload telemetry that the live
// DataPlane API does not yet expose; real planes render those fields as "—"
// (see page.tsx honesty guard) rather than a fabricated value.

// A demo plane is a superset of the live DataPlane shape plus the richer
// telemetry the command center wants to show (capacity, tunnel health,
// per-plane workload + agent counts, a heartbeat/capacity sparkline seed).
export interface DemoDataPlane {
  id: string;
  name: string;
  cloud: "aws" | "gcp" | "azure";
  region: string;
  clusterName: string;
  status: "healthy" | "degraded" | "offline";
  // Outbound mTLS tunnel control-plane → data-plane.
  tunnel: "up" | "down";
  agentCount: number;
  workloadCount: number;
  // Capacity: nodes + vCPU used/total + memory used/total (GiB).
  nodes: number;
  vcpuUsed: number;
  vcpuTotal: number;
  memUsedGib: number;
  memTotalGib: number;
  // Seconds since last heartbeat (drives the color-coded freshness label).
  heartbeatAgoSec: number;
  version: string;
  // Sparkline seed: a 0..1 capacity-utilisation history (most recent last).
  capacityHistory: number[];
}

// A small deterministic walk so the sparkline reads alive but is stable.
function walk(seed: number, base: number, len = 24, vol = 0.12): number[] {
  let s = (seed % 2147483647) || 1;
  const rand = () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < len; i++) {
    v += (rand() - 0.5) * vol;
    v += (base - v) * 0.1; // mean-revert toward base
    out.push(Math.min(1, Math.max(0.03, v)));
  }
  return out;
}

// 4 planes spanning AWS / GCP / Azure across 4 regions with mixed health.
export const DEMO_DATA_PLANES: DemoDataPlane[] = [
  {
    id: "dp_demo_aws_iad",
    name: "lantern-dp-prod",
    cloud: "aws",
    region: "us-east-1",
    clusterName: "lantern-dp-eks",
    status: "healthy",
    tunnel: "up",
    agentCount: 7,
    workloadCount: 18,
    nodes: 6,
    vcpuUsed: 142,
    vcpuTotal: 192,
    memUsedGib: 412,
    memTotalGib: 768,
    heartbeatAgoSec: 4,
    version: "dp-1.8.2",
    capacityHistory: walk(101, 0.74),
  },
  {
    id: "dp_demo_gcp_iowa",
    name: "lantern-dp-eu",
    cloud: "gcp",
    region: "europe-west1",
    clusterName: "lantern-dp-gke",
    status: "healthy",
    tunnel: "up",
    agentCount: 4,
    workloadCount: 9,
    nodes: 4,
    vcpuUsed: 58,
    vcpuTotal: 128,
    memUsedGib: 176,
    memTotalGib: 512,
    heartbeatAgoSec: 11,
    version: "dp-1.8.2",
    capacityHistory: walk(202, 0.45),
  },
  {
    id: "dp_demo_azure_eus2",
    name: "lantern-dp-staging",
    cloud: "azure",
    region: "eastus2",
    clusterName: "lantern-dp-aks",
    status: "degraded",
    tunnel: "up",
    agentCount: 3,
    workloadCount: 11,
    nodes: 3,
    vcpuUsed: 88,
    vcpuTotal: 96,
    memUsedGib: 332,
    memTotalGib: 384,
    heartbeatAgoSec: 47,
    version: "dp-1.7.9",
    capacityHistory: walk(303, 0.9, 24, 0.06),
  },
  {
    id: "dp_demo_aws_sfo",
    name: "lantern-dp-west",
    cloud: "aws",
    region: "us-west-2",
    clusterName: "lantern-dp-eks-west",
    status: "offline",
    tunnel: "down",
    agentCount: 2,
    workloadCount: 0,
    nodes: 2,
    vcpuUsed: 0,
    vcpuTotal: 64,
    memUsedGib: 0,
    memTotalGib: 256,
    heartbeatAgoSec: 1840,
    version: "dp-1.7.9",
    capacityHistory: walk(404, 0.02, 24, 0.02),
  },
];

// Demo deployments mapped onto the demo planes — which agent versions run where.
export interface DemoDeployment {
  id: string;
  agentName: string;
  version: string;
  environment: "production" | "staging" | "development";
  status: "live" | "deploying" | "failed";
  planeId: string;
  deployedAgoSec: number;
}

export const DEMO_DEPLOYMENTS: DemoDeployment[] = [
  { id: "dep_d1", agentName: "research-orchestrator", version: "v4.2.0", environment: "production", status: "live", planeId: "dp_demo_aws_iad", deployedAgoSec: 3 * 3600 },
  { id: "dep_d2", agentName: "invoice-extractor", version: "v2.1.3", environment: "production", status: "live", planeId: "dp_demo_aws_iad", deployedAgoSec: 26 * 3600 },
  { id: "dep_d3", agentName: "eu-support-triage", version: "v1.6.0", environment: "production", status: "live", planeId: "dp_demo_gcp_iowa", deployedAgoSec: 9 * 3600 },
  { id: "dep_d4", agentName: "pii-redactor", version: "v1.0.4", environment: "staging", status: "deploying", planeId: "dp_demo_azure_eus2", deployedAgoSec: 120 },
  { id: "dep_d5", agentName: "nightly-eval-suite", version: "v5.0.1", environment: "staging", status: "live", planeId: "dp_demo_azure_eus2", deployedAgoSec: 14 * 3600 },
  { id: "dep_d6", agentName: "etl-pipeline-sync", version: "v1.2.0", environment: "development", status: "failed", planeId: "dp_demo_aws_sfo", deployedAgoSec: 30 * 3600 },
];
