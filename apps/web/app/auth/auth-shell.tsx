import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { PalMark } from "@/components/pal-mark";

// Shared chrome for the account-lifecycle pages (verify / forgot / reset) —
// the same centered card the login page uses.
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
    <div className="flex min-h-screen items-center justify-center bg-surface-0 px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 text-center">
          <PalMark className="mx-auto mb-4 h-11 w-11" />
          <h1 className="text-xl font-semibold text-zinc-100">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
        </div>
        <div className="rounded-xl border border-zinc-800/80 bg-surface-1 p-5">{children}</div>
      </div>
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
