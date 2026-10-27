"use client";

import { useEffect, useState } from "react";

// A replay of infra/firecracker/broker-e2e.sh, recorded on real Firecracker
// (docs/media/egress-broker-kvm.gif, tape in docs/media/tapes). Each row's
// request is the call the script makes; each `pass` is that step's PASS line,
// verbatim. Nothing here is invented — if the script changes, change this.
type Step = {
  req: React.ReactNode;
  chip: string;
  tone: "ok" | "no" | "info";
  pass: string;
};

const STEPS: Step[] = [
  {
    req: (
      <>
        <span className="dim">$ </span>cat /proc/net/dev
      </>
    ),
    chip: "no NIC",
    tone: "info",
    pass: "exec works over host-initiated vsock; guest /proc/net/dev lists no eth0",
  },
  {
    req: (
      <>
        <span className="dim">http_fetch </span>https://httpbin.org/hidden-basic-auth/…
        <br />
        <span className="dim">Authorization: Basic </span>placeholder
      </>
    ),
    chip: "200",
    tone: "ok",
    pass: "HTTPS to httpbin.org: broker injected the credential, upstream authenticated (guest saw only 'placeholder')",
  },
  {
    req: (
      <>
        <span className="dim">http_fetch </span>http://httpbin.org:443/hidden-basic-auth/…
      </>
    ),
    chip: "403",
    tone: "no",
    pass: "H1: plain-HTTP to httpbin.org:443 refused (403) — no cleartext credential",
  },
  {
    req: (
      <>
        <span className="dim">http_fetch </span>https://httpbin.org/hidden-basic-auth/…
        <br />
        <span className="dim">Host: </span>evil.example
      </>
    ),
    chip: "403",
    tone: "no",
    pass: "M1: injected request with Host: evil.example refused (403) before the secret was resolved",
  },
  {
    req: (
      <>
        <span className="dim">http_fetch </span>https://example.com/
      </>
    ),
    chip: "denied",
    tone: "no",
    pass: "non-allowlisted host denied by the broker (deny audited)",
  },
  {
    req: (
      <>
        <span className="dim">$ </span>grep &lt;credential&gt; manager.log
      </>
    ),
    chip: "absent",
    tone: "ok",
    pass: "credential value absent from the manager log",
  },
];

const FINAL = "ALL BROKER-MODE ASSERTIONS PASSED (vm 3a0af970-2004-43ce-88c2-c5dbcc5d5374)";
const TICK_MS = 1700;

export function BrokerDemo({ recording }: { recording: string }) {
  // step = number of rows revealed; STEPS.length + 1 shows the final line too.
  const [step, setStep] = useState(STEPS.length + 1);
  const [anim, setAnim] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setAnim(true);
    setStep(1);
  }, []);

  useEffect(() => {
    if (!anim || paused) return;
    // Hold on the finished run before replaying.
    const wait = step > STEPS.length ? 5200 : TICK_MS;
    const t = setTimeout(() => setStep((s) => (s > STEPS.length ? 1 : s + 1)), wait);
    return () => clearTimeout(t);
  }, [anim, paused, step]);

  const state = (i: number) => (i + 1 < step ? "done" : i + 1 === step ? "live" : "hidden");

  return (
    <figure className="console" data-anim={anim ? "on" : "off"} aria-labelledby="console-cap">
      <div className="console-flame" aria-hidden="true" />
      <div className="console-bar">
        <span>broker-e2e.sh</span>
        <span>Firecracker 1.15.1, LANTERN_EGRESS_MODE=broker</span>
      </div>
      <div className="console-cols" aria-hidden="true">
        <span>Agent code, inside the microVM</span>
        <span />
        <span>Host broker</span>
      </div>
      <div className="console-body">
        <div className="console-wall" aria-hidden="true" />
        <ol aria-label="Requests from the VM and what the host broker did">
          {STEPS.map((s, i) => (
            <li key={i} className="row" data-state={state(i)}>
              <div className="req">{s.req}</div>
              <div className="packet-lane" aria-hidden="true">
                <span key={step} className={`packet ${s.tone === "no" ? "deny" : ""}`} />
              </div>
              <div className="verdict">
                <span className={`chip chip-${s.tone}`}>{s.chip}</span>
                <span className="pass">{s.pass}</span>
              </div>
            </li>
          ))}
        </ol>
        <p className="console-final" data-state={step > STEPS.length ? "done" : "hidden"}>
          PASS: {FINAL}
        </p>
      </div>
      <figcaption id="console-cap" className="console-foot">
        <span>
          A replay of a real run on Lima nested KVM. Requests are the script&rsquo;s; results are its PASS lines.{" "}
          <a href={recording}>Watch the recording</a>
        </span>
        {anim && (
          <button type="button" className="console-btn" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? "Play" : "Pause"}
          </button>
        )}
      </figcaption>
    </figure>
  );
}
