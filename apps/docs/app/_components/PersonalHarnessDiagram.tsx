import Link from "next/link";
import { Car, MapPin, SlidersHorizontal, Moon, User, Users } from "lucide-react";

// End-to-end "phone trigger → bot context" flow for the personal harness, in
// the same clickable system-context style as the home + runtime diagrams: the
// iPhone triggers, the token-gated control-plane hop over Tailscale, the local
// bridge that reads signals on-demand, and the two outcomes (you, and contacts).
export function PersonalHarnessDiagram() {
  return (
    <div className="sys">
      <div className="sys-actors">
        <Link href="#triggers" className="sys-actor">
          <Car className="h-4 w-4 text-sky-300" />
          <div>
            <div className="sys-actor-name">Drive</div>
            <div className="sys-actor-sub">CarPlay (Odyssey) · Bluetooth (Tesla)</div>
          </div>
        </Link>
        <Link href="#triggers" className="sys-actor">
          <MapPin className="h-4 w-4 text-emerald-300" />
          <div>
            <div className="sys-actor-name">Place</div>
            <div className="sys-actor-sub">arrive/leave Home · Office · Gym · Airport</div>
          </div>
        </Link>
        <Link href="#triggers" className="sys-actor">
          <SlidersHorizontal className="h-4 w-4 text-lantern-300" />
          <div>
            <div className="sys-actor-name">Status</div>
            <div className="sys-actor-sub">Action Button · NFC tag · Focus mode</div>
          </div>
        </Link>
        <Link href="#triggers" className="sys-actor">
          <Moon className="h-4 w-4 text-violet-300" />
          <div>
            <div className="sys-actor-name">Rhythm</div>
            <div className="sys-actor-sub">Sleep/Wake · low battery · now-playing · health</div>
          </div>
        </Link>
      </div>

      <div className="sys-conn"><span>iOS automation runs a Lantern Shortcut → POST</span></div>

      <div className="sys-boundary sys-cp">
        <div className="sys-tag">Control plane · reached over Tailscale</div>
        <div className="sys-grid">
          <a href="https://github.com/dshakes/lantern/blob/master/services/control-plane/internal/handlers/signals.go" target="_blank" rel="noopener noreferrer" className="sys-comp">
            <b>POST /v1/signals</b><span>token-gated · x-lantern-signal-token · fails closed</span>
          </a>
          <Link href="#pipeline" className="sys-comp">
            <b>device-signals.jsonl</b><span>append · chmod 0600 · owner-only · auto-trimmed</span>
          </Link>
        </div>
        <div className="sys-note">Private tailnet (Tailscale Serve) — never exposed to the public internet. A missing or wrong token is rejected.</div>
      </div>

      <div className="sys-tunnel"><span>↓ bridge reads on every owner turn · zero lag ↓</span></div>

      <div className="sys-boundary sys-dp">
        <div className="sys-tag sys-tag-dp">Your Mac · iMessage + WhatsApp bridge</div>
        <div className="sys-grid">
          <Link href="#bridge" className="sys-comp">
            <b>freshIphoneSignalsLine()</b><span>reads the signals file on-demand, in front of the LLM</span>
          </Link>
          <Link href="#bridge" className="sys-comp">
            <b>presence + summary</b><span>latest focus · device · location · health · media</span>
          </Link>
          <Link href="#bridge" className="sys-comp">
            <b>owner context</b><span>self-chat only · never a contact reply</span>
          </Link>
          <Link href="#concierge" className="sys-comp">
            <b>availability concierge</b><span>tells contacts if you&apos;re reachable — availability only</span>
          </Link>
        </div>
        <div className="sys-note">Your signals ground <strong>your own</strong> self-chat. The concierge shares only availability with contacts — never your location.</div>
      </div>

      <div className="sys-conn"><span>grounded, truthful reply</span></div>

      <div className="sys-actors">
        <Link href="#bridge" className="sys-actor">
          <User className="h-4 w-4 text-lantern-300" />
          <div>
            <div className="sys-actor-name">You · self-chat</div>
            <div className="sys-actor-sub">&ldquo;where am I&rdquo; · &ldquo;what have I been doing&rdquo; · &ldquo;am I free at 3?&rdquo;</div>
          </div>
        </Link>
        <Link href="#concierge" className="sys-actor">
          <Users className="h-4 w-4 text-sky-300" />
          <div>
            <div className="sys-actor-name">Contacts · DM you</div>
            <div className="sys-actor-sub">&ldquo;is he around?&rdquo; · &ldquo;when&apos;s he free?&rdquo; · take a message</div>
          </div>
        </Link>
      </div>
    </div>
  );
}
