// A clean, glanceable "how it works" diagram — three ideas, not thirty.
// Control plane (Lantern's cloud) drives your VPC over an outbound-only tunnel;
// agents execute in your cloud and only metadata flows back.
export function ArchHome() {
  return (
    <div className="arch">
      <div className="arch-row">
        <div className="arch-node arch-cp">
          <div className="arch-kicker">Control plane</div>
          <div className="arch-name">Lantern cloud</div>
          <div className="arch-sub">Schedules, routes models, observes — never touches your code.</div>
        </div>

        <div className="arch-link">
          <span className="arch-link-label">outbound-only tunnel</span>
          <span className="arch-link-sub">metadata only</span>
        </div>

        <div className="arch-node arch-dp">
          <div className="arch-kicker">Data plane</div>
          <div className="arch-name">Your VPC</div>
          <div className="arch-sub">Agents execute here. Code, prompts, and data never leave.</div>
        </div>
      </div>
    </div>
  );
}
