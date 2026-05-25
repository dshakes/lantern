"use client";

// /personal — the personal-assistant product surface, channel-aware.
// One UI, two backends: WhatsApp bridge (3100) and iMessage bridge
// (3200). The channel is selected via a top-of-page pill switcher and
// persisted in localStorage so it survives reloads + deep links.
//
// Sub-pages don't need to know which channel they're on; everything
// flows through BridgeProvider which routes to the right bridge URL.
// Where the two channels differ (groups vs chats, no QR on iMessage)
// the bridge-client helpers normalize the shape, and pages branch on
// `bridge.channel` for label differences.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Crown,
  FileText,
  FolderSearch,
  MessageCircle,
  Smartphone,
  UserMinus,
  Users,
  Zap,
} from "lucide-react";

import { useAuth } from "@/lib/auth";
import { BridgeProvider, useBridge } from "@/components/personal/bridge-context";
import type {
  BridgeChannel,
  ConnectionState,
} from "@/lib/bridge-types";
import { isBridgeChannel } from "@/lib/bridge-types";

const FALLBACK_TENANT = "default";
const CHANNEL_STORAGE_KEY = "lantern_personal_channel";

interface SubNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

// Two-tier nav. The channel switcher only matters for the
// per-channel pages (each bridge has its own state). VIPs + Drafts +
// Overview are GLOBAL — adding a VIP applies to both channels, the
// draft queue mixes drafts from both. Marking which is which here so
// the UI can hide the switcher on global pages.
type PageScope = "global" | "per-channel";

interface SubNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  scope: PageScope;
}

const NAV: SubNavItem[] = [
  // Global section — applies across all channels
  { href: "/personal", label: "Overview", icon: Smartphone, scope: "global" },
  { href: "/personal/vip", label: "VIPs", icon: Crown, scope: "global" },
  { href: "/personal/drafts", label: "Drafts", icon: FileText, scope: "global" },
  { href: "/personal/docs", label: "Docs", icon: FolderSearch, scope: "global" },
  // Channel-specific — different per bridge
  { href: "/personal/setup", label: "Pair", icon: Smartphone, scope: "per-channel" },
  { href: "/personal/auto-reply", label: "Auto-reply", icon: Zap, scope: "per-channel" },
  { href: "/personal/groups", label: "Groups", icon: Users, scope: "per-channel" },
  { href: "/personal/contacts", label: "Paused", icon: UserMinus, scope: "per-channel" },
  { href: "/personal/activity", label: "Activity", icon: Activity, scope: "per-channel" },
];

// Which routes hide the WhatsApp/iMessage switcher (because the page
// content is the same regardless of channel).
const GLOBAL_ROUTES = new Set(NAV.filter((n) => n.scope === "global").map((n) => n.href));

export default function PersonalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const tenantId = user?.tenantId ?? FALLBACK_TENANT;

  // Channel state lives at the layout level because it determines
  // which bridge the BridgeProvider talks to. Default = whatsapp.
  // Restore from localStorage so the user's pick survives reloads.
  const [channel, setChannel] = useState<BridgeChannel>("whatsapp");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CHANNEL_STORAGE_KEY);
      if (stored && isBridgeChannel(stored)) setChannel(stored);
    } catch {
      // localStorage unavailable — stay on whatsapp
    }
    setHydrated(true);
  }, []);
  const switchChannel = (next: BridgeChannel) => {
    setChannel(next);
    try { localStorage.setItem(CHANNEL_STORAGE_KEY, next); } catch {}
  };

  // Guard against the brief mount before hydration so we don't render
  // a WhatsApp provider then a beat later remount with iMessage. The
  // BridgeProvider creates a WS on mount, so an unnecessary remount
  // wastes a connection.
  if (!hydrated) {
    return <div className="flex h-full" />;
  }

  return (
    <BridgeProvider key={`${channel}-${tenantId}`} tenantId={tenantId} channel={channel}>
      <Shell channel={channel} onSwitch={switchChannel}>{children}</Shell>
    </BridgeProvider>
  );
}

