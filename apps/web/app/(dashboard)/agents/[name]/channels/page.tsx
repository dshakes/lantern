"use client";

// /agents/[name]/channels — channel catalog for a single agent.
//
// Lists every surface the agent can reach: WhatsApp (QR pair), webchat
// (embed snippet), voice (phone number), Slack/Telegram (OAuth), email.
// Each card links into its dedicated configuration page. The actual
// pairing / install flow lives on the per-channel sub-route, not here —
// keeping this page scannable.

import { useParams } from "next/navigation";
import Link from "next/link";
import {
  MessageSquare,
  Code2,
  Phone,
  Send,
  Mail,
  ChevronRight,
  ArrowRight,
} from "lucide-react";
import clsx from "clsx";

interface ChannelCard {
  id: string;
  name: string;
  description: string;
  icon: typeof MessageSquare;
  iconColor: string;
  iconBg: string;
  href: string;
  // Status pill text shown on the right; null hides it.
  status: string | null;
  badge?: string;
}

export default function AgentChannelsPage() {
  const params = useParams<{ name: string }>();
  const name = params?.name ?? "";

  const channels: ChannelCard[] = [
    {
      id: "whatsapp",
      name: "WhatsApp",
      description: "Pair your personal WhatsApp by QR code. Natural-reply layer makes the agent text like a person.",
      icon: MessageSquare,
      iconColor: "text-green-400",
      iconBg: "bg-green-500/10",
      href: `/agents/${encodeURIComponent(name)}/channels/whatsapp`,
      status: "Available",
    },
    {
      id: "webchat",
      name: "Webchat widget",
      description: "Embed a one-line <script> on any website. Visitors get a chat bubble in the corner that talks to this agent.",
      icon: Code2,
      iconColor: "text-lantern-400",
      iconBg: "bg-lantern-500/10",
      href: `/embed?agent=${encodeURIComponent(name)}`,
      status: "Available",
    },
    {
      id: "voice",
      name: "Voice",
      description: "Buy or BYO a phone number via Twilio. Inbound calls route to this agent with TTS reply.",
      icon: Phone,
      iconColor: "text-rose-400",
      iconBg: "bg-rose-500/10",
      href: `/voice?agent=${encodeURIComponent(name)}`,
      status: "Requires Twilio",
    },
    {
      id: "slack",
      name: "Slack",
      description: "Slash commands, mentions, and threads. OAuth-installed; one click from the surfaces page.",
      icon: MessageSquare,
      iconColor: "text-purple-400",
      iconBg: "bg-purple-500/10",
      href: `/surfaces`,
      status: null,
    },
    {
      id: "telegram",
      name: "Telegram",
      description: "Connect your Telegram bot via BotFather token. Inline keyboards + media supported.",
      icon: Send,
      iconColor: "text-sky-400",
      iconBg: "bg-sky-500/10",
      href: `/surfaces`,
      status: null,
    },
    {
      id: "email",
      name: "Email",
      description: "Per-tenant email address via SMTP. Agent answers inbound mail and threads with senders.",
      icon: Mail,
      iconColor: "text-amber-400",
      iconBg: "bg-amber-500/10",
      href: `/surfaces`,
      status: null,
    },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-[1400px] px-6 py-6 md:px-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-zinc-100">Channels</h1>
          <p className="mt-1 max-w-2xl text-xs text-zinc-500">
            Surfaces this agent can be reached on. Pick a channel to configure it.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {channels.map((c) => (
            <ChannelTile key={c.id} card={c} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ChannelTile({ card }: { card: ChannelCard }) {
  const Icon = card.icon;
  return (
    <Link
      href={card.href}
      className={clsx(
        "group flex flex-col rounded-xl border border-zinc-800 bg-surface-1 p-5",
        "transition-all duration-150",
        "hover:border-zinc-700 hover:bg-surface-2 hover:shadow-md"
      )}
    >
      <div className="mb-4 flex items-start justify-between">
        <div className={clsx("flex h-10 w-10 items-center justify-center rounded-xl", card.iconBg)}>
          <Icon className={clsx("h-5 w-5", card.iconColor)} />
        </div>
        {card.status && (
          <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
            {card.status}
          </span>
        )}
      </div>
      <h3 className="mb-1 text-sm font-semibold text-zinc-100">{card.name}</h3>
      <p className="flex-1 text-[11px] leading-relaxed text-zinc-500">
        {card.description}
      </p>
      <div className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-medium text-lantern-400 transition-colors duration-150 group-hover:text-lantern-300">
        Configure
        <ArrowRight className="h-3 w-3 transition-transform duration-150 group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
