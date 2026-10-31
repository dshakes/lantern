"use client";

// Client-run actions of the onboarding agent (ADR 0051). The agent decides WHAT
// happens next; these cards do the parts only the client can: a secure key form
// (the key never enters the chat), the owner's own consent click, live bridge
// checks on this Mac, voice sampling, and the confirmations. Every card calls
// the same real endpoints the step wizard calls and reports back a plain,
// key-free summary. Success is never the default: a card reports ok only on a
// real 2xx / a read-back that matches.

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/button";
import { Notice, StepCard, ui } from "@/app/onboarding/parts";
import {
  KIND_LABELS,
  LIFE_EVENT_KINDS,
  PAL_CONSENT_VERSION,
  decideBrief,
  decideTrustSaved,
  describeItem,
  imessageFix,
  imessageReadiness,
  liveChannels,
  mergeConfirmed,
  parseApiError,
  selectVoiceSamples,
  toSavable,
  whatsappFix,
  whatsappReadiness,
  type BriefDisplay,
  type BriefSnapshot,
  type ChannelReport,
  type HistoryHit,
  type PalOnboardingState,
  type ProfileItem,
  type TrustMode,
  type VoicePreview,
  type VoiceProfile,
} from "@/app/pal/onboarding/pal-onboarding-logic";
import { ACTION_TITLES, channelSummary, toolResult, type ChatAction, type ToolResult } from "./agent-chat-logic";

type Report = (r: ToolResult) => void;

interface CardProps {
  action: ChatAction;
  onReport: Report;
}

const errMsg = (err: unknown) => parseApiError(err).message;

async function probe<T>(channel: "whatsapp" | "imessage", path: string, init?: RequestInit) {
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
    return { reachable: false as const, httpStatus: undefined, body: undefined as T | undefined };
  }
}

function useTenant() {
  const { user } = useAuth();
  return { t: encodeURIComponent(user?.tenantId ?? "default"), firstName: user?.name?.split(" ")[0] };
}

async function checkChannels(t: string): Promise<ChannelReport> {
  const [wa, im] = await Promise.all([
    probe<{ status?: string; paired?: boolean }>("whatsapp", `/session/${t}/status`),
    probe<{ state?: string; reason?: string | null }>("imessage", `/session/${t}/diagnostics`),
  ]);
  return {
    whatsapp: whatsappReadiness({ reachable: wa.reachable, httpStatus: wa.httpStatus, status: wa.body }),
    imessage: imessageReadiness({ reachable: im.reachable, httpStatus: im.httpStatus, diagnostics: im.body }),
  };
}

export function ActionCard({ action, onReport, onHeadingRef }: CardProps & { onHeadingRef?: (el: HTMLHeadingElement | null) => void }) {
  const title = ACTION_TITLES[action.tool] ?? action.tool;
  const body = (() => {
    switch (action.tool) {
      case "collect_provider_key":
        return <ProviderKeyCard action={action} onReport={onReport} />;
      case "ask_consent":
        return <ConsentCard action={action} onReport={onReport} />;
      case "check_channels":
      case "start_imessage":
      case "pair_whatsapp":
        return <ChannelsCard action={action} onReport={onReport} />;
      case "learn_voice":
        return <VoiceCard action={action} onReport={onReport} />;
      case "confirm_trust":
        return <TrustCard action={action} onReport={onReport} />;
      case "confirm_profile":
        return <ProfileCard action={action} onReport={onReport} />;
      case "show_brief":
        return <BriefCard action={action} onReport={onReport} />;
      default:
        return <p className={ui.muted}>This step isn&apos;t available in this version of the dashboard.</p>;
    }
  })();
  return (
    <StepCard ref={onHeadingRef} title={title}>
      {body}
    </StepCard>
  );
}

// ---- model key (never in the chat) -------------------------------------------

