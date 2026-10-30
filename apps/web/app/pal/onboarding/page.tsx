"use client";

// pal first-run: a conversation with pal's setup guide plus a progress rail.
// welcome (what pal is + consent) → channels (live bridge checks) → voice (a
// draft in the owner's own voice, approved) → trust (auto/ask/off, holds,
// quiet hours) → profile (facts + people, each confirmed) → first Brief.
//
// - Intelligence: the guide, the voice profile + preview, the profile capture
//   and the trust suggestion are LLM calls through the control plane's
//   capability-addressed path (/v1/pal/onboarding/*). The deterministic floor
//   is pal-onboarding-logic.ts: gates, readiness mapping, error → fix.
// - Honesty: every step advances only on a real result — a live bridge check,
//   a 2xx save, a read-back that matches.
// - Resume: facts persist server-side (GET/PUT /v1/pal/onboarding); the resume
//   point is derived from them, channels are re-checked live every session.
// - Bridges: read-only use of existing endpoints through the same-origin
//   proxy (/api/bridge/<channel>/...); the token never reaches the browser.

import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import clsx from "clsx";
import { MessageCircle, RotateCcw, Smartphone } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/toast";
import { PageHeader } from "@/components/page-header";
import { Button, LinkButton } from "@/components/button";
import { Skeleton } from "@/components/skeleton";
import { Modal } from "@/components/modal";
import { AgentMessage, FixCard, Notice, StepCard, UserMessage, ui } from "@/app/onboarding/parts";
import {
  KIND_LABELS,
  LIFE_EVENT_KINDS,
  PAL_CONSENT_VERSION,
  PAL_STEPS,
  canFinishProfile,
  channelsVerified,
  decideBrief,
  decideTrustSaved,
  describeItem,
  imessageFix,
  imessageReadiness,
  liveChannels,
  mayLearnVoice,
  mergeConfirmed,
  palResumeStep,
  palStepIndex,
  palStepStatus,
  parseApiError,
  selectVoiceSamples,
  suggestPalFix,
  toSavable,
  whatsappFix,
  whatsappReadiness,
  type BriefDisplay,
  type BriefSnapshot,
  type ChannelFix,
  type ChannelReport,
  type HistoryHit,
  type PalFix,
  type PalOnboardingState,
  type PalStep,
  type ReviewedProposal,
  type TrustMode,
  type VoicePreview,
  type VoiceProfile,
} from "./pal-onboarding-logic";

type Channel = "whatsapp" | "imessage";

interface Failure {
  step: PalStep;
  fix: PalFix;
}

// Deterministic copy: shown immediately, replaced by the guide's reply when it
// arrives. It is the floor when no model key exists yet.
const FALLBACK: Record<PalStep, string> = {
  welcome:
    "I'm pal. I answer your iMessage and WhatsApp in your own voice and keep a short Brief of what needs you. I run on your Mac and use your own model key. Anything that promises money or claims something I can't check is held for you, always.",
  channels: "Let's connect at least one channel. I'll check each one live and tell you exactly what's missing.",
  voice: "Now your voice. With your OK I read a sample of messages you've sent, describe how you write, and draft a reply so you can judge it.",
  trust: "Decide what I may do on my own. For each kind of life event: act (auto), suggest and wait for a tap (ask), or ignore (off).",
  profile:
    "Tell me about the people and facts I must never get wrong: your partner, kids, key dates, how to address close contacts. I'll turn it into items you confirm one by one.",
  done: "You're set. Text ? to yourself any time for your Brief: what's waiting on you, drafts to approve, promises to keep.",
};

const HOLDS_COPY =
  "Holds are always on: I never send a reply that promises money or commits you to something, a claim I can't verify (a date, an outcome), or a light reply to bad news. Those come to you as drafts, whatever else you set here.";

async function probe<T>(channel: Channel, path: string, init?: RequestInit): Promise<{ reachable: boolean; httpStatus?: number; body?: T }> {
  try {
    const res = await fetch(`/api/bridge/${channel}${path}`, { cache: "no-store", ...init });
    let body: T | undefined;
    try {
      body = (await res.json()) as T;
    } catch {
      body = undefined;
    }
    return { reachable: true, httpStatus: res.status, body };
  } catch {
    return { reachable: false };
  }
}

const stepPos = palStepIndex;
const channelName = (c: Channel) => (c === "imessage" ? "iMessage" : "WhatsApp");

