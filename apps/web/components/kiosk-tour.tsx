"use client";

// Guided tour + session banner for kiosk/demo mode (ADR 0029). Active only when
// /kiosk stored a session in localStorage; renders nothing otherwise.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { Modal } from "@/components/modal";
import { api } from "@/lib/api";
import {
  IDLE_LIMIT_MS, KIOSK_STORAGE_KEY, TOUR_STEPS, formatClock, isIdle, msLeft, nextStep, parseMeta, type KioskMeta,
} from "@/app/kiosk/kiosk-logic";

function readMeta(): KioskMeta | null {
  try {
    return parseMeta(localStorage.getItem(KIOSK_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** The active kiosk session, or null. Used by the layout to hide provider-setup chrome. */
export function useKioskSession(): KioskMeta | null {
  const [meta, setMeta] = useState<KioskMeta | null>(null);
  useEffect(() => setMeta(readMeta()), []);
  return meta;
}

export function KioskTour() {
  const router = useRouter();
  const meta = useKioskSession();
  const [step, setStep] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [lastInput, setLastInput] = useState(() => Date.now());
  const [ended, setEnded] = useState<"expired" | "idle" | null>(null);

  const end = useCallback((why: "expired" | "idle") => {
    api.setToken(null);
    try { localStorage.removeItem(KIOSK_STORAGE_KEY); } catch { /* storage blocked */ }
    setEnded(why);
  }, []);

  useEffect(() => {
    if (!meta) return;
    const bump = () => setLastInput(Date.now());
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(tick);
    };
  }, [meta]);

  useEffect(() => {
    if (!meta || ended) return;
    if (msLeft(meta, now) === 0) end("expired");
    else if (isIdle(lastInput, now)) end("idle");
  }, [meta, now, lastInput, ended, end]);

  if (!meta && !ended) return null;

  const s = TOUR_STEPS[step];
  return (
    <>
      {meta && !ended && (
        <>
          <div className="flex items-center gap-3 border-b border-lantern-500/20 bg-lantern-500/5 px-6 py-2 text-sm text-zinc-300">
            <span className="rounded-full bg-lantern-500/10 px-2 py-0.5 text-[11px] text-lantern-400">demo · replay</span>
            <span>Recorded answers, no live model. Your workspace is deleted when the timer ends.</span>
            <span className="ml-auto tabular-nums text-zinc-400" aria-label="Time left in demo">
              {formatClock(msLeft(meta, now))}
            </span>
            <Button variant="ghost" size="sm" onClick={() => end("idle")}>End demo</Button>
          </div>
          <div className="fixed bottom-6 right-6 z-40 w-80 rounded-xl border border-zinc-800 bg-surface-1 p-4 shadow-2xl">
            <p className="text-[11px] uppercase tracking-wide text-zinc-500">Step {step + 1} of {TOUR_STEPS.length}</p>
            <h2 className="mt-1 text-sm font-semibold text-zinc-50">{s.title}</h2>
            <p className="mt-1 text-sm text-zinc-400">{s.body}</p>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => router.push(s.href)}>Take me there</Button>
              <Button size="sm" onClick={() => setStep(nextStep(step))} disabled={step === TOUR_STEPS.length - 1}>Next</Button>
            </div>
          </div>
        </>
      )}
      <Modal
        open={ended !== null}
        onClose={() => router.push("/kiosk")}
        title={ended === "expired" ? "Demo finished" : "Demo ended"}
        description={`Your workspace is being deleted${ended === "idle" ? ` after ${IDLE_LIMIT_MS / 1000}s without input` : ""}.`}
        footer={<Button onClick={() => router.push("/kiosk")}>Start a new demo</Button>}
      >
        <p className="text-sm text-zinc-400">Nothing from this session is kept.</p>
      </Modal>
    </>
  );
}
