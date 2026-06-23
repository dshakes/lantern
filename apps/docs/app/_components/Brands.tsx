import Link from "next/link";
import {
  siWhatsapp, siDiscord, siTelegram, siImessage,
  siGithub, siGmail, siGoogle, siNotion, siLinear,
} from "simple-icons";
import { Phone, MessageCircle, type LucideIcon } from "lucide-react";

// Slack's mark was removed from simple-icons — inline it.
const SLACK_PATH =
  "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.685 8.834a2.528 2.528 0 0 1-2.522 2.521 2.527 2.527 0 0 1-2.521-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.522 2.522v6.312zM15.163 18.956a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.521-2.522v-2.522h2.521zM15.163 17.685a2.527 2.527 0 0 1-2.521-2.522 2.526 2.526 0 0 1 2.521-2.521h6.313A2.527 2.527 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.522h-6.313z";

type Brand = { path?: string; color: string; lucide?: LucideIcon };
const BRANDS: Record<string, Brand> = {
  WhatsApp: { path: siWhatsapp.path, color: "#25D366" },
  iMessage: { path: siImessage.path, color: "#34DA50" },
  Slack: { path: SLACK_PATH, color: "#e4e4e7" },
  Discord: { path: siDiscord.path, color: "#5865F2" },
  Telegram: { path: siTelegram.path, color: "#26A5E4" },
  Voice: { lucide: Phone, color: "#f59e0b" },
  "Web Chat": { lucide: MessageCircle, color: "#38bdf8" },
  GitHub: { path: siGithub.path, color: "#e4e4e7" },
  Gmail: { path: siGmail.path, color: "#EA4335" },
  Google: { path: siGoogle.path, color: "#4285F4" },
  Notion: { path: siNotion.path, color: "#e4e4e7" },
  Linear: { path: siLinear.path, color: "#5E6AD2" },
};

function Logo({ name }: { name: string }) {
  const b = BRANDS[name];
  if (!b) return null;
  if (b.lucide) {
    const I = b.lucide;
    return <I className="h-5 w-5" style={{ color: b.color }} />;
  }
  return (
    <svg role="img" viewBox="0 0 24 24" className="h-5 w-5" fill={b.color} aria-hidden="true">
      <path d={b.path} />
    </svg>
  );
}

type Item = { name: string; sub?: string; href?: string };

export function BrandGrid({ items }: { items: Item[] }) {
  return (
    <div className="brand-grid">
      {items.map((i) => {
        const inner = (
          <>
            <span className="brand-chip"><Logo name={i.name} /></span>
            <div>
              <div className="brand-name">{i.name}</div>
              {i.sub ? <div className="brand-sub">{i.sub}</div> : null}
            </div>
          </>
        );
        return i.href ? (
          <Link key={i.name} href={i.href} className="brand-card brand-link">{inner}</Link>
        ) : (
          <div key={i.name} className="brand-card">{inner}</div>
        );
      })}
    </div>
  );
}