export default function PalOnboardingPage() {
  const toast = useToast();
  const { user } = useAuth();
  const tenantId = user?.tenantId ?? "default";
  const t = encodeURIComponent(tenantId);

  const [loading, setLoading] = useState(true);
  const [doc, setDoc] = useState<PalOnboardingState>({});
  const [step, setStep] = useState<PalStep>("welcome");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [guide, setGuide] = useState<Partial<Record<PalStep, string>>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  // The step whose guide reply is in flight (the deterministic copy shows meanwhile).
  const [guidePending, setGuidePending] = useState<PalStep | null>(null);

  // Channels (live, never persisted as passed).
  const [report, setReport] = useState<ChannelReport | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const pairTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);

  const fail = useCallback((s: PalStep, err: unknown) => setFailure({ step: s, fix: suggestPalFix(parseApiError(err), s) }), []);

  // Saves the document; resolves true ONLY on a real 2xx. A step advances on that.
  const persist = useCallback(
    async (next: PalOnboardingState, s: PalStep): Promise<boolean> => {
      try {
        const saved = await api.savePalOnboarding(toSavable(next));
        setDoc(saved);
        return true;
      } catch (err) {
        fail(s, err);
        return false;
      }
    },
    [fail],
  );

  const goTo = useCallback((s: PalStep) => {
    setFailure(null);
    setStep(s);
  }, []);

  useEffect(() => {
    if (!loading) headingRef.current?.focus();
  }, [step, loading]);

  // ---- guide (LLM) ------------------------------------------------------------

  const askGuide = useCallback(async (s: PalStep, message: string, context = ""): Promise<string | null> => {
    try {
      const { reply } = await api.palGuide({ step: s, message, context });
      return reply?.trim() || null;
    } catch {
      return null; // deterministic copy stays
    }
  }, []);

  const guidedSteps = useRef(new Set<string>());
  useEffect(() => {
    if (loading || guidedSteps.current.has(step)) return;
    guidedSteps.current.add(step);
    setGuidePending(step);
    const prompt =
      step === "welcome" ? "Introduce yourself to a new owner and explain what you'll touch before asking for consent." : `We just reached the ${step} step. Tell me what happens here.`;
    void askGuide(step, prompt).then((r) => {
      if (r) setGuide((g) => ({ ...g, [step]: r }));
      setGuidePending((p) => (p === step ? null : p));
    });
  }, [step, loading, askGuide]);

  // ---- channels (live checks via existing bridge endpoints) --------------------

  const checkChannels = useCallback(async (): Promise<ChannelReport> => {
    const [wa, im] = await Promise.all([
      probe<{ status?: string; paired?: boolean }>("whatsapp", `/session/${t}/status`),
      probe<{ state?: string; reason?: string | null }>("imessage", `/session/${t}/diagnostics`),
    ]);
    const r: ChannelReport = {
      whatsapp: whatsappReadiness({ reachable: wa.reachable, httpStatus: wa.httpStatus, status: wa.body }),
      imessage: imessageReadiness({ reachable: im.reachable, httpStatus: im.httpStatus, diagnostics: im.body }),
    };
    setReport(r);
    return r;
  }, [t]);

  const stopPairing = useCallback(() => {
    if (pairTimer.current) clearInterval(pairTimer.current);
    pairTimer.current = null;
    setQr(null);
  }, []);
  useEffect(() => stopPairing, [stopPairing]);

  const startIMessage = async () => {
    setBusy("imessage");
    await probe("imessage", `/session/${t}/start`, { method: "POST" });
    await checkChannels();
    setBusy(null);
  };

  const pairWhatsApp = async () => {
    setBusy("whatsapp");
    stopPairing();
    const started = await probe("whatsapp", `/session/${t}/start`, { method: "POST" });
    setBusy(null);
    if (!started.reachable || (started.httpStatus ?? 500) >= 300) {
      await checkChannels();
      return;
    }
    const deadline = Date.now() + 3 * 60_000;
    pairTimer.current = setInterval(async () => {
      const q = await probe<{ qr?: string | null; paired?: boolean }>("whatsapp", `/session/${t}/qr`);
      if (q.body?.qr) setQr(q.body.qr);
      const r = await checkChannels();
      if (r.whatsapp === "connected" || Date.now() > deadline) stopPairing();
    }, 2000);
  };

  // Explain a blocked channel check once per distinct report.
  const explained = useRef("");
  useEffect(() => {
    if (step !== "channels" || !report || channelsVerified(report)) return;
    const sig = `${report.whatsapp}/${report.imessage}`;
    if (explained.current === sig) return;
    explained.current = sig;
    void askGuide("channels", "Neither channel is ready yet. What exactly should I fix first?", `Live checks: WhatsApp=${report.whatsapp}; iMessage=${report.imessage}`).then(
      (r) => r && setGuide((g) => ({ ...g, channels: r })),
    );
  }, [step, report, askGuide]);

  // ---- load + resume ------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await api.getPalOnboarding();
        if (cancelled) return;
        setDoc(saved);
        const target = saved.resumeStep ?? palResumeStep(saved);
        setStep(target);
        if (target === "channels" || target === "done") void checkChannels();
      } catch (err) {
        if (!cancelled) fail("welcome", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checkChannels, fail]);

  // ---- welcome → channels ---------------------------------------------------------

  const giveConsent = async (voiceSampling: boolean) => {
    setBusy("consent");
    const next: PalOnboardingState = {
      ...doc,
      step: "channels",
      consent: { version: PAL_CONSENT_VERSION, acceptedAt: new Date().toISOString(), voiceSampling },
    };
    if (await persist(next, "welcome")) {
      goTo("channels");
      void checkChannels();
    }
    setBusy(null);
  };

  const channelsContinue = async () => {
    const r = await checkChannels(); // re-verify at the moment of advancing
    if (!channelsVerified(r)) return;
    stopPairing();
    if (await persist({ ...doc, step: "voice", channels: { whatsapp: r.whatsapp, imessage: r.imessage } }, "channels")) goTo("voice");
  };

  // ---- voice ------------------------------------------------------------------------

  const [voice, setVoice] = useState<{ profile: VoiceProfile; preview: VoicePreview; sampleCount: number } | null>(null);
  const [correction, setCorrection] = useState("");

  const learnVoice = async (fixNote?: string) => {
    if (!mayLearnVoice(doc)) return; // consent gate (the server enforces it too)
    setBusy("voice");
    setFailure(null);
    try {
      const r = report ?? (await checkChannels());
      const since = Date.now() - 60 * 24 * 3600_000;
      const hits: HistoryHit[] = [];
      for (const ch of liveChannels(r)) {
        const path = ch === "imessage" ? `/session/${t}/imessage/search` : `/session/${t}/whatsapp/search`;
        for (const window of [
          { sinceMs: Date.now() - 14 * 24 * 3600_000 },
          { sinceMs: since, untilMs: Date.now() - 14 * 24 * 3600_000 },
        ]) {
          const res = await probe<{ results?: HistoryHit[] }>(ch, path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...window, limit: 50 }),
          });
          hits.push(...(res.body?.results ?? []));
        }
      }
      const samples = selectVoiceSamples(doc, hits);
      const out = await api.palLearnVoice({ samples, ownerName: user?.name?.split(" ")[0], correction: fixNote });
      setVoice(out);
      setCorrection("");
    } catch (err) {
      fail("voice", err);
    } finally {
      setBusy(null);
    }
  };

  const approveVoice = async () => {
    if (!voice) return;
    const next: PalOnboardingState = { ...doc, step: "trust", voice: { profile: voice.profile, preview: voice.preview, sampleCount: voice.sampleCount, approved: true } };
    if (await persist(next, "voice")) goTo("trust");
  };

  const skipVoice = async () => {
    if (await persist({ ...doc, step: "trust", voice: { skipped: true } }, "voice")) goTo("trust");
  };

  const enableVoiceSampling = async () => {
    if (!doc.consent) return;
    await persist({ ...doc, step: "voice", consent: { ...doc.consent, voiceSampling: true } }, "voice");
  };

  // ---- trust --------------------------------------------------------------------------

  const [modes, setModes] = useState<Record<string, TrustMode>>({});
  const [quiet, setQuiet] = useState<{ start?: number; end?: number }>({});
  const [holdsAck, setHoldsAck] = useState(false);
  const [trustWhy, setTrustWhy] = useState<string | null>(null);

  useEffect(() => {
    if (step !== "trust") return;
    setQuiet({ start: doc.trust?.quietStart, end: doc.trust?.quietEnd });
    setHoldsAck(!!doc.trust?.holdsAcknowledged);
    api
      .getLifeEventPrefs()
      .then((prefs) => setModes(Object.fromEntries(prefs.map((p) => [p.kind, p.mode as TrustMode]))))
      .catch((err) => fail("trust", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const suggestTrust = async (text: string) => {
    setBusy("trust-suggest");
    setFailure(null);
    try {
      const s = await api.palSuggestTrust(text);
      setModes((m) => ({ ...m, ...s.modes }));
      if (typeof s.quietStart === "number" && typeof s.quietEnd === "number") setQuiet({ start: s.quietStart, end: s.quietEnd });
      setTrustWhy(s.why || null);
    } catch (err) {
      fail("trust", err);
    } finally {
      setBusy(null);
    }
  };

  const saveTrust = async () => {
    setBusy("trust");
    setFailure(null);
    try {
      for (const kind of LIFE_EVENT_KINDS) {
        if (modes[kind]) await api.setLifeEventPref({ kind, mode: modes[kind] });
      }
      const readback = await api.getLifeEventPrefs().catch(() => null);
      const verdict = decideTrustSaved(modes, readback, quiet);
      if (!verdict.ok) {
        setFailure({ step: "trust", fix: { summary: verdict.error, fix: { label: "Try again", action: "retry" } } });
        return;
      }
      const next: PalOnboardingState = {
        ...doc,
        step: "profile",
        trust: { prefsSaved: true, holdsAcknowledged: true, quietStart: quiet.start, quietEnd: quiet.end },
      };
      if (await persist(next, "trust")) goTo("profile");
    } catch (err) {
      fail("trust", err);
    } finally {
      setBusy(null);
    }
  };

  // ---- profile --------------------------------------------------------------------------

  const [review, setReview] = useState<ReviewedProposal[]>([]);
  const [told, setTold] = useState<string[]>([]);

  const extractProfile = async (text: string) => {
    setBusy("profile");
    setFailure(null);
    setTold((x) => [...x, text]);
    try {
      const { items } = await api.palExtractProfile(text);
      if (!items.length) {
        setFailure({ step: "profile", fix: { summary: "I didn't find anything I could save from that. Name the person and how they relate to you, or a date like 2017-06-03.", fix: { label: "Rephrase", action: "rephrase" } } });
      }
      setReview((r) => [...r, ...items.map((item) => ({ item, status: "pending" as const }))]);
    } catch (err) {
      fail("profile", err);
    } finally {
      setBusy(null);
    }
  };

  const decide = async (idx: number, status: "confirmed" | "rejected") => {
    const r = review[idx];
    if (status === "confirmed") {
      const items = mergeConfirmed(doc.profile?.items ?? [], [r.item]);
      // Confirmed only once the server has it.
      if (!(await persist({ ...doc, step: "profile", profile: { ...doc.profile, items } }, "profile"))) return;
    }
    setReview((list) => list.map((x, i) => (i === idx ? { ...x, status } : x)));
  };

  const finishProfile = async () => {
    if (!canFinishProfile(review)) return;
    if (await persist({ ...doc, step: "done", profile: { items: doc.profile?.items ?? [], done: true } }, "profile")) {
      goTo("done");
      void checkChannels();
    }
  };

  // ---- done: the first Brief --------------------------------------------------------------

  const [brief, setBrief] = useState<BriefDisplay>({ kind: "waiting" });
  useEffect(() => {
    if (step !== "done" || !report) return;
    const chans = liveChannels(report);
    if (!chans.length) return;
    let stop = false;
    const tick = async () => {
      const snaps = await Promise.all(chans.map((c) => probe<BriefSnapshot>(c, `/session/${t}/attention`).then((p) => p.body ?? null)));
      if (!stop) setBrief(decideBrief(snaps));
    };
    void tick();
    const id = setInterval(tick, 5000);
    const off = setTimeout(() => clearInterval(id), 10 * 60_000);
    return () => {
      stop = true;
      clearInterval(id);
      clearTimeout(off);
    };
  }, [step, report, t]);

  // ---- fixes ------------------------------------------------------------------------------

  const applyFix = (f: Failure) => {
    switch (f.fix.fix.action) {
      case "add_key":
        window.location.href = "/settings";
        return;
      case "login":
        window.location.href = "/login";
        return;
      case "check_api":
        window.location.reload();
        return;
      case "review_consent":
        goTo("welcome");
        return;
      case "skip_voice":
        void skipVoice();
        return;
      case "recheck_channels":
        setFailure(null);
        void checkChannels();
        return;
      case "retry":
        setFailure(null);
        if (f.step === "voice") void learnVoice();
        if (f.step === "trust") void saveTrust();
        return;
      case "rephrase":
        setFailure(null);
        return;
    }
  };

  const resetAll = async () => {
    setConfirmReset(false);
    stopPairing();
    try {
      await api.resetPalOnboarding();
    } catch (err) {
      toast.error(parseApiError(err).message);
      return;
    }
    setDoc({});
    setVoice(null);
    setReview([]);
    setTold([]);
    guidedSteps.current.clear();
    setGuide({});
    goTo("welcome");
  };

  // ---- render -------------------------------------------------------------------------------

  if (loading) {
    return (
      <Shell step="welcome" blocked={false} onReset={() => {}}>
        <div className="space-y-4" aria-busy="true" aria-label="Loading your progress">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-28 w-full" />
        </div>
      </Shell>
    );
  }

  const reached = (s: PalStep) => stepPos(s) <= stepPos(step);
  const fixFor = (s: PalStep) => (failure?.step === s ? <FixCard failure={failure.fix} onFix={() => applyFix(failure)} busy={busy !== null} /> : null);
  const say = (s: PalStep) => guide[s] ?? FALLBACK[s];
  const blocked = !!failure || (step === "channels" && !!report && !channelsVerified(report));

  return (
    <Shell step={step} blocked={blocked} onReset={() => setConfirmReset(true)}>
      <div className="space-y-6">
        {/* welcome */}
        <AgentMessage mark="p" busy={guidePending === "welcome"}>
          <p>{say("welcome")}</p>
        </AgentMessage>
        {step === "welcome" && (
          <>
            <AskBox step="welcome" ask={askGuide} />
            <ConsentCard ref={headingRef} busy={busy === "consent"} initialVoice={doc.consent?.voiceSampling ?? false} onConsent={giveConsent} />
            {fixFor("welcome")}
          </>
        )}
        {stepPos(step) > stepPos("welcome") && doc.consent && (
          <UserMessage>
            I agree{doc.consent.voiceSampling ? ", and you may learn my voice from messages I've sent." : ". Don't read my sent messages to learn my voice."}
          </UserMessage>
        )}

        {/* channels */}
        {reached("channels") && (
          <>
            <AgentMessage mark="p">
              <p>{say("channels")}</p>
            </AgentMessage>
            {step === "channels" && (
              <StepCard ref={headingRef} title="Connect a channel">
                <div className="space-y-3">
                  <ChannelRow
                    icon={<MessageCircle className="h-4 w-4" aria-hidden />}
                    name="iMessage"
                    fix={report ? imessageFix(report.imessage) : null}
                    busy={busy === "imessage"}
                    onAction={(a) => (a === "start_imessage" ? void startIMessage() : void checkChannels())}
                  />
                  <ChannelRow
                    icon={<Smartphone className="h-4 w-4" aria-hidden />}
                    name="WhatsApp"
                    fix={report ? whatsappFix(report.whatsapp) : null}
                    busy={busy === "whatsapp" || !!pairTimer.current}
                    onAction={(a) => (a === "pair_whatsapp" ? void pairWhatsApp() : void checkChannels())}
                  />
                  {qr && (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-zinc-800 bg-white p-4">
                      {/* The bridge's own QR (PNG data URL). */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={qr} alt="WhatsApp pairing QR code" className="h-56 w-56" />
                      <p className="text-xs text-zinc-900">WhatsApp → Settings → Linked devices → Link a device</p>
                    </div>
                  )}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="primary" disabled={!channelsVerified(report)} onClick={channelsContinue}>
                    Continue
                  </Button>
                  <Button variant="ghost" onClick={() => void checkChannels()}>
                    Check again
                  </Button>
                </div>
              </StepCard>
            )}
            {fixFor("channels")}
            {stepPos(step) > stepPos("channels") && (
              <Notice tone="ok">
                Connected: {[doc.channels?.imessage === "ready" && "iMessage", doc.channels?.whatsapp === "connected" && "WhatsApp"].filter(Boolean).join(" and ") || "verified"}
              </Notice>
            )}
          </>
        )}

        {/* voice */}
        {reached("voice") && (
          <>
            <AgentMessage mark="p">
              <p>{say("voice")}</p>
            </AgentMessage>
            {step === "voice" && (
              <StepCard ref={headingRef} title="Learn your voice">
                {!mayLearnVoice(doc) ? (
                  <div className="space-y-3">
                    <Notice tone="off">You didn&apos;t allow me to read your sent messages, so I won&apos;t. I&apos;ll learn gradually from the drafts you approve instead.</Notice>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="primary" onClick={skipVoice}>
                        Continue without it
                      </Button>
                      <Button variant="ghost" onClick={enableVoiceSampling}>
                        Allow voice learning
                      </Button>
                    </div>
                  </div>
                ) : !voice ? (
                  <div className="space-y-3">
                    <p className={ui.muted}>
                      I&apos;ll read up to 80 of your own 1:1 messages from the last two months on {liveChannels(report).map(channelName).join(" and ") || "your connected channel"}, once. They&apos;re not stored; only the description below is.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="primary" loading={busy === "voice"} onClick={() => void learnVoice()}>
                        Learn my voice
                      </Button>
                      <Button variant="ghost" onClick={skipVoice}>
                        Skip
                      </Button>
                    </div>
                  </div>
                ) : (
                  <VoiceReview
                    voice={voice}
                    busy={busy === "voice"}
                    correction={correction}
                    setCorrection={setCorrection}
                    onApprove={approveVoice}
                    onRetry={() => void learnVoice(correction)}
                    onSkip={skipVoice}
                  />
                )}
              </StepCard>
            )}
            {fixFor("voice")}
            {stepPos(step) > stepPos("voice") && (
              <Notice tone={doc.voice?.approved ? "ok" : "off"}>
                {doc.voice?.approved ? `Voice approved (${doc.voice.profile?.register}, ${doc.voice.profile?.sentenceLength}).` : "Voice learning skipped."}
              </Notice>
            )}
          </>
        )}

        {/* trust */}
        {reached("trust") && (
          <>
            <AgentMessage mark="p">
              <p>{say("trust")}</p>
            </AgentMessage>
            {step === "trust" && (
              <StepCard ref={headingRef} title="Set trust">
                <AskInline
                  placeholder="In your words, e.g. “handle deliveries and codes yourself, ask me about anything with money, quiet after 10pm”"
                  busy={busy === "trust-suggest"}
                  onSubmit={suggestTrust}
                  cta="Suggest settings"
                />
                {trustWhy && <p className="mt-2 text-xs text-zinc-400">{trustWhy}</p>}
                <div className="mt-4 divide-y divide-zinc-800 rounded-lg border border-zinc-800">
                  {LIFE_EVENT_KINDS.map((k) => (
                    <div key={k} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className="text-sm text-zinc-200">{KIND_LABELS[k]}</span>
                      <Segmented value={modes[k] ?? "ask"} onChange={(m) => setModes((x) => ({ ...x, [k]: m }))} label={KIND_LABELS[k]} />
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap items-end gap-3">
                  <HourSelect label="Quiet from" value={quiet.start} onChange={(v) => setQuiet((q) => ({ ...q, start: v }))} />
                  <HourSelect label="until" value={quiet.end} onChange={(v) => setQuiet((q) => ({ ...q, end: v }))} />
                </div>
                <div className="mt-4">
                  <Notice tone="warn">{HOLDS_COPY}</Notice>
                  <label className="mt-2 flex items-center gap-2 text-sm text-zinc-200">
                    <input type="checkbox" checked={holdsAck} onChange={(e) => setHoldsAck(e.target.checked)} className="h-4 w-4 accent-pal-500" />
                    Got it
                  </label>
                </div>
                <div className="mt-4">
                  <Button variant="primary" disabled={!holdsAck} loading={busy === "trust"} onClick={saveTrust}>
                    Save and continue
                  </Button>
                </div>
              </StepCard>
            )}
            {fixFor("trust")}
            {stepPos(step) > stepPos("trust") && <Notice tone="ok">Trust settings saved and read back.</Notice>}
          </>
        )}

        {/* profile */}
        {reached("profile") && (
          <>
            <AgentMessage mark="p">
              <p>{say("profile")}</p>
            </AgentMessage>
            {told.map((x, i) => (
              <UserMessage key={i}>{x}</UserMessage>
            ))}
            {step === "profile" && (
              <StepCard ref={headingRef} title="Your people and facts">
                {(doc.profile?.items?.length ?? 0) > 0 && (
                  <ul className="mb-3 space-y-1">
                    {doc.profile!.items!.map((it) => (
                      <li key={`${it.section}:${it.key}`} className="text-sm text-zinc-200">
                        <span className={ui.ok}>✓</span> {describeItem(it)}
                      </li>
                    ))}
                  </ul>
                )}
                <AskInline placeholder="e.g. “I'm married to Sam, our kids are Kai and Nia. My brother Shiva — never call him bro.”" busy={busy === "profile"} onSubmit={extractProfile} cta="Add" multiline />
                {review.some((r) => r.status === "pending") && (
                  <ul className="mt-4 space-y-2">
                    {review.map((r, i) =>
                      r.status !== "pending" ? null : (
                        <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-sm text-zinc-50">{describeItem(r.item)}</p>
                            <p className="text-xs text-zinc-500">from “{r.item.quote}”</p>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" variant="primary" onClick={() => void decide(i, "confirmed")}>
                              Right
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => void decide(i, "rejected")}>
                              Wrong
                            </Button>
                          </div>
                        </li>
                      ),
                    )}
                  </ul>
                )}
                <div className="mt-4">
                  <Button variant={(doc.profile?.items?.length ?? 0) > 0 ? "primary" : "secondary"} disabled={!canFinishProfile(review)} onClick={finishProfile}>
                    {(doc.profile?.items?.length ?? 0) > 0 ? "Done" : "Skip for now"}
                  </Button>
                </div>
              </StepCard>
            )}
            {fixFor("profile")}
          </>
        )}

        {/* done */}
        {step === "done" && (
          <>
            <AgentMessage mark="p">
              <p>{say("done")}</p>
            </AgentMessage>
            <StepCard ref={headingRef} title="Your first Brief">
              {brief.kind === "ready" ? (
                brief.items.length ? (
                  <ol className="space-y-1.5">
                    {brief.items.map((it) => (
                      <li key={it.n} className="text-sm text-zinc-200">
                        <span className="mr-1">{it.icon}</span>
                        {it.n}. {it.label}
                        {it.why && <span className="text-zinc-500"> · {it.why}</span>}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <Notice tone="ok">Nothing needs you right now ({brief.channel}).</Notice>
                )
              ) : (
                <Notice tone="off">
                  Text <span className="font-mono">?</span> to yourself on {liveChannels(report).map(channelName).join(" or ") || "a connected channel"}. Your Brief shows up here as soon as it&apos;s built.
                </Notice>
              )}
              <div className="mt-4 space-y-2 text-sm text-zinc-300">
                <p>
                  Apply what you set here to this Mac with <span className={ui.mono}>pal setup --apply</span>: it writes your people and facts into your profile and your quiet hours and voice setting into the bridge config, then tells you how to restart the bridge.
                </p>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <LinkButton href="/inbox" variant="primary">
                  Open Inbox
                </LinkButton>
                <LinkButton href="/automations" variant="secondary">
                  Automations
                </LinkButton>
              </div>
            </StepCard>
          </>
        )}
      </div>

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Start over?" description="This clears your setup progress. Channels, trust settings and messages are untouched." size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={resetAll}>
              Start over
            </Button>
          </>
        }
      >
        <span />
      </Modal>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Shell({ step, blocked, onReset, children }: { step: PalStep; blocked: boolean; onReset: () => void; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-0">
      <PageHeader
        title="Set up pal"
        description="Connect your channels, teach pal your voice, decide what it may do."
        secondaryAction={
          <Button variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onReset}>
            Start over
          </Button>
        }
        action={
          <LinkButton href="/inbox" variant="secondary">
            Skip to dashboard
          </LinkButton>
        }
      />
      <div className="mx-auto grid max-w-5xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12 lg:py-10">
        <aside className="sticky top-0 z-10 -mx-4 border-b border-zinc-800 bg-surface-0 px-4 py-3 sm:-mx-6 sm:px-6 lg:top-10 lg:mx-0 lg:self-start lg:border-0 lg:bg-transparent lg:p-0">
          <PalRail current={step} blocked={blocked} />
        </aside>
        <main className="min-w-0 max-w-2xl pb-24">{children}</main>
      </div>
    </div>
  );
}

function PalRail({ current, blocked }: { current: PalStep; blocked: boolean }) {
  const idx = palStepIndex(current);
  const cur = PAL_STEPS[idx];
  return (
    <>
      <p className="text-xs text-zinc-400 lg:hidden">
        Step {idx + 1} of {PAL_STEPS.length}: <span className="text-zinc-50">{cur.label}</span>
      </p>
      <ol aria-label="Setup progress" className="hidden space-y-5 lg:block">
        {PAL_STEPS.map((s, i) => {
          const st = palStepStatus(s.id, current);
          return (
            <li key={s.id} aria-current={st === "current" ? "step" : undefined} className="flex gap-3">
              <span
                className={clsx(
                  "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                  st === "done" && "border-pal-400 bg-pal-400 text-on-flame",
                  st === "current" && !blocked && "border-pal-400 text-pal-300 ring-4 ring-pal-500/25",
                  st === "current" && blocked && "border-amber-400 text-amber-400 ring-4 ring-amber-400/15",
                  st === "todo" && "border-zinc-700 text-zinc-500",
                )}
              >
                {st === "done" ? "✓" : i + 1}
              </span>
              <div>
                <p className={clsx("text-sm", st === "todo" ? "text-zinc-500" : "text-zinc-50", st === "current" && "font-medium")}>{s.label}</p>
                <p className="text-xs text-zinc-500">{s.hint}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function ConsentCard({
  ref,
  busy,
  initialVoice,
  onConsent,
}: {
  ref: Ref<HTMLHeadingElement>;
  busy: boolean;
  initialVoice: boolean;
  onConsent: (voiceSampling: boolean) => void;
}) {
  const [agree, setAgree] = useState(false);
  const [voice, setVoice] = useState(initialVoice);
  return (
    <StepCard ref={ref} title="Your consent">
      <div className="space-y-3 text-sm text-zinc-200">
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 h-4 w-4 accent-pal-500" />
          <span>pal may read my iMessage and WhatsApp on this Mac and reply as me, sending conversation text to my own model provider to write replies. I can mute it or stop it any time.</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} className="mt-0.5 h-4 w-4 accent-pal-500" />
          <span>
            <span className="text-zinc-50">Optional:</span> learn my voice from messages I&apos;ve sent. Read once, not stored; only a short description of how I write is kept.
          </span>
        </label>
      </div>
      <div className="mt-4">
        <Button variant="primary" disabled={!agree} loading={busy} onClick={() => onConsent(voice)}>
          I agree, continue
        </Button>
      </div>
    </StepCard>
  );
}

function AskBox({ step, ask }: { step: PalStep; ask: (s: PalStep, m: string) => Promise<string | null> }) {
  const [turns, setTurns] = useState<Array<{ q: string; a: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      {turns.map((x, i) => (
        <div key={i} className="space-y-4">
          <UserMessage>{x.q}</UserMessage>
          <AgentMessage mark="p">
            <p>{x.a ?? "I couldn't answer that right now. The consent below says exactly what I'll do."}</p>
          </AgentMessage>
        </div>
      ))}
      <AskInline
        placeholder="Ask anything first, e.g. “what do you store?”"
        busy={busy}
        cta="Ask"
        onSubmit={async (q) => {
          setBusy(true);
          const a = await ask(step, q);
          setTurns((x) => [...x, { q, a }]);
          setBusy(false);
        }}
      />
    </div>
  );
}

function AskInline({
  placeholder,
  busy,
  onSubmit,
  cta,
  multiline,
}: {
  placeholder: string;
  busy: boolean;
  onSubmit: (text: string) => void | Promise<void>;
  cta: string;
  multiline?: boolean;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    const v = text.trim();
    if (!v || busy) return;
    setText("");
    void onSubmit(v);
  };
  return (
    <form
      className="flex flex-col gap-2 sm:ml-10 sm:flex-row"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {multiline ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} rows={3} className={ui.field} aria-label={placeholder} />
      ) : (
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className={ui.field} aria-label={placeholder} />
      )}
      <Button type="submit" variant="secondary" loading={busy} disabled={!text.trim()}>
        {cta}
      </Button>
    </form>
  );
}

function ChannelRow({
  icon,
  name,
  fix,
  busy,
  onAction,
}: {
  icon: ReactNode;
  name: string;
  fix: ChannelFix | null;
  busy: boolean;
  onAction: (a: NonNullable<ChannelFix["action"]>) => void;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className={clsx("mt-0.5", fix?.ok ? ui.ok : "text-zinc-400")}>{icon}</span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-50">{name}</p>
            <p className={clsx("text-sm", fix?.ok ? ui.ok : "text-zinc-300")}>{fix ? fix.title : "Checking…"}</p>
          </div>
        </div>
        {fix && !fix.ok && fix.action && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => onAction(fix.action!)}>
            {fix.action === "pair_whatsapp" ? "Show QR" : fix.action === "start_imessage" ? "Check permissions" : "Check again"}
          </Button>
        )}
      </div>
      {fix && !fix.ok && fix.steps.length > 0 && (
        <ol className="mt-2 list-decimal space-y-1 pl-10 text-xs text-zinc-400">
          {fix.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

function VoiceReview({
  voice,
  busy,
  correction,
  setCorrection,
  onApprove,
  onRetry,
  onSkip,
}: {
  voice: { profile: VoiceProfile; preview: VoicePreview; sampleCount: number };
  busy: boolean;
  correction: string;
  setCorrection: (s: string) => void;
  onApprove: () => void;
  onRetry: () => void;
  onSkip: () => void;
}) {
  const p = voice.profile;
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-xs text-zinc-500">From {voice.sampleCount} messages you sent:</p>
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-zinc-200">
          <li>
            {p.register.replace("-", " ")}, {p.sentenceLength}, {p.warmth}
          </li>
          {p.languageMix && <li>Language: {p.languageMix}</li>}
          {p.emojiUse && <li>Emoji: {p.emojiUse}</li>}
          {(p.patterns ?? []).map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
      <div className="space-y-2 rounded-lg border border-zinc-800 bg-surface-2 p-3">
        <p className="text-xs text-zinc-500">If a friend sent:</p>
        <p className="max-w-[85%] rounded-2xl rounded-bl-md bg-surface-3 px-3 py-2 text-sm text-zinc-50">{voice.preview.inbound}</p>
        <p className="text-right text-xs text-zinc-500">I&apos;d reply, as you:</p>
        <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-pal-500/20 px-3 py-2 text-sm text-zinc-50">{voice.preview.draft}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onApprove}>
          Sounds like me
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          Skip
        </Button>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          onRetry();
        }}
      >
        <input value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder="Not quite? Say what's off, e.g. “I never use emoji”" className={ui.field} aria-label="What's off about the draft" />
        <Button type="submit" variant="secondary" loading={busy}>
          Try again
        </Button>
      </form>
    </div>
  );
}

function Segmented({ value, onChange, label }: { value: TrustMode; onChange: (m: TrustMode) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-zinc-700 p-0.5">
      {(["auto", "ask", "off"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={clsx("rounded-md px-2.5 py-1 text-xs", value === m ? "bg-surface-3 text-zinc-50" : "text-zinc-400 hover:text-zinc-200")}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function HourSelect({ label, value, onChange }: { label: string; value?: number; onChange: (v?: number) => void }) {
  return (
    <label className="text-xs text-zinc-300">
      <span className={ui.label}>{label}</span>
      <select
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className={clsx(ui.field, "w-32")}
      >
        <option value="">not set</option>
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h}>
            {String(h).padStart(2, "0")}:00
          </option>
        ))}
      </select>
    </label>
  );
}
