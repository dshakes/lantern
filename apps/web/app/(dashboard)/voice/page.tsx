"use client";

// /voice — voice channel management (W11d).
//
// Lists linked phone numbers and recent inbound calls. Adding a new
// number requires picking a provider (Twilio today; LiveKit / Vapi
// pluggable on the backend via VoiceProvider) and pasting credentials.
// Real audio streaming requires the provider's webhook to point at
// /v1/voice/webhook/{provider} on this control-plane.

import { useEffect, useState } from "react";
import {
  Phone,
  PhoneCall,
  Plus,
  Trash2,
  Loader2,
  AlertCircle,
  Clock,
} from "lucide-react";
import clsx from "clsx";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/button";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";

interface VoiceNumber {
  id: string;
  agentName: string;
  provider: string;
  phoneNumber: string;
  displayName: string;
  status: string;
  lastError: string;
  createdAt: string;
}

interface VoiceCall {
  id: string;
  agentName: string;
  direction: string;
  from: string;
  to: string;
  status: string;
  durationMs: number;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
}

export default function VoicePage() {
  const toast = useToast();
  const [numbers, setNumbers] = useState<VoiceNumber[]>([]);
  const [calls, setCalls] = useState<VoiceCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const reload = async () => {
    try {
      const [n, c] = await Promise.all([
        api.listVoiceNumbers(),
        api.listVoiceCalls(),
      ]);
      setNumbers(n as VoiceNumber[]);
      setCalls(c as VoiceCall[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Voice"
        description="Phone numbers routed to your Lantern agents. Pluggable provider (Twilio today; LiveKit + Vapi land via VoiceProvider). Inbound webhook: POST /v1/voice/webhook/{provider}."
        action={
          <Button
            onClick={() => setShowAdd((v) => !v)}
            variant="primary"
            size="sm"
            icon={<Plus className="h-3.5 w-3.5" />}
          >
            Link a number
          </Button>
        }
      />

      <div className="space-y-6 p-8">
        {showAdd && (
          <AddNumberCard
            onCancel={() => setShowAdd(false)}
            saving={saving}
            onSave={async (payload) => {
              setSaving(true);
              try {
                await api.createVoiceNumber(payload);
                toast.success(`Linked ${payload.phoneNumber}`);
                setShowAdd(false);
                reload();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not save number");
              } finally {
                setSaving(false);
              }
            }}
          />
        )}

        {/* Numbers list */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            <Phone className="h-3.5 w-3.5" />
            Linked numbers
            <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-zinc-400">{numbers.length}</span>
          </h2>
          {loading ? (
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-6 text-[12px] text-zinc-500">
              <Loader2 className="mr-2 inline h-3 w-3 animate-spin" /> Loading…
            </div>
          ) : numbers.length === 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-8 text-center text-[12px] text-zinc-500">
              No voice numbers linked yet. Click <span className="text-zinc-300">Link a number</span> above.
            </div>
          ) : (
            <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
              {numbers.map((n) => (
                <li key={n.id} className="flex items-center gap-3 px-4 py-3">
                  <Phone className="h-4 w-4 text-zinc-500" />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[13px] text-zinc-100">{n.phoneNumber}</p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      <span className="text-zinc-300">{n.agentName}</span>
                      <span className="mx-1.5 text-zinc-700">·</span>
                      via {n.provider}
                      {n.displayName && <><span className="mx-1.5 text-zinc-700">·</span>{n.displayName}</>}
                    </p>
                    {n.lastError && (
                      <p className="mt-1 text-[11px] text-red-300">
                        <AlertCircle className="mr-1 inline h-3 w-3" />
                        {n.lastError}
                      </p>
                    )}
                  </div>
                  <span
                    className={clsx(
                      "rounded-full px-2 py-0.5 text-[10px] font-medium",
                      n.status === "active"
                        ? "bg-emerald-500/10 text-emerald-300"
                        : n.status === "error"
                          ? "bg-red-500/10 text-red-300"
                          : "bg-zinc-500/10 text-zinc-400"
                    )}
                  >
                    {n.status}
                  </span>
                  <button
                    onClick={async () => {
                      if (!confirm(`Unlink ${n.phoneNumber}?`)) return;
                      setDeleting(n.id);
                      try {
                        await api.deleteVoiceNumber(n.id);
                        toast.info(`Unlinked ${n.phoneNumber}`);
                        reload();
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Could not unlink");
                      } finally {
                        setDeleting(null);
                      }
                    }}
                    disabled={deleting === n.id}
                    className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
                    title="Unlink"
                  >
                    {deleting === n.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent calls */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            <PhoneCall className="h-3.5 w-3.5" />
            Recent calls
            <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-zinc-400">{calls.length}</span>
          </h2>
          {calls.length === 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-8 text-center text-[12px] text-zinc-500">
              No calls yet. Calls land here when inbound dials hit your linked numbers.
            </div>
          ) : (
            <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
              {calls.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                  <PhoneCall
                    className={clsx(
                      "h-3.5 w-3.5",
                      c.status === "completed" && "text-emerald-400",
                      c.status === "failed" && "text-red-400",
                      (c.status === "ringing" || c.status === "active") && "animate-pulse text-lantern-400"
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[12px] text-zinc-200">
                      {c.from} → {c.to}
                    </p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      {c.agentName}
                      <span className="mx-1.5 text-zinc-700">·</span>
                      {c.direction}
                      <span className="mx-1.5 text-zinc-700">·</span>
                      <Clock className="mr-0.5 inline h-3 w-3" />
                      {c.durationMs > 0 ? `${Math.round(c.durationMs / 1000)}s` : "—"}
                    </p>
                  </div>
                  {c.costUsd > 0 && (
                    <span className="text-[11px] text-zinc-400 tabular-nums">
                      ${c.costUsd.toFixed(4)}
                    </span>
                  )}
                  <span
                    className={clsx(
                      "rounded-full px-2 py-0.5 text-[10px] font-medium",
                      c.status === "completed" && "bg-emerald-500/10 text-emerald-300",
                      c.status === "failed" && "bg-red-500/10 text-red-300",
                      (c.status === "ringing" || c.status === "active") && "bg-lantern-500/10 text-lantern-300"
                    )}
                  >
                    {c.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function AddNumberCard({
  saving,
  onCancel,
  onSave,
}: {
  saving: boolean;
  onCancel: () => void;
  onSave: (p: {
    agentName: string;
    provider: string;
    phoneNumber: string;
    displayName?: string;
    providerConfig: Record<string, string>;
    greeting?: string;
  }) => void;
}) {
  const [agentName, setAgentName] = useState("");
  const [provider, setProvider] = useState("twilio");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [greeting, setGreeting] = useState("");

  return (
    <div className="space-y-4 rounded-xl border border-lantern-500/30 bg-lantern-500/5 p-5">
      <h3 className="text-sm font-semibold text-zinc-100">Link a new phone number</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Agent">
          <input
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="my-assistant"
            className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
          />
        </Field>
        <Field label="Provider">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
          >
            <option value="twilio">Twilio</option>
            <option value="livekit" disabled>LiveKit (coming)</option>
            <option value="vapi" disabled>Vapi (coming)</option>
          </select>
        </Field>
        <Field label="Phone number (E.164)">
          <input
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+14155551234"
            className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
          />
        </Field>
        <Field label="Display name (optional)">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Customer support line"
            className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
          />
        </Field>
        <Field label="Twilio Account SID" hint="From console.twilio.com">
          <input
            value={accountSid}
            onChange={(e) => setAccountSid(e.target.value)}
            placeholder="AC……"
            className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
          />
        </Field>
        <Field label="Twilio Auth Token">
          <input
            type="password"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder="…"
            className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
          />
        </Field>
      </div>
      <Field label="Greeting (optional)" hint="What the agent says on pickup">
        <input
          value={greeting}
          onChange={(e) => setGreeting(e.target.value)}
          placeholder="Hi, you've reached Lantern's assistant."
          className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
        />
      </Field>
      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          onClick={() =>
            onSave({
              agentName: agentName.trim(),
              provider,
              phoneNumber: phoneNumber.trim(),
              displayName: displayName.trim() || undefined,
              providerConfig: { accountSid: accountSid.trim(), authToken: authToken.trim() },
              greeting: greeting.trim() || undefined,
            })
          }
        >
          Link number
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <p className="ml-auto text-[11px] text-zinc-500">
          Webhook to set in Twilio: <code className="text-zinc-400">/v1/voice/webhook/twilio</code>
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-zinc-400">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[10px] text-zinc-600">{hint}</p>}
    </div>
  );
}
