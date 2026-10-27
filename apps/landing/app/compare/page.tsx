import { Check, Minus, X } from "lucide-react";
import type { Metadata } from "next";
import { LanternMark } from "../_components/Logo";
import { Footer, GITHUB, Nav, wrap } from "../_components/site";

export const metadata: Metadata = {
  title: "How Lantern compares: Google ACE, E2B, Modal",
  description:
    "Managed sandboxes versus a self-hosted agent runtime. On sandbox isolation Google ACE leads by default; Lantern adds durable runs, budgets, routing and receipts, in your own cloud.",
};

type Cell = string;
type Row = { row: string; cells: [Cell, Cell, Cell, Cell] };
// Mirrors README "How Lantern compares": ACE leads on the sandbox; the platform half is out of its scope.
const SANDBOX: Row[] = [
  { row: "Hardware-isolated microVM per sandbox", cells: ["yes: Firecracker / Kata", "yes", "yes", "partial: gVisor"] },
  { row: "Agent loop runs outside the sandbox", cells: ["yes", "yes", "partial: you host the loop", "partial: you host the loop"] },
  { row: "Credentials never enter the sandbox", cells: ["partial: broker mode, opt-in", "yes: by default", "no", "no"] },
  { row: "Egress allowlist enforced outside the guest", cells: ["partial: broker mode, opt-in", "yes: by default", "partial", "partial: IP/CIDR"] },
  { row: "Idle auto-suspend, resume on demand", cells: ["yes", "yes", "partial", "partial"] },
  { row: "Snapshot and fork", cells: ["yes: shared-memory fork", "yes", "partial", "partial"] },
  { row: "Hardware root of trust / attestation", cells: ["partial: measurement recorded, not verified", "yes: Titan", "no", "no"] },
  { row: "Proven at scale", cells: ["Lima nested-KVM + CI only", "The infrastructure behind Gemini's agents (per Google)", "Production", "Production"] },
];
const PLATFORM: Row[] = [
  { row: "Durable agent runs with crash-resume", cells: ["yes", "out of scope", "no", "no"] },
  {
    row: "Budgets that return HTTP 402 before the model call",
    cells: ["partial: cost/day, runs/day, tenant daily cost; token and per-tool limits stored, not enforced", "out of scope", "no", "partial"],
  },
  { row: "Multi-provider model routing with failover", cells: ["yes", "out of scope", "no", "no"] },
  { row: "Signed, offline-verifiable run receipts", cells: ["partial: only with a signing key configured", "out of scope", "no", "no"] },
  { row: "Self-host in your VPC or on-prem", cells: ["yes: Apache-2.0", "no: Google Cloud only", "partial", "no"] },
  { row: "Availability", cells: ["Open source today", "Preview \u201cin the coming months\u201d", "Generally available", "Generally available"] },
];

function Mark({ c }: { c: Cell }) {
  if (c === "yes" || c.startsWith("yes: "))
    return (
      <span className="inline-flex items-start gap-1.5 text-patina">
        <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className={c === "yes" ? "sr-only" : "text-xs text-ink-2"}>{c === "yes" ? "Yes" : c.slice(5)}</span>
      </span>
    );
  if (c === "no" || c.startsWith("no: "))
    return (
      <span className="inline-flex items-start gap-1.5 text-ink-3">
        <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className={c === "no" ? "sr-only" : "text-xs text-ink-2"}>{c === "no" ? "No" : c.slice(4)}</span>
      </span>
    );
  if (!c.startsWith("partial")) return <span className="text-xs text-ink-2">{c}</span>;
  const note = c.startsWith("partial: ") ? c.slice(9) : "Partial";
  return (
    <span className="inline-flex items-start gap-1.5 text-flame">
      <Minus className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="text-xs text-ink-2">
        <span className="sr-only">Partial: </span>
        {note}
      </span>
    </span>
  );
}

const COLS = ["Lantern", "Google Agent Compute Engine", "E2B", "Modal"];

