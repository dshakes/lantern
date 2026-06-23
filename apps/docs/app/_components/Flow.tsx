import type { LucideIcon } from "lucide-react";

type Step = { name: string; sub: string; icon?: LucideIcon };

// A polished vertical timeline — a continuous line, icon nodes, compact content.
export function Flow({ steps }: { steps: Step[] }) {
  return (
    <div className="flow">
      {steps.map((s, i) => {
        const Icon = s.icon;
        return (
          <div key={s.name} className="flow-step">
            <div className="flow-dot">
              {Icon ? <Icon className="h-4 w-4" /> : <span>{i + 1}</span>}
            </div>
            <div className="flow-body">
              <div className="flow-name">{s.name}</div>
              <div className="flow-sub">{s.sub}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
