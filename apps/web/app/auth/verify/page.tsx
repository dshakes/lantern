"use client";

import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/button";
import { AuthError, AuthNote, AuthShell, apiErrorMessage, authInputClass } from "../auth-shell";

function VerifyEmail() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"verifying" | "done" | "failed">(token ? "verifying" : "failed");
  const [error, setError] = useState<string | null>(token ? null : "This link is missing its token.");
  const [email, setEmail] = useState("");
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  // The token is single-use: never POST it twice (StrictMode double-mounts).
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    api
      .verifyEmail(token)
      .then(() => setState("done"))
      .catch((err) => {
        setError(apiErrorMessage(err, "We couldn't verify this link."));
        setState("failed");
      });
  }, [token]);

  const resend = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setResending(true);
    setError(null);
    try {
      await api.resendVerification(email.trim());
      setResent(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't send a new link. Try again."));
    } finally {
      setResending(false);
    }
  };

  if (state === "verifying") {
    return (
      <AuthShell title="Verifying your email">
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
        </div>
      </AuthShell>
    );
  }

  if (state === "done") {
    return (
      <AuthShell title="Email verified">
        <div className="mb-4 flex items-center gap-2 text-sm text-emerald-400">
          <CheckCircle2 className="h-4 w-4" />
          Your email is confirmed.
        </div>
        <Link href="/login" className="block">
          <Button variant="primary" size="lg" className="w-full">Sign in</Button>
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Link didn't work" subtitle="Verification links work once and expire after 24 hours.">
      {error && <AuthError message={error} />}
      {resent ? (
        <AuthNote>If that address has an account waiting for verification, a new link is on its way.</AuthNote>
      ) : (
        <form onSubmit={resend} className="space-y-3.5">
          <div>
            <label htmlFor="email" className="mb-1 block text-xs font-medium text-zinc-400">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com" autoComplete="email" className={authInputClass} />
          </div>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={resending}>
            Send a new link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
