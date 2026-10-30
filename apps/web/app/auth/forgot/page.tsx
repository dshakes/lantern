"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Button } from "@/components/button";
import { AuthError, AuthNote, AuthShell, apiErrorMessage, authInputClass } from "../auth-shell";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError("Enter your email.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't send the reset link. Try again."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new one.">
      {error && <AuthError message={error} />}
      {sent ? (
        <AuthNote>
          If that address has an account, a reset link is on its way. It works once and expires in an hour.
        </AuthNote>
      ) : (
        <form onSubmit={submit} className="space-y-3.5">
          <div>
            <label htmlFor="email" className="mb-1 block text-xs font-medium text-zinc-400">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com" autoComplete="email" className={authInputClass} />
          </div>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
            Send reset link
          </Button>
        </form>
      )}
      <div className="mt-4 text-center text-xs text-zinc-500">
        <Link href="/login" className="text-pal-400 transition-colors hover:text-pal-300">Back to sign in</Link>
      </div>
    </AuthShell>
  );
}
