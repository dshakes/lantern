"use client";

// Settings → Devices (ADR 0047). Pair a PAL bridge (the appliance on your Mac)
// or an iPhone Shortcuts signal source to this workspace, see what is paired,
// and revoke a device. The pairing code is shown once and expires in 10
// minutes; the device redeems it for its own revocable credential.

import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Laptop, Smartphone, Plus, Trash2, Copy, Check } from "lucide-react";
import { api, type BridgePairingCode, type BridgePlatform, type PairedBridge } from "@/lib/api";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Modal, ModalField } from "@/components/modal";
import { Skeleton } from "@/components/skeleton";
import { QRCode } from "@/components/qr-code";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { useToast } from "@/components/settings/toast";

const PLATFORM_LABEL: Record<BridgePlatform, string> = {
  macos: "Mac bridge",
  "ios-shortcuts": "iPhone Shortcuts",
};

function since(ts?: string): string {
  if (!ts) return "never";
  try {
    return `${formatDistanceToNow(new Date(ts))} ago`;
  } catch {
    return ts;
  }
}

/** Absolute API base a device must reach — the browser may hold a relative one. */
function absoluteApiBase(): string {
  try {
    return new URL(api.apiBaseUrl, window.location.origin).toString().replace(/\/$/, "");
  } catch {
    return api.apiBaseUrl;
  }
}

function secondsUntil(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
}

export function DevicesTab() {
  const { toast } = useToast();
  const [devices, setDevices] = useState<PairedBridge[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showPair, setShowPair] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PairedBridge | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices(await api.listBridges());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load devices");
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await api.revokeBridge(revokeTarget.id);
      toast("success", `Revoked "${revokeTarget.name || PLATFORM_LABEL[revokeTarget.platform]}"`);
      await load();
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Revoke failed");
    } finally {
      setRevokeTarget(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-50">Devices</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Devices paired to this workspace. Your messages, mail and files stay on your Mac — a paired
            device only sends the context you approve.
          </p>
        </div>
        <Button variant="primary" size="md" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowPair(true)}>
          Pair a device
        </Button>
      </div>

      {loadError && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">{loadError}</p>
      )}

      {devices === null ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : devices.length === 0 ? (
        <EmptyState
          icon={Laptop}
          title="No devices paired"
          description="Pair the PAL bridge on your Mac, or an iPhone Shortcuts signal source, with a one-time code."
          actionLabel="Pair a device"
          onAction={() => setShowPair(true)}
          size="compact"
        />
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
          {devices.map((d) => {
            const Icon = d.platform === "ios-shortcuts" ? Smartphone : Laptop;
            return (
              <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-zinc-50">{d.name || PLATFORM_LABEL[d.platform]}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {PLATFORM_LABEL[d.platform]} · <span className="font-mono">{d.tokenPrefix}…</span> · paired{" "}
                    {since(d.createdAt)} · last seen {since(d.lastSeenAt)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={() => setRevokeTarget(d)}
                  aria-label={`Revoke ${d.name || PLATFORM_LABEL[d.platform]}`}
                >
                  Revoke
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <PairDeviceModal
        open={showPair}
        onClose={() => {
          setShowPair(false);
          void load();
        }}
      />
      <ConfirmDialog
        open={!!revokeTarget}
        title="Revoke device"
        message={`Revoke "${revokeTarget?.name || (revokeTarget ? PLATFORM_LABEL[revokeTarget.platform] : "")}"? It stops working immediately and must be paired again.`}
        confirmLabel="Revoke device"
        destructive
        onConfirm={handleRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}

function PairDeviceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<BridgePlatform>("macos");
  const [creating, setCreating] = useState(false);
  const [pairing, setPairing] = useState<BridgePairingCode | null>(null);
  const [left, setLeft] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setPairing(null);
      setName("");
      setPlatform("macos");
      setCopied(false);
    }
  }, [open]);

  useEffect(() => {
    if (!pairing) return;
    setLeft(secondsUntil(pairing.expiresAt));
    const t = setInterval(() => setLeft(secondsUntil(pairing.expiresAt)), 1000);
    return () => clearInterval(t);
  }, [pairing]);

  const create = async () => {
    setCreating(true);
    try {
      setPairing(await api.enrollBridge({ name: name.trim() || undefined, platform }));
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Could not create a pairing code");
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the code is on screen */
    }
  };

  const expired = !!pairing && left === 0;
  const server = typeof window !== "undefined" ? absoluteApiBase() : "";
  const qrValue = pairing ? `pal://pair?code=${encodeURIComponent(pairing.code)}&server=${encodeURIComponent(server)}` : "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pair a device"
      description="Create a one-time code, then enter it on the device. The code works once and expires in 10 minutes."
      size="md"
      footer={
        pairing ? (
          <>
            {expired && (
              <Button variant="secondary" onClick={() => setPairing(null)}>
                New code
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={creating} onClick={create}>
              Create pairing code
            </Button>
          </>
        )
      }
    >
      {!pairing ? (
        <div className="space-y-4">
          <ModalField label="Device type">
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as BridgePlatform)}
              className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-50"
            >
              <option value="macos">Mac bridge — reads and writes device signals</option>
              <option value="ios-shortcuts">iPhone Shortcuts — writes device signals only</option>
            </select>
          </ModalField>
          <ModalField label="Name (optional)">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="e.g. Home Mac mini"
              className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-50 placeholder:text-zinc-600"
            />
          </ModalField>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          {!expired && <QRCode value={qrValue} size={180} />}
          <div className="flex items-center gap-2">
            <span className={`font-mono text-2xl tracking-widest ${expired ? "text-zinc-600 line-through" : "text-zinc-50"}`}>
              {pairing.code}
            </span>
            {!expired && (
              <Button variant="ghost" size="sm" aria-label="Copy code" icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
          </div>
          <p className="text-xs text-zinc-500">
            {expired ? "This code expired. Create a new one." : `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
          </p>
          <p className="max-w-sm text-center text-xs text-zinc-500">
            {platform === "macos"
              ? "On your Mac, run the PAL bridge pairing step and enter this code (or scan the QR)."
              : "In your Shortcut, call the pairing endpoint once with this code and save the token it returns."}{" "}
            Server: <span className="font-mono">{server}</span>
          </p>
        </div>
      )}
    </Modal>
  );
}
