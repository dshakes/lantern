"use client";

// The onboarding AGENT conversation (ADR 0051): one chat surface for both
// products. The user says what they want; the server-side agent
// (POST /v1/onboarding/agent/turn) asks follow-ups, picks the next step, calls
// real tools, and hands the parts only a client can do (secure key form,
// consent, live bridge checks, confirmations) to ActionCard. The progress rail
// is a side panel computed from read-back facts. When the agent can't reach the
// model, the page drops to the labelled step-by-step wizard (onUseWizard).

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowUp, Check, CircleSlash, ListChecks, RotateCcw, X } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { PageHeader } from "@/components/page-header";
import { Button, LinkButton } from "@/components/button";
import { Modal } from "@/components/modal";
import { Skeleton } from "@/components/skeleton";
import { AgentMessage, UserMessage, ui } from "./parts";
import { ActionCard } from "./agent-actions";
import {
  decideView,
  latestData,
  optimisticUserMessage,
  railStatuses,
  toolLabel,
  type ChatAction,
  type ChatMessage,
  type ChatProduct,
  type Facts,
  type ToolCall,
  type ToolResult,
  type TurnResponse,
} from "./agent-chat-logic";

const COPY: Record<ChatProduct, { title: string; description: string; placeholder: string; mark: string; skip: string }> = {
  runtime: {
    title: "Set up your first agent",
    description: "Tell the onboarding agent what you want. It designs, creates and runs it with you.",
    placeholder: "e.g. an agent that turns my standup notes into a summary",
    mark: "P",
    skip: "/agents",
  },
  pal: {
    title: "Set up pal",
    description: "A conversation with pal's setup agent: channels, your voice, what pal may do.",
    placeholder: "Ask anything, or tell pal what you want it to handle",
    mark: "p",
    skip: "/inbox",
  },
};

