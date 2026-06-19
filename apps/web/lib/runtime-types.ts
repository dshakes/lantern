// Shared runtime types for the Command Center cockpit.
//
// `VmRow` mirrors the control-plane camelCase vmRow JSON tags. Cockpit-only
// fields (`name`, `cpuBase`, `memBase`, `costHr`) are OPTIONAL — they are
// populated by the demo fleet (lib/runtime-demo.ts) to seed simulated
// sparklines, and may be absent on real API rows. The page guards on them:
// a real VM with no metrics renders "—", never a fabricated value.

export type VmState =
  | "pending"
  | "spawning"
  | "running"
  | "draining"
  | "terminated"
  | "failed";

export interface VmRow {
  vmId: string;
  state: VmState;
  node: string | null;
  region?: string | null;
  az?: string | null;
  isolationClass: string;
  createdAt: string;
  terminatedAt?: string | null;
  lastHeartbeatAt?: string | null;
  spec: Record<string, unknown> | null;

  // ---- cockpit-only, demo-seeded (see honesty contract in runtime-demo.ts)
  /** Friendly workload / agent name. Real rows may not carry one. */
  name?: string;
  /** 0..1 baseline CPU utilisation used to seed the simulated sparkline. */
  cpuBase?: number;
  /** 0..1 baseline memory utilisation used to seed the simulated sparkline. */
  memBase?: number;
  /** Estimated $/hr for this workload. Used for the fleet cost rollup. */
  costHr?: number;
}

export interface ClusterNode {
  name: string;
  region: string;
  availability_zone: string;
  running_vms: number;
  free_vcpu_millis: number;
  free_memory_bytes: number;
  // Totals are present in the demo summary; the live endpoint may omit them,
  // in which case the capacity map falls back to "free only" rendering.
  total_vcpu_millis?: number;
  total_memory_bytes?: number;
  draining: boolean;
}

export interface ClusterSummary {
  total_vms_running: number;
  total_vms_pending: number;
  nodes: ClusterNode[];
  warm_pool?: {
    available: number;
    target: number;
    regions?: Record<string, number>;
  };
}
