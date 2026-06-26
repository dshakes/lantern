import Link from "next/link";
import {
  Radar,
  Brain,
  Workflow,
  Mic2,
  Send,
  ShieldCheck,
  MessagesSquare,
} from "lucide-react";

type Cell = { name: string; sub: string; href: string };

function Cells({ items }: { items: Cell[] }) {
  return (
    <div className="harness-cells">
      {items.map((c) => (
        <Link key={c.name} href={c.href} className="harness-cell">
          <b>{c.name}</b>
          <span>{c.sub}</span>
        </Link>
      ))}
    </div>
  );
}

type LayerProps = {
  tone: "sky" | "amber" | "violet" | "emerald";
  icon: React.ReactNode;
  num: string;
  title: string;
  tagline: string;
  items: Cell[];
  emphasis?: boolean;
  substrate?: string;
};

function Layer({ tone, icon, num, title, tagline, items, emphasis, substrate }: LayerProps) {
  return (
    <div className={`harness-layer harness-${tone}${emphasis ? " harness-emph" : ""}`}>
      <div className="harness-layer-head">
        <span className="harness-layer-icon">{icon}</span>
        <span className="harness-layer-num">{num}</span>
        <span className="harness-layer-title">{title}</span>
        <span className="harness-layer-tag">{tagline}</span>
        {emphasis && <span className="harness-store-pill">cross-app store</span>}
      </div>
      <Cells items={items} />
      {substrate && <div className="harness-substrate-note">{substrate}</div>}
    </div>
  );
}

// The personal harness as a layered architecture: surfaces at the ingress edge,
// five product layers (sense → remember → reason → sound-like-you → act), a
// cross-cutting safety rail, and the control-plane substrate underneath.
// Every cell links to its on-page section or its docs.
export function PersonalHarnessArchitecture() {
  return (
    <div className="harness">
      {/* Top edge — surfaces (ingress / egress) */}
      <div className="harness-edge">
        <div className="harness-edge-label">
          <MessagesSquare className="h-3.5 w-3.5 text-sky-300" />
          Surfaces · ingress &amp; egress
        </div>
        <div className="harness-edge-cells">
          {["iMessage", "WhatsApp", "Voice", "Email", "Webchat"].map((s) => (
            <Link key={s} href="/surfaces" className="harness-surface">{s}</Link>
          ))}
        </div>
      </div>

      {/* The body: stacked layers + a safety rail alongside */}
      <div className="harness-body">
        <div className="harness-stack">
          <Layer
            tone="sky"
            icon={<Radar className="h-4 w-4" />}
            num="L1 · Sense"
            title="Signals & Ingestion"
            tagline="what's actually happening"
            items={[
              { name: "Device signals", sub: "location · focus · driving · health · media", href: "#signals" },
              { name: "Screen & app-usage", sub: "on-device · owner-only", href: "#signals" },
              { name: "Inbox ingestion", sub: "email → life-events", href: "#signals" },
              { name: "Inbound messages", sub: "every channel, every turn", href: "#signals" },
            ]}
          />

          <Layer
            tone="amber"
            emphasis
            icon={<Brain className="h-4 w-4" />}
            num="L2 · Remember"
            title="Cross-app Memory & Identity"
            tagline="one self across every channel"
            substrate="Substrate: local 0600 JSONL on the Mac + control-plane Postgres (RLS, encrypted at rest)."
            items={[
              { name: "Person graph", sub: "one canonical identity across channels", href: "#memory" },
              { name: "Episodic memory", sub: "14-day: date · topic · outcome", href: "#memory" },
              { name: "Topic index", sub: "7-day cross-thread recall", href: "#memory" },
              { name: "Owner profile", sub: "facts · relationships · style lessons", href: "#memory" },
              { name: "Presence", sub: "live availability, cross-bridge", href: "#memory" },
              { name: "Life-events ledger", sub: "bills · deliveries · travel · fraud", href: "#memory" },
            ]}
          />

          <Layer
            tone="violet"
            icon={<Workflow className="h-4 w-4" />}
            num="L3 · Reason"
            title="Decisioning & Orchestration"
            tagline="decide what to do"
            items={[
              { name: "Life-event engine", sub: "classify + extract", href: "#reason" },
              { name: "Auto-act ladder", sub: "safe-auto · ask · never", href: "#reason" },
              { name: "Availability concierge", sub: "presence → contact replies", href: "#reason" },
              { name: "Anticipation", sub: "proactive nudges", href: "#reason" },
              { name: "Scheduling", sub: "propose · hold · confirm", href: "#reason" },
            ]}
          />

          <Layer
            tone="emerald"
            icon={<Mic2 className="h-4 w-4" />}
            num="L4 · Sound like you"
            title="Persona & Authenticity"
            tagline="indistinguishable from you"
            items={[
              { name: "Owner-voice", sub: "mined from real sent messages", href: "#persona" },
              { name: "Language & dialect", sub: "your modality, never invented", href: "#persona" },
              { name: "Bot-tell guards", sub: "suppress + regenerate", href: "#persona" },
              { name: "Pacing", sub: "real per-contact latency", href: "#persona" },
              { name: "Draft-and-confirm", sub: "+ claim verifier", href: "#persona" },
            ]}
          />

          <Layer
            tone="sky"
            icon={<Send className="h-4 w-4" />}
            num="L5 · Act"
            title="Actions & Delivery"
            tagline="follow through, for real"
            items={[
              { name: "Reply send", sub: "paced · per-channel", href: "#actions" },
              { name: "Mac actions", sub: "Calendar · Notes · Mail", href: "#actions" },
              { name: "Connectors", sub: "Gmail · Calendar · …", href: "#actions" },
              { name: "Voice calls", sub: "Twilio · LiveKit", href: "#actions" },
            ]}
          />
        </div>

        {/* Cross-cutting safety & privacy rail */}
        <Link href="#safety" className="harness-rail">
          <div className="harness-rail-head">
            <ShieldCheck className="h-4 w-4 text-rose-300" />
            <span>Safety &amp; Privacy</span>
            <span className="harness-rail-sub">runs alongside every layer</span>
          </div>
          <ul className="harness-rail-list">
            <li>Owner-only enforcement</li>
            <li>Location-leak guard</li>
            <li>Kill switch</li>
            <li>Local 0600 / path-restricted</li>
            <li>Secrets never logged</li>
          </ul>
        </Link>
      </div>

      {/* Bottom substrate — control plane */}
      <div className="harness-base">
        <div className="harness-base-label">Control plane</div>
        <div className="harness-base-cells">
          <Link href="/models" className="harness-base-cell">Model router <span>capability-routed LLM</span></Link>
          <Link href="/api" className="harness-base-cell">/v1/people</Link>
          <Link href="/api" className="harness-base-cell">/v1/memory</Link>
          <Link href="/api" className="harness-base-cell">/v1/signals</Link>
          <Link href="/api" className="harness-base-cell">/v1/life-events</Link>
          <Link href="/connectors" className="harness-base-cell">connectors</Link>
        </div>
      </div>
    </div>
  );
}