export function AgentChat({ product, onUseWizard }: { product: ChatProduct; onUseWizard: (reason: string) => void }) {
  const toast = useToast();
  const copy = COPY[product];
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [facts, setFacts] = useState<Facts | null>(null);
  const [actions, setActions] = useState<ChatAction[]>([]);
  const [calls, setCalls] = useState<ToolCall[]>([]);
  const [mode, setMode] = useState<TurnResponse["mode"]>("agent");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  // The first Brief stays on screen after it reports (it is the payoff, not a form).
  const [brief, setBrief] = useState<ChatAction | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const started = useRef(false);

  const apply = useCallback(
    (r: TurnResponse) => {
      setMessages(r.messages);
      setFacts(r.facts);
      setActions(r.actions);
      const b = r.actions.find((a) => a.tool === "show_brief");
      if (b) setBrief(b);
      setCalls((c) => [...c, ...r.toolCalls]);
      setMode(r.mode);
      const view = decideView(r);
      if (view.kind === "wizard") onUseWizard(view.reason);
    },
    [onUseWizard],
  );

  const send = useCallback(
    async (body: { message?: string; event?: "start" | "resume"; results?: ToolResult[] }) => {
      setBusy(true);
      const opt = body.message ? optimisticUserMessage(body.message) : null;
      if (opt) setMessages((m) => [...m, opt]);
      if (body.results?.length) setActions([]);
      try {
        apply(await api.onboardingAgentTurn({ product, ...body }));
      } catch (err) {
        const view = decideView(null, err);
        if (view.kind === "wizard") onUseWizard(view.reason);
      } finally {
        setBusy(false);
      }
    },
    [apply, onUseWizard, product],
  );

  // Load + resume: show the transcript, then let the agent recap (or greet).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const r = await api.getOnboardingAgent(product);
        setMessages(r.messages);
        setFacts(r.facts);
        setLoading(false);
        await send({ event: r.messages.length ? "resume" : "start" });
      } catch (err) {
        setLoading(false);
        const view = decideView(null, err);
        if (view.kind === "wizard") onUseWizard(view.reason);
      }
    })();
  }, [product, send, onUseWizard]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, actions, busy]);

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void send({ message: text });
  };

  const report = useCallback((r: ToolResult) => void send({ results: [r] }), [send]);

  const resetAll = async () => {
    setConfirmReset(false);
    try {
      await api.resetOnboardingAgent(product);
      if (product === "pal") await api.resetPalOnboarding();
      else await api.resetOnboarding();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start over");
      return;
    }
    setMessages([]);
    setBrief(null);
    setCalls([]);
    setActions([]);
    void send({ event: "start" });
  };

  const rail = railStatuses(product, facts);
  const current = rail.find((r) => r.status === "current");
  const spec = product === "runtime" && facts?.phase === "create" ? facts.runtime?.spec : null;
  const run = latestData<{ runId: string; status: string; output?: string; error?: string }>(calls, "start_run");

  return (
    <div className="min-h-screen bg-surface-0">
      <PageHeader
        title={copy.title}
        description={copy.description}
        badge={mode === "scripted" ? <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400">waiting for a model key</span> : undefined}
        secondaryAction={
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" icon={<ListChecks className="h-3.5 w-3.5" />} onClick={() => onUseWizard("You chose the step-by-step setup.")}>
              Step by step
            </Button>
            <Button variant="ghost" size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setConfirmReset(true)}>
              Start over
            </Button>
          </div>
        }
        action={
          <LinkButton href={copy.skip} variant="secondary" className="hidden sm:inline-flex">
            Skip to dashboard
          </LinkButton>
        }
      />
      <div className="mx-auto grid max-w-5xl gap-6 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_240px] lg:gap-10 lg:py-8">
        {/* Rail: compact line on phones, side panel on desktop. */}
        <aside className="sticky top-0 z-10 -mx-4 border-b border-zinc-800 bg-surface-0 px-4 py-3 sm:-mx-6 sm:px-6 lg:order-2 lg:top-8 lg:mx-0 lg:self-start lg:border-0 lg:bg-transparent lg:p-0">
          <p className="text-xs text-zinc-400 lg:hidden">
            {rail.filter((r) => r.status === "done").length} of {rail.length} done · <span className="text-zinc-50">{current ? current.label : "Set up"}</span>
          </p>
          <ol aria-label="Setup progress" className="hidden space-y-4 lg:block">
            {rail.map((s, i) => (
              <li key={s.id} aria-current={s.status === "current" ? "step" : undefined} className="flex gap-3">
                <span
                  className={clsx(
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                    s.status === "done" && "border-pal-400 bg-pal-400 text-on-flame",
                    s.status === "current" && "border-pal-400 text-pal-300 ring-4 ring-pal-500/25",
                    s.status === "todo" && "border-zinc-700 text-zinc-500",
                  )}
                >
                  {s.status === "done" ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
                </span>
                <div>
                  <p className={clsx("text-sm", s.status === "todo" ? "text-zinc-500" : "text-zinc-50", s.status === "current" && "font-medium")}>
                    {s.label}
                    <span className="sr-only">{s.status === "done" ? " (done)" : s.status === "current" ? " (current)" : ""}</span>
                  </p>
                  <p className="text-xs text-zinc-500">{s.hint}</p>
                </div>
              </li>
            ))}
          </ol>
        </aside>

        <main className="min-w-0 pb-40 lg:order-1">
          {loading ? (
            <div className="space-y-4" aria-busy="true" aria-label="Loading the conversation">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <div className="space-y-5" aria-live="polite">
              {messages.map((m, i) => (
                <Bubble key={i} m={m} mark={copy.mark} />
              ))}
              {spec && (
                <section aria-label="Proposed design" className={clsx(ui.panel, "p-4 sm:ml-10")}>
                  <p className="text-sm font-semibold text-zinc-50">{spec.name}</p>
                  {spec.description && <p className="mt-1 text-sm text-zinc-300">{spec.description}</p>}
                  {spec.firstInput?.prompt && (
                    <p className="mt-2 text-xs text-zinc-500">
                      First task: <span className="text-zinc-300">{spec.firstInput.prompt}</span>
                    </p>
                  )}
                  {spec.rationale && <p className="mt-2 text-xs text-zinc-500">{spec.rationale}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => send({ message: "Looks good — create it and run it." })}>
                      Create it
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => inputRef.current?.focus()}>
                      Change something
                    </Button>
                  </div>
                </section>
              )}
              {run?.output && (
                <section aria-label="First run output" className={clsx(ui.panel, "p-4 sm:ml-10")}>
                  <p className="mb-2 text-xs text-zinc-500">Run {run.runId} · {run.status}</p>
                  <p className="whitespace-pre-wrap text-sm text-zinc-200">{run.output}</p>
                </section>
              )}
              {!busy && actions.filter((a) => a.tool !== "show_brief").map((a) => <ActionCard key={a.id} action={a} onReport={report} />)}
              {brief && <ActionCard key={brief.id} action={brief} onReport={report} />}
              {busy && <AgentMessage mark={copy.mark} busy>{null}</AgentMessage>}
              {product === "runtime" && facts?.phase === "done" && (
                <div className="flex flex-wrap gap-2 sm:ml-10">
                  <LinkButton href="/agents" variant="primary">
                    Open your agents
                  </LinkButton>
                  <LinkButton href="/surfaces" variant="secondary">
                    Connect a channel
                  </LinkButton>
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </main>
      </div>

      {/* Composer: pinned to the bottom, thumb-reachable on phones. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-800 bg-surface-0/95 px-4 py-3 sm:px-6">
        <form
          className="mx-auto flex max-w-5xl items-end gap-2 lg:pr-[280px]"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="onb-input" className="sr-only">
            Message the onboarding agent
          </label>
          <textarea
            id="onb-input"
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={copy.placeholder}
            className={clsx(ui.field, "max-h-40 min-h-[44px] resize-none")}
          />
          <Button type="submit" variant="primary" size="lg" disabled={!input.trim() || busy} icon={<ArrowUp className="h-4 w-4" />}>
            Send
          </Button>
        </form>
      </div>

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Start over?"
        description="This clears the conversation and your setup progress. Nothing you created (agents, keys, settings) is deleted."
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
        {null}
      </Modal>
    </div>
  );
}

function Bubble({ m, mark }: { m: ChatMessage; mark: string }) {
  if (m.role === "user") return <UserMessage>{m.text}</UserMessage>;
  if (m.role === "agent") {
    return (
      <AgentMessage mark={mark}>
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</p>
      </AgentMessage>
    );
  }
  const Icon = m.ok === false ? (m.text.startsWith("refused") ? CircleSlash : X) : Check;
  return (
    <div className="flex items-start gap-2 pl-10 text-xs text-zinc-500">
      <Icon className={clsx("mt-0.5 h-3.5 w-3.5 shrink-0", m.ok === false ? ui.warn : ui.ok)} aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="text-zinc-300">{toolLabel(m.tool)}</span> — {m.text}
      </span>
    </div>
  );
}
