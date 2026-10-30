import { useEffect, useState } from "react";
import "./interactive.css";
import { GH } from "../../../repo.config.mjs";

// Ported from the old landing page. Three steps of infra/firecracker/broker-e2e.sh,
// recorded on real Firecracker (docs/media/egress-broker-kvm.gif), told in plain
// words. Each row cites the PASS line it paraphrases; if the script changes, change this.
const STEPS = [
  {
    // PASS: exec works over host-initiated vsock; guest /proc/net/dev lists no eth0
    ask: "Looks for a network card", chip: "none", tone: "info",
    verdict: "The VM has no network device. Its only way out is a socket to the host.",
  },
  {
    // PASS: HTTPS to httpbin.org: broker injected the credential, upstream authenticated (guest saw only 'placeholder')
    ask: "Calls an API with the key “placeholder”", chip: "200", tone: "ok",
    verdict: "The host swapped in the real credential. The API accepted it; the agent only ever saw “placeholder”.",
  },
  {
    // PASS: H1: plain-HTTP to httpbin.org:443 refused (403) — no cleartext credential
    ask: "Sends the same call over plain HTTP", chip: "403", tone: "no",
    verdict: "Refused by the host. A credential never leaves unencrypted.",
  },
] as const;

const TICK_MS = 2200;
const RECORDING = `${GH}/blob/master/docs/media/egress-broker-kvm.gif`;

export function BrokerDemo() {
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
    <figure className="ix bd not-content" data-anim={anim ? "on" : "off"} aria-labelledby="bd-cap">
      <div className="bd-glow" aria-hidden="true" />
      <div className="bd-bar">
        <span>Recorded on a real Firecracker VM, opt-in broker mode</span>
        {anim && (
          <button type="button" className="ix-btn" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? "▶ Play" : "❚❚ Pause"}
          </button>
        )}
      </div>
      <div className="bd-cols" aria-hidden="true">
        <span>The agent’s code</span>
        <span />
        <span>What the host did</span>
      </div>
      <div className="bd-body">
        <div className="bd-wall" aria-hidden="true" />
        <ol aria-label="What the agent's code tried, and what the host did">
          {STEPS.map((s, i) => (
            <li key={s.ask} className="bd-row" data-state={state(i)}>
              <div className="bd-req">{s.ask}</div>
              <div className="bd-lane" aria-hidden="true">
                <span key={step} className={`bd-packet${s.tone === "no" ? " deny" : ""}`} />
              </div>
              <div className="bd-verdict">
                <span className={`bd-chip c-${s.tone}`}>{s.chip}</span>
                <span className="bd-pass">{s.verdict}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <figcaption id="bd-cap" className="bd-foot">
        <span>Every broker check in the run passed. Replayed from the test’s own output.</span>
        <a href={RECORDING} target="_blank" rel="noreferrer">Watch the recording ›</a>
      </figcaption>
    </figure>
  );
}
