"use client";

// /welcome — first sign-in. Two clear paths: set up pal (your personal
// layer on WhatsApp / iMessage) or build on PAL Runtime. Picking one
// remembers the mode so "/" lands there from now on.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Bot, MessageCircle } from "lucide-react";
import { PalMark } from "@/components/pal-mark";
import { useAuth } from "@/lib/auth";
import { rememberMode } from "@/lib/use-workspace-mode";
import { MODE_HOME, type WorkspaceMode } from "@/lib/workspace-nav";

// pal onboarding is being built on its own branch; until it ships the pal
// path goes to channel pairing. Flip on with NEXT_PUBLIC_PAL_ONBOARDING=1.
const PAL_ONBOARDING = process.env.NEXT_PUBLIC_PAL_ONBOARDING === "1" ? "/pal/onboarding" : "/personal/setup";

export default function WelcomePage() {
  const router = useRouter();
  const { user } = useAuth();
  const pick = (mode: WorkspaceMode, href: string) => {
    rememberMode(mode);
    router.push(href);
  };
  const first = user?.name?.split(" ")[0];

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-0 px-4 py-12">
      <PalMark className="h-11 w-11" />
      <h1 className="mt-5 text-center text-2xl font-semibold tracking-tight text-zinc-50 md:text-3xl">
        Welcome{first ? `, ${first}` : ""}. What would you like PAL to do?
      </h1>
      <p className="mt-2 max-w-md text-center text-sm text-zinc-400">
        You can use both. Pick where to start — switch any time from the sidebar.
      </p>

      <div className="mt-8 grid w-full max-w-3xl gap-4 md:grid-cols-2">
        <PathCard
          title="Your personal pal"
          body="Answers in your voice on WhatsApp and iMessage, holds anything risky for your OK, and briefs you on what needs you."
          cta="Set up pal"
          icon={MessageCircle}
          grad="var(--pal-grad)"
          onClick={() => pick("pal", PAL_ONBOARDING)}
        />
        <PathCard
          title="Build on PAL Runtime"
          body="Describe an agent in plain words. PAL designs it, runs it in a sandbox, and gives you evals, budgets and deploys."
          cta="Build an agent"
          icon={Bot}
          grad="var(--rt-grad)"
          runtime
          onClick={() => pick("runtime", "/onboarding")}
        />
      </div>

      <div className="mt-6 flex gap-4 text-xs text-zinc-500">
        <button onClick={() => pick("pal", MODE_HOME.pal)} className="hover:text-zinc-200">Skip to pal</button>
        <span aria-hidden>·</span>
        <button onClick={() => pick("runtime", MODE_HOME.runtime)} className="hover:text-zinc-200">Skip to Runtime</button>
        <span aria-hidden>·</span>
        <Link href="/settings" className="hover:text-zinc-200">Settings</Link>
      </div>
    </div>
  );
}

function PathCard({
  title, body, cta, icon: Icon, grad, runtime, onClick,
}: {
  title: string;
  body: string;
  cta: string;
  icon: typeof Bot;
  grad: string;
  runtime?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex flex-col rounded-2xl border border-zinc-800 bg-surface-1 p-6 text-left transition-colors hover:border-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pal-400/50 ${runtime ? "theme-runtime" : ""}`}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ backgroundImage: grad }}>
        <Icon className="h-5 w-5" />
      </span>
      <span className="mt-4 text-base font-semibold text-zinc-50">{title}</span>
      <span className="mt-1.5 flex-1 text-sm leading-relaxed text-zinc-400">{body}</span>
      <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-pal-400">
        {cta} <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}
