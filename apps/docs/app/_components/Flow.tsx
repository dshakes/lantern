// A clean vertical flow — a few labelled stages with connectors. Built for
// glanceability (no tiny text, no thirty boxes).
export function Flow({ steps }: { steps: { name: string; sub: string }[] }) {
  return (
    <div className="flow">
      {steps.map((s, i) => (
        <div key={s.name} className="flow-step">
          <div className="flow-node">
            <div className="flow-name">{s.name}</div>
            <div className="flow-sub">{s.sub}</div>
          </div>
          {i < steps.length - 1 ? <div className="flow-arrow" aria-hidden="true">↓</div> : null}
        </div>
      ))}
    </div>
  );
}
