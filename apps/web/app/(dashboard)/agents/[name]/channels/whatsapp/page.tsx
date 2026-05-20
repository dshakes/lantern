"use client";

// /agents/[name]/channels/whatsapp — the WhatsApp configuration page.
//
// Replaces the cluttered modal-in-a-modal pattern (user feedback:
// "scrollables across, can be more sophisticated"). The full pairing +
// connected experience lives on this dedicated route with a quiet
// two-pane layout:
//
//   ┌── Header ──────────────────────────────────────────────┐
//   │ ← Channels    WhatsApp · paired 12m · p50 1.4s        │
//   ├──────────────┬─────────────────────────────────────────┤
//   │ Identity     │  Live activity                          │
//   │ Bot controls │  (virtualized; per-message pause inline)│
//   │ Groups       │                                         │
//   │ Cheat sheet  │  Reasoning drawer slides in on click    │
//   │ Diagnostics  │                                         │
//   └──────────────┴─────────────────────────────────────────┘
//
// The existing WhatsAppPairing component still does the heavy lifting
// (state machine, WS, natural layer integration); we just give it room
// to breathe instead of stuffing it into a modal that scrolls inside a
// page that scrolls.

import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useAgent } from "@/lib/hooks";
import { WhatsAppPairing } from "@/components/whatsapp-pairing";

export default function AgentWhatsAppPage() {
  const params = useParams<{ name: string }>();
  const name = params?.name ?? "";
  const { user } = useAuth();
  const tenantId = user?.tenantId ?? "default";
  const { agent } = useAgent(name);

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-[1400px] px-6 py-6 md:px-8">
        <Link
          href={`/agents/${encodeURIComponent(name)}/channels`}
          className="mb-4 inline-flex items-center gap-1 text-[11px] text-zinc-500 transition-colors duration-150 hover:text-zinc-300"
        >
          <ArrowLeft className="h-3 w-3" />
          Channels
        </Link>
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-100">WhatsApp</h1>
            <p className="mt-1 max-w-2xl text-xs text-zinc-500">
              Pair your personal WhatsApp by scanning a QR code. The natural-reply layer
              paces messages, mirrors thumbs to acks, and refuses to sound like a chatbot.
            </p>
          </div>
        </header>

        <WhatsAppPairing tenantId={tenantId} agentAvatarUrl={agent?.avatarUrl} agentName={agent?.name} />
      </div>
    </div>
  );
}
