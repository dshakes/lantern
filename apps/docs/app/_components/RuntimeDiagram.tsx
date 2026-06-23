import { Terminal } from "lucide-react";

// The headless-runtime execution path, in the same system-context style as the
// home diagram: an entry point, the two trust boundaries, and the labelled hop
// between them.
export function RuntimeDiagram() {
  return (
    <div className="sys">
      <div className="sys-actors single">
        <div className="sys-actor">
          <Terminal className="h-4 w-4 text-lantern-300" />
          <div>
            <div className="sys-actor-name">lantern run agent.yaml</div>
            <div className="sys-actor-sub">submit the spec — image · isolation · limits · egress · secrets</div>
          </div>
        </div>
      </div>

      <div className="sys-conn"><span>schedules</span></div>

      <div className="sys-boundary sys-cp">
        <div className="sys-tag">Control Plane · SaaS</div>
        <div className="sys-grid">
          <div className="sys-comp"><b>control-plane</b><span>RBAC + quota gate · 402 over quota</span></div>
          <div className="sys-comp"><b>runtime-scheduler</b><span>warm-pool · region · cost · health</span></div>
        </div>
        <div className="sys-note">Schedules the spec onto a node; never runs your workload itself.</div>
      </div>

      <div className="sys-tunnel"><span>↓ gRPC · authenticated tenant ↓</span></div>

      <div className="sys-boundary sys-dp">
        <div className="sys-tag sys-tag-dp">Your VPC · Data Plane</div>
        <div className="sys-grid">
          <div className="sys-comp"><b>runtime-manager</b><span>builds the pod · sets RuntimeClass</span></div>
          <div className="sys-comp"><b>Pod · RuntimeClass</b><span>runc · gVisor · Kata — by isolation tier</span></div>
          <div className="sys-comp"><b>harness (PID 1)</b><span>egress allowlist · secret vending · logs</span></div>
        </div>
        <div className="sys-note">The manager sets the isolation tier; the harness streams logs &amp; traces and vends short-TTL secrets.</div>
      </div>
    </div>
  );
}