function CompareTable({ id, title, intro, rows }: { id: string; title: string; intro: string; rows: Row[] }) {
  return (
    <div className="mt-14">
      <h2 id={id} className="font-display text-2xl font-bold tracking-tight text-ink">
        {title}
      </h2>
      <p className="mt-2 max-w-3xl leading-relaxed text-ink-2">{intro}</p>
      <div className="mt-6 overflow-x-auto rounded-[var(--lx-radius-l)] border border-line bg-surface" tabIndex={0} role="region" aria-labelledby={id}>
        <table className="w-full min-w-[760px] text-left text-sm">
          <caption className="sr-only">{title}: Lantern, Google Agent Compute Engine, E2B and Modal</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="w-[26%] p-4">
                <span className="sr-only">Capability</span>
              </th>
              {COLS.map((c, n) => (
                <th
                  key={c}
                  scope="col"
                  className={`w-[18.5%] p-4 align-bottom font-semibold ${n === 0 ? "bg-glass-soft font-display text-base text-ink" : "text-ink-2"}`}
                >
                  {n === 0 ? (
                    <span className="flex items-center gap-2">
                      <LanternMark className="h-5 w-5" /> {c}
                    </span>
                  ) : (
                    c
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.row}>
                <th scope="row" className="p-4 font-normal text-ink">
                  {r.row}
                </th>
                {r.cells.map((c, n) => (
                  <td key={n} className={`p-4 align-top ${n === 0 ? "bg-glass-soft" : ""}`}>
                    <Mark c={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ComparePage() {
  const picks = [
    { who: "Google ACE", when: "if you want a managed sandbox on Google Cloud with the strongest isolation defaults." },
    { who: "E2B or Modal", when: "if you want hosted sandboxes today." },
    {
      who: "Lantern",
      when: "if you need to run agents in your own cloud or on-prem, with the sandbox, durable execution, spend limits and audit trail in one stack you control.",
    },
  ];
  return (
    <div className="min-h-screen">
      <Nav />
      <main id="main" className="section !pt-14 md:!pt-20">
      <div className={wrap}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end">
          <h1 id="compare-h" className="h2">
            How Lantern compares.
          </h1>
          <p className="lede lg:justify-self-end">
            Google Agent Compute Engine, E2B and Modal are managed sandboxes: compute you rent to run agent code. Lantern
            is an open-source agent runtime you host yourself, and its sandbox is one part of it. So the comparison has
            two halves.
          </p>
        </div>
        <CompareTable
          id="cmp-sandbox"
          title="The sandbox"
          intro="This is ACE's whole product, and on isolation it is ahead of Lantern by default: its sandbox never holds a credential and all egress leaves through a proxy on the host, backed by Google's hardware root of trust. Lantern can do the same only in its opt-in broker mode on Firecracker, validated on nested KVM, not at Google's scale."
          rows={SANDBOX}
        />
        <CompareTable
          id="cmp-platform"
          title="The platform around it"
          intro="These are agent-runtime features. ACE is a compute layer, so &ldquo;out of scope&rdquo; means it isn't trying to do them, not that it fails at them; on Google Cloud they come from other products."
          rows={PLATFORM}
        />
        <div className="mt-14">
          <h2 className="font-display text-2xl font-bold tracking-tight text-ink">When to pick which</h2>
          <ul className="mt-4 grid grid-cols-1 gap-x-10 gap-y-4 md:grid-cols-3">
            {picks.map((p) => (
              <li key={p.who} className="border-t border-line pt-4 leading-relaxed text-ink-2">
                <span className="font-semibold text-ink">Pick {p.who}</span> {p.when}
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-10 max-w-3xl text-sm leading-relaxed text-ink-3">
          Competitor columns reflect each vendor&rsquo;s public docs and announcements as of October 2026; the Google
          column follows Google&rsquo;s{" "}
          <a className="link" href="https://cloud.google.com/blog/topics/ai-infrastructure/agent-compute-engine-deep-dive">
            Agent Compute Engine deep dive
          </a>{" "}
          (Oct 22, 2026). A cross means not offered or not announced. If a cell is out of date,{" "}
          <a className="link" href={`${GITHUB}/issues`}>
            open an issue
          </a>
          .
        </p>
      </div>
      </main>
      <Footer />
    </div>
  );
}
