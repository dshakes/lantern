import type { ReactNode } from "react";
import { AlertCircle, Bot, MessageCircle, ShieldCheck } from "lucide-react";
import { PalMark } from "@/components/pal-mark";

// Shared chrome for every pre-auth page (sign-in, verify / forgot / reset):
// a brand panel on wide screens (the one place the pal gradient fills a
// surface) and the form column. Collapses to the form alone on phones.
export const authInputClass =
  "w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-pal-500/50 focus:ring-1 focus:ring-pal-500/20";

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <AuthFrame>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-50">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
      </div>
      <div className="rounded-xl border border-zinc-800/80 bg-surface-1 p-5">{children}</div>
    </AuthFrame>
  );
}

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-surface-0">
      <aside
        aria-hidden
        className="relative hidden w-[44%] max-w-[620px] flex-col justify-between overflow-hidden p-10 text-white lg:flex"
        style={{ backgroundImage: "var(--pal-grad)" }}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15">
            <PalMark className="h-6 w-6" />
          </span>
          <span className="text-lg font-semibold tracking-tight">PAL</span>
        </div>
        <div>
          <p className="max-w-sm text-3xl font-semibold leading-tight tracking-tight">Your pal for every moment.</p>
          <ul className="mt-8 space-y-4 text-sm text-white/90">
            <li className="flex gap-3">
              <MessageCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span><b className="font-semibold">pal</b> answers in your voice on WhatsApp and iMessage, and briefs you on what needs you.</span>
            </li>
            <li className="flex gap-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Anything about money, promises or facts it can&apos;t verify waits for your OK.</span>
            </li>
            <li className="flex gap-3">
              <Bot className="mt-0.5 h-4 w-4 shrink-0" />
              <span><b className="font-semibold">PAL Runtime</b> runs your own agents in sandboxes — with evals, budgets and deploys.</span>
            </li>
          </ul>
        </div>
        <p className="text-xs text-white/70">Personal Agentic Layer</p>
      </aside>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[400px]">
          <PalMark className="mb-6 h-10 w-10 lg:hidden" />
          {children}
        </div>
      </main>
    </div>
  );
}

export function AuthError({ message }: { message: string }) {
  return (
    <div className="mb-3.5 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2.5 text-xs text-red-400">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function AuthNote({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-zinc-400">{children}</p>;
}

/** Pulls the server's `{"error": "..."}` out of an `API 400: {...}` message. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : "";
  const m = msg.match(/API (\d+): (.*)/);
  if (m?.[1] === "429") return "Too many attempts. Wait a while and try again.";
  try {
    return (m && JSON.parse(m[2]).error) || fallback;
  } catch {
    return fallback;
  }
}