function ProviderKeyCard({ action, onReport }: CardProps) {
  const [provider, setProvider] = useState<"anthropic" | "openai">(action.args.provider === "openai" ? "openai" : "anthropic");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveLlmProvider(provider, key.trim());
      const res = await api.testLlmProvider(provider);
      if (!res.success) {
        const why = res.error || "the test call failed";
        setError(why);
        onReport(toolResult(action, false, `the ${provider} key was saved but its test call failed: ${why}`));
        return;
      }
      setKey("");
      onReport(toolResult(action, true, `the ${provider} key was saved and passed a real test call`));
    } catch (err) {
      setError(errMsg(err));
      onReport(toolResult(action, false, `saving the ${provider} key failed: ${errMsg(err)}`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) void save();
      }}
    >
      <p className={ui.muted}>Saved encrypted to your workspace and tested with one real call. It is never added to this conversation.</p>
      <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
        <label>
          <span className={ui.label}>Provider</span>
          <select className={ui.field} value={provider} onChange={(e) => setProvider(e.target.value as "anthropic" | "openai")}>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label>
          <span className={ui.label}>API key</span>
          <input
            className={ui.field}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
            aria-describedby={error ? "key-error" : undefined}
          />
        </label>
      </div>
      {error && (
        <p id="key-error" role="alert" className={clsx("text-sm", ui.bad)}>
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" loading={busy} disabled={!key.trim()}>
        Save and test
      </Button>
    </form>
  );
}

// ---- consent (the owner's own click; the agent can never give it) -----------

function ConsentCard({ action, onReport }: CardProps) {
  const [agree, setAgree] = useState(false);
  const [voice, setVoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .getPalOnboarding()
      .then((d) => setVoice(!!d.consent?.voiceSampling))
      .catch(() => {});
  }, []);
  const give = async () => {
    setBusy(true);
    setError(null);
    try {
      const doc = await api.getPalOnboarding();
      const next: PalOnboardingState = {
        ...doc,
        step: doc.step && doc.step !== "welcome" ? doc.step : "channels",
        consent: { version: PAL_CONSENT_VERSION, acceptedAt: new Date().toISOString(), voiceSampling: voice },
      };
      await api.savePalOnboarding(toSavable(next));
      onReport(toolResult(action, true, `the owner agreed${voice ? " and opted in to voice learning" : "; voice learning: not allowed"}`));
    } catch (err) {
      setError(errMsg(err));
      onReport(toolResult(action, false, `saving consent failed: ${errMsg(err)}`));
    } finally {
      setBusy(false);
    }
  };
  return (
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
      {error && <p role="alert" className={clsx("text-sm", ui.bad)}>{error}</p>}
      <Button variant="primary" disabled={!agree} loading={busy} onClick={give}>
        I agree
      </Button>
    </div>
  );
}

// ---- channels (live, on this Mac) -------------------------------------------

