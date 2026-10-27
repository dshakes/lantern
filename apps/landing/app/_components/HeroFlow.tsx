"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

// The hero diagram: one 8s loop of a tool call crossing the system.
//   0–2s  the agent loop calls a tool; ExecTool reaches the workload
//   2–4s  the workload asks for the network; harness → vsock → host broker
//   4–6s  the broker injects the credential and forwards upstream
//   6–8s  a request to a host not on the allowlist is refused
// SMIL drives the packets. The step captions are buttons: choosing one pauses
// the loop on that step; Play resumes it. With prefers-reduced-motion the loop
// starts paused on step 3 (credential just injected) and nothing moves.

type Box = { x: number; y: number; w: number; h: number };
type Layout = {
  id: string;
  vb: string;
  cp: Box;
  host: Box;
  vm: Box;
  loop: Box;
  router: Box;
  manager: Box;
  broker: Box;
  harness: Box;
  workload: Box;
  upstream: Box;
  denied: Box;
  p1: string;
  p2: string;
  p3: string;
  p4: string;
  vsock: [number, number];
};

const WIDE: Layout = {
  id: "w",
  vb: "0 0 1080 400",
  cp: { x: 16, y: 36, w: 258, h: 330 },
  host: { x: 298, y: 36, w: 528, h: 330 },
  vm: { x: 520, y: 70, w: 284, h: 272 },
  loop: { x: 38, y: 90, w: 214, h: 72 },
  router: { x: 38, y: 250, w: 214, h: 72 },
  manager: { x: 320, y: 90, w: 170, h: 72 },
  broker: { x: 320, y: 250, w: 170, h: 72 },
  harness: { x: 545, y: 106, w: 234, h: 62 },
  workload: { x: 545, y: 230, w: 234, h: 86 },
  upstream: { x: 862, y: 90, w: 200, h: 72 },
  denied: { x: 862, y: 250, w: 200, h: 72 },
  p1: "M252 126 H662 V230",
  p2: "M620 230 V146 H508 V286 H490",
  p3: "M405 322 V350 H842 V126 H862",
  p4: "M620 230 V146 H508 V286 H490 M405 322 V350 H842 V286 H862",
  vsock: [512, 214],
};

const TALL: Layout = {
  id: "t",
  vb: "0 0 400 760",
  cp: { x: 12, y: 16, w: 376, h: 140 },
  host: { x: 12, y: 182, w: 376, h: 436 },
  vm: { x: 28, y: 330, w: 344, h: 268 },
  loop: { x: 28, y: 56, w: 166, h: 72 },
  router: { x: 206, y: 56, w: 166, h: 72 },
  manager: { x: 28, y: 222, w: 166, h: 72 },
  broker: { x: 206, y: 222, w: 166, h: 72 },
  harness: { x: 50, y: 368, w: 300, h: 62 },
  workload: { x: 50, y: 488, w: 300, h: 86 },
  upstream: { x: 28, y: 668, w: 166, h: 72 },
  denied: { x: 206, y: 668, w: 166, h: 72 },
  p1: "M111 128 V488",
  p2: "M290 488 V294",
  p3: "M372 258 H394 V648 H111 V668",
  p4: "M290 488 V294 M372 258 H394 V656 H290 V668",
  vsock: [300, 316],
};

function Node({ b, cls, title, sub, mono }: { b: Box; cls: string; title: string; sub: string; mono?: boolean }) {
  return (
    <g>
      <rect className={cls} x={b.x} y={b.y} width={b.w} height={b.h} rx={10} />
      <text className="t-h" x={b.x + 14} y={b.y + 30}>
        {title}
      </text>
      <text className={mono ? "t-b mono" : "t-b"} x={b.x + 14} y={b.y + 52}>
        {sub}
      </text>
    </g>
  );
}

function Packet({ path, cls, times, points, show }: { path: string; cls: string; times: string; points: string; show: [string, string] }) {
  return (
    <circle r={6} className={cls} opacity={0}>
      <animateMotion dur="8s" repeatCount="indefinite" calcMode="linear" keyTimes={times} keyPoints={points}>
        <mpath href={`#${path}`} />
      </animateMotion>
      <animate attributeName="opacity" dur="8s" repeatCount="indefinite" calcMode="discrete" values={show[0]} keyTimes={show[1]} />
    </circle>
  );
}

