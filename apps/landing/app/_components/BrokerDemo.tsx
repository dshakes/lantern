"use client";

import { useEffect, useState } from "react";

// Three steps of infra/firecracker/broker-e2e.sh, recorded on real Firecracker
// (docs/media/egress-broker-kvm.gif), told in plain words. Each row cites the
// PASS line it paraphrases; nothing here is invented — if the script changes,
// change this.
const STEPS = [
  {
    // PASS: exec works over host-initiated vsock; guest /proc/net/dev lists no eth0
    ask: "Looks for a network card",
    chip: "none",
    tone: "info",
    verdict: "The VM has no network device. Its only way out is a socket to the host.",
  },
  {
    // PASS: HTTPS to httpbin.org: broker injected the credential, upstream authenticated (guest saw only 'placeholder')
    ask: "Calls an API with the key “placeholder”",
    chip: "200",
    tone: "ok",
    verdict: "The host swapped in the real credential. The API accepted it; the agent only ever saw “placeholder”.",
  },
  {
    // PASS: H1: plain-HTTP to httpbin.org:443 refused (403) — no cleartext credential
    ask: "Sends the same call over plain HTTP",
    chip: "403",
    tone: "no",
    verdict: "Refused by the host. A credential never leaves unencrypted.",
  },
] as const;

const TICK_MS = 2200;

export function BrokerDemo({ recording }: { recording: string }) {
  // step = rows revealed; STEPS.length + 1 holds the finished run before replaying.
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
    const wait = step > STEPS.length ? 5000 : TICK_MS;
    const t = setTimeout(() => setStep((s) => (s > STEPS.length ? 1 : s + 1)), wait);
    return () => clearTimeout(t);
  }, [anim, paused, step]);

  const state = (i: number) => (i + 1 < step ? "done" : i + 1 === step ? "live" : "hidden");

  return (
    <figure className="console" data-anim={anim ? "on" : "off"} aria-labelledby="console-cap">
      <div className="console-flame" aria-hidden="true" />
      <div className="console-bar">
        <span>Recorded on a real Firecracker VM, opt-in broker mode</span>
        {anim && (
          <button type="button" className="console-btn" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? "Play" : "Pause"}
          </button>
        )}
      </div>
      <div className="console-cols" aria-hidden="true">
        <span>The agent&rsquo;s code</span>
        <span />
        <span>What the host did</span>
      </div>
      <div className="console-body">
        <div className="console-wall" aria-hidden="true" />
        <ol aria-label="What the agent's code tried, and what the host did">
          {STEPS.map((s, i) => (
            <li key={s.ask} className="row" data-state={state(i)}>
              <div className="req">{s.ask}</div>
              <div className="packet-lane" aria-hidden="true">
                <span key={step} className={`packet ${s.tone === "no" ? "deny" : ""}`} />
              </div>
              <div className="verdict">
                <span className={`chip chip-${s.tone}`}>{s.chip}</span>
                <span className="pass">{s.verdict}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <figcaption id="console-cap" className="console-foot">
        <span>Every broker check in the run passed. Replayed from the test&rsquo;s own output.</span>
        <a href={recording}>Watch the recording</a>
      </figcaption>
    </figure>
  );
}