function ChannelsCard({ action, onReport }: CardProps) {
  const { t } = useTenant();
  const [report, setReport] = useState<ChannelReport | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ran = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  const finish = (r: ChannelReport, extra = "") => {
    stop();
    const ok = r.whatsapp === "connected" || r.imessage === "ready";
    onReport(toolResult(action, ok, `${extra}${channelSummary(r)}`, r));
  };

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void (async () => {
      setBusy(true);
      if (action.tool === "start_imessage") {
        await probe("imessage", `/session/${t}/start`, { method: "POST" });
        await new Promise((res) => setTimeout(res, 1500));
      }
      if (action.tool === "pair_whatsapp") {
        const started = await probe("whatsapp", `/session/${t}/start`, { method: "POST" });
        if (started.reachable && (started.httpStatus ?? 500) < 300) {
          setBusy(false);
          const deadline = Date.now() + 3 * 60_000;
          timer.current = setInterval(async () => {
            const q = await probe<{ qr?: string | null }>("whatsapp", `/session/${t}/qr`);
            if (q.body?.qr) setQr(q.body.qr);
            const r = await checkChannels(t);
            setReport(r);
            if (r.whatsapp === "connected") finish(r, "WhatsApp linked. ");
            else if (Date.now() > deadline) finish(r, "WhatsApp wasn't scanned within 3 minutes. ");
          }, 2000);
          return;
        }
      }
      const r = await checkChannels(t);
      setReport(r);
      setBusy(false);
      finish(r);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = report
    ? [
        { name: "iMessage", fix: imessageFix(report.imessage) },
        { name: "WhatsApp", fix: whatsappFix(report.whatsapp) },
      ]
    : [];
  return (
    <div className="space-y-3">
      {busy && !report && <p className={ui.muted}>Checking on this Mac…</p>}
      {rows.map(({ name, fix }) => (
        <Notice key={name} tone={fix.ok ? "ok" : "warn"}>
          <p>
            <span className="font-medium">{name}:</span> {fix.title}
          </p>
          {!fix.ok && fix.steps.length > 0 && (
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-zinc-300">
              {fix.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
        </Notice>
      ))}
      {qr && (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-white p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt="WhatsApp pairing QR code" className="h-56 w-56" />
          <p className="text-xs text-zinc-900">WhatsApp → Settings → Linked devices → Link a device</p>
        </div>
      )}
    </div>
  );
}

// ---- voice (consent-gated on the server too) --------------------------------

function VoiceCard({ action, onReport }: CardProps) {
  const { t, firstName } = useTenant();
  const [voice, setVoice] = useState<{ profile: VoiceProfile; preview: VoicePreview; sampleCount: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");
  const ran = useRef(false);

  const learn = async (note?: string) => {
    setBusy("learn");
    setError(null);
    try {
      const doc = await api.getPalOnboarding();
      const r = await checkChannels(t);
      const hits: HistoryHit[] = [];
      for (const ch of liveChannels(r)) {
        const path = ch === "imessage" ? `/session/${t}/imessage/search` : `/session/${t}/whatsapp/search`;
        for (const window of [
          { sinceMs: Date.now() - 14 * 24 * 3600_000 },
          { sinceMs: Date.now() - 60 * 24 * 3600_000, untilMs: Date.now() - 14 * 24 * 3600_000 },
        ]) {
          const res = await probe<{ results?: HistoryHit[] }>(ch, path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...window, limit: 50 }),
          });
          hits.push(...(res.body?.results ?? []));
        }
      }
      const samples = selectVoiceSamples(doc, hits); // [] without the opt-in
      const out = await api.palLearnVoice({ samples, ownerName: firstName, correction: note });
      setVoice(out);
      setCorrection("");
    } catch (err) {
      setError(errMsg(err));
      onReport(toolResult(action, false, `learning the voice failed: ${errMsg(err)}`));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void learn(action.args.correction || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "skip");
    try {
      const doc = await api.getPalOnboarding();
      const next: PalOnboardingState = approve && voice
        ? { ...doc, step: "trust", voice: { profile: voice.profile, preview: voice.preview, sampleCount: voice.sampleCount, approved: true } }
        : { ...doc, step: "trust", voice: { skipped: true } };
      await api.savePalOnboarding(toSavable(next));
      onReport(toolResult(action, true, approve ? `the owner approved the voice (${voice?.profile.register}, ${voice?.profile.warmth})` : "the owner skipped voice learning"));
    } catch (err) {
      setError(errMsg(err));
      onReport(toolResult(action, false, `saving the voice failed: ${errMsg(err)}`));
    } finally {
      setBusy(null);
    }
  };

  if (busy === "learn") return <p className={ui.muted}>Reading a sample of messages you sent (not stored)…</p>;
  return (
    <div className="space-y-3 text-sm">
      {error && <p role="alert" className={clsx("text-sm", ui.bad)}>{error}</p>}
      {voice && (
        <>
          <p className="text-zinc-300">
            From {voice.sampleCount} messages you sent: {voice.profile.register}, {voice.profile.sentenceLength}, {voice.profile.warmth}
            {voice.profile.languageMix ? ` · ${voice.profile.languageMix}` : ""}
          </p>
          <div className="space-y-2 rounded-lg border border-zinc-800 bg-surface-2 p-3">
            <p className="text-xs text-zinc-500">If a friend sent</p>
            <p className="text-zinc-200">{voice.preview.inbound}</p>
            <p className="text-xs text-zinc-500">pal would reply, as you</p>
            <p className="text-zinc-50">{voice.preview.draft}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={busy === "approve"} onClick={() => decide(true)}>
              Sounds like me
            </Button>
            <Button variant="ghost" loading={busy === "skip"} onClick={() => decide(false)}>
              Skip
            </Button>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (correction.trim()) void learn(correction.trim());
            }}
          >
            <input className={ui.field} value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder="What's off? (e.g. shorter, no emoji)" />
            <Button type="submit" variant="secondary" className="shrink-0 whitespace-nowrap" disabled={!correction.trim()}>
              Try again
            </Button>
          </form>
        </>
      )}
      {!voice && error && (
        <Button variant="ghost" onClick={() => decide(false)} loading={busy === "skip"}>
          Skip voice for now
        </Button>
      )}
    </div>
  );
}

// ---- trust (proposal shown, owner confirms, read-back verifies) -------------

function TrustCard({ action, onReport }: CardProps) {
  const [modes, setModes] = useState<Record<string, TrustMode>>({});
  const [quiet, setQuiet] = useState<{ start?: number; end?: number }>({});
  const [holds, setHolds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .getLifeEventPrefs()
      .then((prefs) => {
        const cur = Object.fromEntries(prefs.map((p) => [p.kind, p.mode as TrustMode]));
        setModes({ ...cur, ...(action.args.modes ?? {}) });
      })
      .catch((err) => setError(errMsg(err)));
    if (typeof action.args.quietStart === "number" && typeof action.args.quietEnd === "number") {
      setQuiet({ start: action.args.quietStart, end: action.args.quietEnd });
    }
  }, [action.args]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const kind of LIFE_EVENT_KINDS) {
        if (modes[kind]) await api.setLifeEventPref({ kind, mode: modes[kind] });
      }
      const readback = await api.getLifeEventPrefs().catch(() => null);
      const verdict = decideTrustSaved(modes, readback, quiet);
      if (!verdict.ok) {
        setError(verdict.error);
        onReport(toolResult(action, false, verdict.error));
        return;
      }
      const doc = await api.getPalOnboarding();
      await api.savePalOnboarding(
        toSavable({ ...doc, step: "profile", trust: { prefsSaved: true, holdsAcknowledged: true, quietStart: quiet.start, quietEnd: quiet.end } }),
      );
      const q = quiet.start !== undefined ? `; quiet hours ${quiet.start}:00–${quiet.end}:00` : "";
      onReport(toolResult(action, true, `trust saved and read back: ${LIFE_EVENT_KINDS.map((k) => `${k}=${modes[k] ?? "ask"}`).join(", ")}${q}`));
    } catch (err) {
      setError(errMsg(err));
      onReport(toolResult(action, false, `saving trust failed: ${errMsg(err)}`));
    } finally {
      setBusy(false);
    }
  };
  const hour = (v: string) => (v === "" ? undefined : Math.max(0, Math.min(23, Number(v))));
  return (
    <div className="space-y-4 text-sm">
      {action.args.why && <p className="text-zinc-300">{action.args.why}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {LIFE_EVENT_KINDS.map((k) => (
          <label key={k} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-surface-2 px-3 py-2">
            <span className="text-zinc-200">{KIND_LABELS[k]}</span>
            <select
              className="rounded-md border border-zinc-700 bg-surface-1 px-2 py-1 text-sm text-zinc-50"
              value={modes[k] ?? "ask"}
              onChange={(e) => setModes((m) => ({ ...m, [k]: e.target.value as TrustMode }))}
            >
              <option value="auto">auto</option>
              <option value="ask">ask</option>
              <option value="off">off</option>
            </select>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className={ui.label}>Quiet from</span>
          <input className={clsx(ui.field, "w-24")} type="number" min={0} max={23} value={quiet.start ?? ""} onChange={(e) => setQuiet((q) => ({ ...q, start: hour(e.target.value) }))} />
        </label>
        <label>
          <span className={ui.label}>until</span>
          <input className={clsx(ui.field, "w-24")} type="number" min={0} max={23} value={quiet.end ?? ""} onChange={(e) => setQuiet((q) => ({ ...q, end: hour(e.target.value) }))} />
        </label>
      </div>
      <label className="flex items-start gap-2 text-zinc-200">
        <input type="checkbox" checked={holds} onChange={(e) => setHolds(e.target.checked)} className="mt-0.5 h-4 w-4 accent-pal-500" />
        <span>
          I understand holds are always on: pal never sends a reply that promises money or commits me to something, a claim it can&apos;t verify, or a light
          reply to bad news. Those come to me as drafts.
        </span>
      </label>
      {error && <p role="alert" className={clsx("text-sm", ui.bad)}>{error}</p>}
      <Button variant="primary" disabled={!holds} loading={busy} onClick={save}>
        Save these
      </Button>
    </div>
  );
}

// ---- profile items (each confirmed by the owner) ----------------------------

function ProfileCard({ action, onReport }: CardProps) {
  const items = useMemo(() => action.args.items ?? [], [action.args.items]);
  const [status, setStatus] = useState<Array<"pending" | "saved" | "skipped">>(items.map(() => "pending"));
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reported = useRef(false);

  useEffect(() => {
    if (reported.current || status.some((s) => s === "pending")) return;
    reported.current = true;
    const saved = items.filter((_, i) => status[i] === "saved").map((it) => describeItem(it));
    onReport(toolResult(action, true, saved.length ? `confirmed and saved: ${saved.join("; ")}` : "the owner saved none of the proposed items"));
  }, [status, items, action, onReport]);

  const decide = async (i: number, save: boolean) => {
    if (save) {
      setBusy(i);
      setError(null);
      try {
        const doc = await api.getPalOnboarding();
        const it = items[i];
        const clean: ProfileItem = { section: it.section, key: it.key, value: it.value, addressAs: it.addressAs, never: it.never };
        await api.savePalOnboarding(toSavable({ ...doc, step: "profile", profile: { ...doc.profile, items: mergeConfirmed(doc.profile?.items ?? [], [clean]) } }));
      } catch (err) {
        setError(errMsg(err));
        setBusy(null);
        return;
      }
      setBusy(null);
    }
    setStatus((s) => s.map((x, j) => (j === i ? (save ? "saved" : "skipped") : x)));
  };

  return (
    <ul className="space-y-2 text-sm">
      {items.map((it, i) => (
        <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-surface-2 px-3 py-2">
          <div className="min-w-0">
            <p className="text-zinc-50">{describeItem(it)}</p>
            <p className="text-xs text-zinc-500">from “{it.quote}”</p>
          </div>
          {status[i] === "pending" ? (
            <div className="flex gap-2">
              <Button size="sm" variant="primary" loading={busy === i} onClick={() => decide(i, true)}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => decide(i, false)}>
                Not right
              </Button>
            </div>
          ) : (
            <span className={clsx("text-xs", status[i] === "saved" ? ui.ok : "text-zinc-500")}>{status[i] === "saved" ? "Saved" : "Skipped"}</span>
          )}
        </li>
      ))}
      {error && <li role="alert" className={clsx("text-sm", ui.bad)}>{error}</li>}
    </ul>
  );
}

// ---- the first Brief ---------------------------------------------------------

function BriefCard({ action, onReport }: CardProps) {
  const { t } = useTenant();
  const [brief, setBrief] = useState<BriefDisplay>({ kind: "waiting" });
  const reported = useRef(false);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const r = await checkChannels(t);
      const chans = liveChannels(r);
      const snaps = await Promise.all(chans.map((c) => probe<BriefSnapshot>(c, `/session/${t}/attention`).then((p) => p.body ?? null)));
      const b = decideBrief(snaps);
      if (stop) return;
      setBrief(b);
      if (!reported.current) {
        reported.current = true;
        onReport(toolResult(action, b.kind === "ready", b.kind === "ready" ? `Brief shown from ${b.channel}: ${b.items.length} item(s)` : "no Brief built yet — the owner can text ? to themselves"));
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);
  if (brief.kind === "waiting") {
    return <p className={ui.muted}>Text <span className={ui.mono}>?</span> to yourself on iMessage or WhatsApp — your Brief is built on demand and shows up here too.</p>;
  }
  return (
    <ul className="space-y-1.5 text-sm">
      {brief.items.length === 0 && <li className="text-zinc-300">Nothing needs you right now.</li>}
      {brief.items.map((it) => (
        <li key={it.n} className="text-zinc-200">
          {it.icon} {it.n}. {it.label}
          {it.why && <span className="text-zinc-500"> · {it.why}</span>}
        </li>
      ))}
    </ul>
  );
}