function Flow({ L, className, svgRef }: { L: Layout; className: string; svgRef: RefObject<SVGSVGElement | null> }) {
  const pid = (n: string) => `hero-${L.id}-${n}`;
  const { workload: wl } = L;
  return (
    <svg ref={svgRef} viewBox={L.vb} className={`fx w-full ${className}`} role="img" aria-labelledby={pid("title")}>
      <title id={pid("title")}>
        A tool call from the agent loop reaches untrusted code inside a microVM. The code&apos;s network request leaves
        over vsock to a host broker, which adds the credential and forwards it upstream; a request to a host not on the
        allowlist is refused.
      </title>

      <rect className="zone" x={L.cp.x} y={L.cp.y} width={L.cp.w} height={L.cp.h} rx={18} />
      <text className="t-s" x={L.cp.x + 16} y={L.cp.y + 22}>
        Your control plane
      </text>
      <rect className="zone" x={L.host.x} y={L.host.y} width={L.host.w} height={L.host.h} rx={18} />
      <text className="t-s" x={L.host.x + 16} y={L.host.y + 22}>
        Data-plane host
      </text>

      <path id={pid("p1")} className="edge" d={L.p1} />
      {/* broker mode path (opt-in) */}
      <path id={pid("p2")} className="edge-flame" d={L.p2} />
      <path id={pid("p3")} className="edge-patina" d={L.p3} />
      <path id={pid("p4")} className="edge-deny" d={L.p4} />

      <Node b={L.loop} cls="node" title="Agent loop" sub="workflow, journal" />
      <Node b={L.router} cls="node" title="Model router" sub="LLM calls leave here" />
      <Node b={L.manager} cls="node-host" title="runtime-manager" sub="ExecTool" mono />
      {/* host broker — opt-in broker mode (LANTERN_EGRESS_MODE=broker) */}
      <Node b={L.broker} cls="node-host" title="Host broker (opt-in)" sub="allowlist + credential" />

      <rect className="wall" x={L.vm.x} y={L.vm.y} width={L.vm.w} height={L.vm.h} rx={18} />
      <text className="t-h t-glass" x={L.vm.x + 16} y={L.vm.y + L.vm.h - 12}>
        microVM
      </text>
      {/* no network device in broker mode only */}
      <text className="t-s" x={L.vm.x + L.vm.w - 16} y={L.vm.y + L.vm.h - 12} textAnchor="end">
        no network device (broker mode)
      </text>
      <Node b={L.harness} cls="node" title="harness, PID 1" sub="127.0.0.1:3128" mono />
      <g>
        <rect className="node-guest" x={wl.x} y={wl.y} width={wl.w} height={wl.h} rx={10} />
        <path
          className="flame"
          transform={`translate(${wl.x + wl.w - 44} ${wl.y + 20}) scale(1.6)`}
          d="M12 0c1.9 2 3 3.6 3 5.4a3 3 0 0 1-6 0c0-1.2.6-2.1 1.4-2.9.1 1 .6 1.6 1.2 1.8-.4-1.4-.1-2.8.4-4.3Z"
        />
        <text className="t-h" x={wl.x + 14} y={wl.y + 32}>
          Untrusted code
        </text>
        <text className="t-b mono" x={wl.x + 14} y={wl.y + 56}>
          pip install, curl, git
        </text>
      </g>

      {/* vsock channel — broker mode only */}
      <text className="t-s mono t-glass" x={L.vsock[0]} y={L.vsock[1]} textAnchor={L.id === "w" ? "end" : "start"}>
        vsock
      </text>

      <Node b={L.upstream} cls="node" title="api.github.com" sub="allowed, token added" />
      <Node b={L.denied} cls="node-deny" title="paste.example" sub="refused, audited" />

      {/* broker highlight at the moment the credential is injected (opt-in broker mode) */}
      <rect
        x={L.broker.x - 4}
        y={L.broker.y - 4}
        width={L.broker.w + 8}
        height={L.broker.h + 8}
        rx={13}
        fill="none"
        stroke="var(--lx-patina)"
        strokeWidth={2.5}
        opacity={0}
      >
        <animate attributeName="opacity" dur="8s" repeatCount="indefinite" calcMode="discrete" values="0;1;0" keyTimes="0;0.5;0.62" />
      </rect>

      <Packet path={pid("p1")} cls="pk-ink" times="0;0.25;1" points="0;1;1" show={["1;0", "0;0.25"]} />
      {/* broker mode packets */}
      <Packet path={pid("p2")} cls="pk-flame" times="0;0.25;0.5;1" points="0;0;1;1" show={["0;1;0", "0;0.25;0.5"]} />
      <Packet path={pid("p3")} cls="pk-patina" times="0;0.5;0.75;1" points="0;0;1;1" show={["0;1;0", "0;0.5;0.75"]} />
      <Packet path={pid("p4")} cls="pk-signal" times="0;0.75;1" points="0;0;1" show={["0;1", "0;0.75"]} />
    </svg>
  );
}

