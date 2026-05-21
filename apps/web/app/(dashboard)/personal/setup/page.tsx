"use client";

// /personal/setup — pairing the user's phone with WhatsApp linked
// devices. iMessage has no QR (it's already paired via Apple ID);
// the page shows an iMessage-specific "already connected" card
// instead.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, RefreshCw, ScanLine, ShieldCheck, Trash2, Unplug } from "lucide-react";

import { useBridge } from "@/components/personal/bridge-context";
import type { ConnectionState } from "@/lib/bridge-types";

export default function SetupPage() {
  const bridge = useBridge();
  const {
    channel,
    state,
    reason,
    phoneNumber,
    displayName,
    connectedAt,
    qrDataUrl,
    qrIssuedAt,
    qrExpiresInMs,
    busy,
    startPairing,
    disconnect,
    reset,
  } = bridge;

  // iMessage has no QR/pairing — your Mac is already signed in. Show
  // a dedicated panel.
  if (channel === "imessage") {
    return <IMessageSetupView state={state} reason={reason} />;
  }

  const [confirmReset, setConfirmReset] = useState(false);

  // Re-render the QR countdown every 250ms so the user sees the timer.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (state !== "qr_ready") return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [state]);

  const qrSecondsLeft = useMemo(() => {
    if (!qrIssuedAt) return null;
    const left = qrExpiresInMs - (now - qrIssuedAt);
    return Math.max(0, Math.floor(left / 1000));
  }, [qrIssuedAt, qrExpiresInMs, now]);

  const isLive = state === "connected" || state === "reconnecting";

  return (
    <div className="space-y-6">
      <Stepper state={state} />

      {isLive ? (
        <ConnectedCard
          phoneNumber={phoneNumber}
          displayName={displayName}
          connectedAt={connectedAt}
          disconnecting={busy.disconnecting}
          resetting={busy.resetting}
          onDisconnect={disconnect}
          onReset={() => setConfirmReset(true)}
        />
      ) : (
        <PairingCard
          state={state}
          reason={reason}
          qrDataUrl={qrDataUrl}
          qrSecondsLeft={qrSecondsLeft}
          pairing={busy.pairing}
          onStart={startPairing}
        />
      )}

      <Instructions />

      {confirmReset && (
        <ConfirmModal
          title="Reset the bridge?"
          description="This wipes the paired session entirely. You'll need to scan a new QR. Your settings (monitored groups, paused contacts) are preserved."
          onCancel={() => setConfirmReset(false)}
          onConfirm={async () => {
            setConfirmReset(false);
            await reset();
          }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------- stepper

function Stepper({ state }: { state: ConnectionState }) {
  const stages: { id: string; label: string; matchedBy: ConnectionState[] }[] = [
    {
      id: "bridge",
      label: "Bridge ready",
      matchedBy: ["idle", "starting", "qr_ready", "connecting", "connected", "reconnecting", "logged_out", "conflict", "error"],
    },
    {
      id: "qr",
      label: "Scan QR",
      matchedBy: ["qr_ready", "connecting", "connected", "reconnecting"],
    },
    {
      id: "connect",
      label: "Linked",
      matchedBy: ["connecting", "connected", "reconnecting"],
    },
    {
      id: "live",
      label: "Live",
      matchedBy: ["connected", "reconnecting"],
    },
  ];

  return (
    <ol className="flex items-center gap-2">
      {stages.map((s, i) => {
        const done = s.matchedBy.includes(state);
        const active = done && (i === stages.length - 1 || !stages[i + 1].matchedBy.includes(state));
        return (
          <li key={s.id} className="flex flex-1 items-center gap-2">
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-medium transition-colors ${
                done
                  ? active
                    ? "border-violet-500 bg-violet-500/20 text-violet-200"
                    : "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-500"
              }`}
            >
              {done && !active ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                i + 1
              )}
            </div>
            <span
              className={`whitespace-nowrap text-xs ${done ? "text-zinc-200" : "text-zinc-500"}`}
            >
              {s.label}
            </span>
            {i < stages.length - 1 && (
              <div
                className={`mx-2 h-px flex-1 ${
                  done && stages[i + 1].matchedBy.includes(state)
                    ? "bg-emerald-500/40"
                    : "bg-zinc-800"
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// -------------------------------------------------------------------- pairing card

function PairingCard({
  state,
  reason,
  qrDataUrl,
  qrSecondsLeft,
  pairing,
  onStart,
}: {
  state: ConnectionState;
  reason: string | null;
  qrDataUrl: string | null;
  qrSecondsLeft: number | null;
  pairing: boolean;
  onStart: () => void;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-8">
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:items-center">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-violet-300">
            <ScanLine className="h-3 w-3" /> WhatsApp linked device
          </div>
          <h2 className="mt-4 text-2xl font-medium text-zinc-50">
            {state === "qr_ready"
              ? "Scan the QR code"
              : state === "starting" || state === "connecting"
                ? "Almost there…"
                : state === "logged_out"
                  ? "Pair again"
                  : "Pair your phone"}
          </h2>
          <p className="mt-2 max-w-md text-sm text-zinc-400">
            {state === "qr_ready"
              ? "Open WhatsApp on your phone → Settings → Linked Devices → Link a Device → point at this code."
              : state === "starting" || state === "connecting"
                ? "Generating a fresh QR. This takes a couple seconds."
                : "One scan and the assistant comes online. Your messages stay on your device."}
          </p>
          {reason && (
            <p className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-200">
              {reason}
            </p>
          )}
          {state !== "qr_ready" && state !== "starting" && state !== "connecting" && (
            <button
              type="button"
              onClick={onStart}
              disabled={pairing}
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-violet-500 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-violet-400 disabled:opacity-50"
            >
              {pairing ? "Starting…" : state === "logged_out" ? "Pair again" : "Generate QR"}
            </button>
          )}
        </div>
        <div className="flex items-center justify-center">
          <QrSlot
            qrDataUrl={qrDataUrl}
            state={state}
            secondsLeft={qrSecondsLeft}
          />
        </div>
      </div>
    </div>
  );
}

function QrSlot({
  qrDataUrl,
  state,
  secondsLeft,
}: {
  qrDataUrl: string | null;
  state: ConnectionState;
  secondsLeft: number | null;
}) {
  const showQr = state === "qr_ready" && qrDataUrl;
  return (
    <div className="relative flex h-72 w-72 items-center justify-center overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
      {showQr ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrDataUrl}
            alt="WhatsApp linked-device QR code"
            className="h-64 w-64 rounded bg-white p-2"
          />
          {typeof secondsLeft === "number" && (
            <span className="absolute bottom-3 right-3 rounded-full bg-zinc-900/90 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
              {secondsLeft}s
            </span>
          )}
        </>
      ) : state === "starting" || state === "connecting" ? (
        <div className="flex flex-col items-center gap-3 text-zinc-500">
          <RefreshCw className="h-6 w-6 animate-spin" />
          <span className="text-xs">Generating QR…</span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 text-zinc-600">
          <ScanLine className="h-8 w-8" />
          <span className="text-xs">QR appears here</span>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- connected card

function ConnectedCard({
  phoneNumber,
  displayName,
  connectedAt,
  disconnecting,
  resetting,
  onDisconnect,
  onReset,
}: {
  phoneNumber: string | null;
  displayName: string | null;
  connectedAt: number | null;
  disconnecting: boolean;
  resetting: boolean;
  onDisconnect: () => void;
  onReset: () => void;
}) {
  const uptimeMs = connectedAt ? Date.now() - connectedAt : null;
  return (
    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.03] p-8">
      <div className="flex items-start gap-4">
        <div className="rounded-full border border-emerald-500/40 bg-emerald-500/10 p-3">
          <CheckCircle2 className="h-6 w-6 text-emerald-300" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-medium text-zinc-50">
            Your assistant is live
          </h2>
          <p className="mt-1 text-sm text-zinc-400">
            {displayName || "Personal"} {phoneNumber ? `· +${phoneNumber}` : ""}
            {uptimeMs ? ` · ${prettyDuration(uptimeMs)} uptime` : ""}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onDisconnect}
              disabled={disconnecting}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
            >
              <Unplug className="h-3.5 w-3.5" />
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </button>
            <button
              type="button"
              onClick={onReset}
              disabled={resetting}
              className="inline-flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-1.5 text-xs text-rose-200 transition hover:bg-rose-500/10 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {resetting ? "Resetting…" : "Reset bridge"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- instructions

function Instructions() {
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-surface-1 p-5">
      <h3 className="text-sm font-medium text-zinc-100">How pairing works</h3>
      <ol className="mt-3 space-y-2 text-sm text-zinc-400">
        <Step n={1}>Click <strong className="text-zinc-200">Pair WhatsApp</strong> above to generate a QR.</Step>
        <Step n={2}>On your phone, open <strong className="text-zinc-200">WhatsApp → Settings → Linked Devices → Link a Device</strong>.</Step>
        <Step n={3}>Point your camera at the QR code. It expires in 20 seconds — if it does, click pair again.</Step>
        <Step n={4}>The bridge connects within a couple seconds. The status pill at the top of the page turns green.</Step>
      </ol>
      <p className="mt-4 text-xs text-zinc-500">
        Your message contents stay on your device — the bridge runs as a linked WhatsApp Web session, the same as any browser tab. Disconnect or reset at any time.
      </p>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-[10px] text-zinc-400">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

// -------------------------------------------------------------------- confirm modal

function ConfirmModal({
  title,
  description,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-surface-1 p-6 shadow-2xl">
        <h3 className="text-lg font-medium text-zinc-50">{title}</h3>
        <p className="mt-2 text-sm text-zinc-400">{description}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-400"
          >
            Reset bridge
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- iMessage view

function IMessageSetupView({
  state,
  reason,
}: {
  state: ConnectionState;
  reason: string | null;
}) {
  const isLive = state === "connected";
  const isError = state === "error";
  return (
    <div className="space-y-6">
      <div
        className={`rounded-2xl border p-8 ${
          isLive
            ? "border-emerald-500/30 bg-emerald-500/[0.04]"
            : isError
              ? "border-rose-500/30 bg-rose-500/[0.04]"
              : "border-zinc-800/80 bg-surface-1"
        }`}
      >
        <div className="flex items-start gap-5">
          <div
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${
              isLive
                ? "bg-emerald-500/15 text-emerald-300"
                : isError
                  ? "bg-rose-500/15 text-rose-300"
                  : "bg-blue-500/15 text-blue-300"
            }`}
          >
            {isLive ? <CheckCircle2 className="h-6 w-6" /> : <ShieldCheck className="h-6 w-6" />}
          </div>
          <div>
            <h2 className="text-xl font-medium text-zinc-50">
              {isLive
                ? "iMessage is connected"
                : isError
                  ? "iMessage permission needed"
                  : "iMessage — already paired by macOS"}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-400">
              {isLive
                ? "Your Mac is signed into Messages.app and the bridge can read + send. You're live."
                : isError
                  ? reason ?? "The bridge needs Full Disk Access and Automation permission."
                  : "Unlike WhatsApp, iMessage doesn't need a QR scan. Your Mac is already signed into your Apple ID — the bridge just reads ~/Library/Messages/chat.db (with Full Disk Access) and sends via Messages.app (with Automation permission)."}
            </p>
          </div>
        </div>
      </div>

      {isError && (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/[0.03] p-5">
          <h3 className="text-sm font-medium text-rose-200">How to fix</h3>
          <ol className="mt-3 space-y-2 text-sm text-rose-100/90">
            <Step n={1}>
              <strong className="text-rose-100">Full Disk Access</strong> — System Settings → Privacy &amp; Security → Full Disk Access → add your terminal app (or the Node binary if running via LaunchAgent).
            </Step>
            <Step n={2}>
              <strong className="text-rose-100">Automation</strong> — System Settings → Privacy &amp; Security → Automation → enable Messages for your terminal/launchd.
            </Step>
            <Step n={3}>
              Restart the bridge: <code className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs">make run-imessage-bridge</code>
            </Step>
          </ol>
        </div>
      )}

      <div className="rounded-xl border border-zinc-800/80 bg-surface-1 p-5">
        <h3 className="text-sm font-medium text-zinc-100">In-band controls</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Once live, you can control the assistant by typing these commands in Messages.app on your phone or Mac — same muscle memory as WhatsApp.
        </p>
        <ul className="mt-3 space-y-1.5 text-sm text-zinc-300">
          <Cmd cmd="/bot on" desc="resume auto-reply" />
          <Cmd cmd="/bot off" desc="pause auto-reply globally" />
          <Cmd cmd="/bot status" desc="current bridge + bot state" />
          <Cmd cmd="/bot resume-all" desc="clear all per-contact pauses" />
          <Cmd cmd="/lantern ping" desc="liveness check (pong)" />
          <Cmd cmd="/lantern status" desc="full session diagnostics" />
          <Cmd cmd="/lantern chats list" desc="show monitored group chats" />
        </ul>
        <p className="mt-4 text-xs text-zinc-500">
          Looking for prod-grade always-on? See{" "}
          <Link
            href="https://github.com/dshakes/lantern/blob/master/scripts/launchd/README.md"
            target="_blank"
            className="text-violet-300 underline"
          >
            LaunchAgent setup
          </Link>{" "}
          — auto-starts at login, auto-restarts on crash.
        </p>
      </div>
    </div>
  );
}

function Cmd({ cmd, desc }: { cmd: string; desc: string }) {
  return (
    <li className="flex items-center gap-3">
      <code className="rounded bg-zinc-900 px-2 py-0.5 font-mono text-xs text-blue-300">
        {cmd}
      </code>
      <span className="text-zinc-400">— {desc}</span>
    </li>
  );
}

// -------------------------------------------------------------------- utils

function prettyDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