function Shell({
  channel,
  onSwitch,
  children,
}: {
  channel: BridgeChannel;
  onSwitch: (c: BridgeChannel) => void;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isGlobalPage = GLOBAL_ROUTES.has(pathname);
  return (
    <div className="flex h-full flex-col">
      <Header channel={channel} onSwitch={onSwitch} hideSwitcher={isGlobalPage} />
      <SubNav />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}

function Header({
  channel,
  onSwitch,
  hideSwitcher,
}: {
  channel: BridgeChannel;
  onSwitch: (c: BridgeChannel) => void;
  hideSwitcher: boolean;
}) {
  const { state, phoneNumber, displayName } = useBridge();
  return (
    <header className="border-b border-zinc-800/80 bg-surface-1/60 backdrop-blur supports-[backdrop-filter]:bg-surface-1/40">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-8 py-5">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-medium tracking-tight text-zinc-50">
              Personal
            </h1>
            {hideSwitcher ? (
              <span className="rounded-full border border-zinc-700/50 bg-zinc-800/40 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                applies to all channels
              </span>
            ) : (
              <ChannelSwitcher channel={channel} onSwitch={onSwitch} />
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-400">
            {hideSwitcher
              ? "Settings here apply across WhatsApp + iMessage. The assistant honors them everywhere."
              : channel === "whatsapp"
                ? "Your personal assistant on WhatsApp — auto-reply, monitor group chats, prep your day."
                : "Your personal assistant on iMessage — same brain, native macOS Messages.app integration."}
          </p>
        </div>
        {!hideSwitcher && (
          <StatusPill state={state} phoneNumber={phoneNumber} displayName={displayName} />
        )}
      </div>
    </header>
  );
}

// Two-tab channel switcher pill. Compact, sleek, top-of-page so the
// user always sees which channel they're configuring.
function ChannelSwitcher({
  channel,
  onSwitch,
}: {
  channel: BridgeChannel;
  onSwitch: (c: BridgeChannel) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-full border border-zinc-800 bg-zinc-900/60 p-0.5">
      <button
        type="button"
        onClick={() => onSwitch("whatsapp")}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
          channel === "whatsapp"
            ? "bg-emerald-500/15 text-emerald-300"
            : "text-zinc-500 hover:text-zinc-300"
        }`}
      >
        <MessageCircle className="h-3 w-3" />
        WhatsApp
      </button>
      <button
        type="button"
        onClick={() => onSwitch("imessage")}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
          channel === "imessage"
            ? "bg-blue-500/15 text-blue-300"
            : "text-zinc-500 hover:text-zinc-300"
        }`}
      >
        <Smartphone className="h-3 w-3" />
        iMessage
      </button>
    </div>
  );
}

function StatusPill({
  state,
  phoneNumber,
  displayName,
}: {
  state: ConnectionState;
  phoneNumber: string | null;
  displayName: string | null;
}) {
  const tone = stateToTone(state);
  const label = stateLabel(state);
  return (
    <div className="flex items-center gap-3">
      {(phoneNumber || displayName) && (
        <div className="hidden text-right sm:block">
          <div className="text-xs text-zinc-500">{displayName || "Personal"}</div>
          {phoneNumber && (
            <div className="font-mono text-xs text-zinc-300">+{phoneNumber}</div>
          )}
        </div>
      )}
      <span
        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${tone}`}
      >
        <span
          className={`h-2 w-2 rounded-full ${stateToDot(state)} ${stateIsPulsing(state) ? "animate-pulse" : ""}`}
        />
        {label}
      </span>
    </div>
  );
}

function SubNav() {
  const pathname = usePathname();
  const { channel } = useBridge();
  // iMessage has no "Pair" flow — Messages.app is already paired with
  // your Apple ID. Hide that nav entry when on iMessage and relabel
  // "Groups" to "Chats" since that's the iMessage vocabulary.
  const items = NAV.filter((n) =>
    channel === "imessage" && n.href === "/personal/setup" ? false : true,
  ).map((n) =>
    channel === "imessage" && n.href === "/personal/groups"
      ? { ...n, label: "Chats" }
      : n,
  );
  // Find the boundary index between global and per-channel items so
  // we can drop a subtle divider — visually communicates the scope
  // split without yelling at the user.
  const firstPerChannelIdx = items.findIndex((i) => i.scope === "per-channel");

  return (
    <nav className="border-b border-zinc-800/80 bg-surface-1/30">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-1 overflow-x-auto px-8">
        {items.map((item, i) => {
          const active =
            pathname === item.href ||
            (item.href !== "/personal" && pathname.startsWith(item.href));
          const Icon = item.icon;
          const isDividerBefore = i === firstPerChannelIdx && firstPerChannelIdx > 0;
          return (
            <span key={item.href} className="contents">
              {isDividerBefore && (
                <span className="mx-2 inline-block h-4 w-px self-center bg-zinc-800" aria-hidden />
              )}
              <Link
                href={item.href}
                className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-3 text-sm transition-colors ${
                  active
                    ? "border-violet-500 text-zinc-50"
                    : "border-transparent text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            </span>
          );
        })}
      </div>
    </nav>
  );
}

function stateLabel(s: ConnectionState): string {
  switch (s) {
    case "unknown": return "checking";
    case "bridge_offline": return "bridge offline";
    case "auth_required": return "auth required";
    case "idle": return "not paired";
    case "starting": return "starting";
    case "qr_ready": return "scan QR";
    case "connecting": return "connecting";
    case "connected": return "live";
    case "reconnecting": return "reconnecting";
    case "logged_out": return "unlinked";
    case "conflict": return "conflict";
    case "error": return "error";
  }
}

function stateToTone(s: ConnectionState): string {
  switch (s) {
    case "connected": return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
    case "reconnecting":
    case "starting":
    case "connecting":
    case "qr_ready":
      return "border-amber-500/40 bg-amber-500/10 text-amber-300";
    case "logged_out":
    case "conflict":
    case "error":
    case "bridge_offline":
    case "auth_required":
      return "border-rose-500/40 bg-rose-500/10 text-rose-300";
    case "idle":
    case "unknown":
    default:
      return "border-zinc-700/50 bg-zinc-800/30 text-zinc-400";
  }
}

function stateToDot(s: ConnectionState): string {
  switch (s) {
    case "connected": return "bg-emerald-400";
    case "reconnecting":
    case "starting":
    case "connecting":
    case "qr_ready":
      return "bg-amber-400";
    case "logged_out":
    case "conflict":
    case "error":
    case "bridge_offline":
    case "auth_required":
      return "bg-rose-400";
    default: return "bg-zinc-500";
  }
}

function stateIsPulsing(s: ConnectionState): boolean {
  return s === "starting" || s === "connecting" || s === "qr_ready" || s === "reconnecting";
}