// Steps 2–4 describe the opt-in broker mode (LANTERN_EGRESS_MODE=broker, Firecracker only).
const STEPS = [
  { cap: "var(--lx-ink)", title: "The loop calls a tool", body: "The agent loop stays on your control plane. ExecTool hands the step to the runtime-manager." },
  { cap: "var(--lx-flame)", title: "The code asks for the network (broker mode)", body: "In broker mode the workload uses 127.0.0.1:3128. The harness carries the request over vsock to the host — the VM has no network device." },
  { cap: "var(--lx-patina)", title: "The host adds the credential (broker mode)", body: "The broker resolves the lantern.secret ref and injects it. The VM never holds the token." },
  { cap: "var(--lx-signal)", title: "Everything else is refused", body: "Hosts off the sandbox allowlist are denied and written to the audit stream." },
];

const STEP_S = 2;
const LOOP_S = 8;
// Seek a little into each 2 s step so its packet (and, on step 3, the broker highlight) is visible.
const seekTime = (i: number) => i * STEP_S + 0.6;

export function HeroFlow({ explore }: { explore: string }) {
  const wide = useRef<SVGSVGElement>(null);
  const tall = useRef<SVGSVGElement>(null);
  const [playing, setPlaying] = useState(true);
  const [step, setStep] = useState(0);

  const svgs = () => [wide.current, tall.current].filter((s): s is SVGSVGElement => !!s);
  const pauseOn = (i: number) => {
    svgs().forEach((s) => {
      s.setCurrentTime(seekTime(i));
      s.pauseAnimations();
    });
    setStep(i);
    setPlaying(false);
  };
  const play = () => {
    svgs().forEach((s) => s.unpauseAnimations());
    setPlaying(true);
  };

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) pauseOn(2);
    // Mount-only: honour the motion preference once.
  }, []);

  // While playing, follow the SMIL clock so the caption under the moving packet is the highlighted one.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const s = svgs().find((v) => v.getBoundingClientRect().width > 0);
      if (s) setStep(Math.floor((s.getCurrentTime() % LOOP_S) / STEP_S));
    }, 200);
    return () => clearInterval(id);
  }, [playing]);

  return (
    <figure>
      <Flow L={WIDE} className="hidden md:block" svgRef={wide} />
      <Flow L={TALL} className="md:hidden mx-auto max-w-[420px]" svgRef={tall} />
      <figcaption className="mt-6">
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4" role="group" aria-label="Steps of the tool call">
          {STEPS.map((s, i) => (
            <button
              key={s.title}
              type="button"
              className="step-cap self-start pt-3 text-left"
              aria-pressed={step === i}
              onClick={() => pauseOn(i)}
              style={{ ["--cap" as string]: s.cap }}
            >
              <span className="block font-medium">{s.title}</span>
              <span className="mt-1 block text-sm text-ink-2">{s.body}</span>
            </button>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-quiet !py-1.5 text-sm" onClick={playing ? () => pauseOn(step) : play} aria-pressed={!playing}>
            {playing ? "Pause" : "Play"}
          </button>
          <a href={explore} className="btn btn-quiet !py-1.5 text-sm">
            Explore the full architecture
          </a>
        </div>
      </figcaption>
    </figure>
  );
}
