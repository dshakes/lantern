"use client";

import { Suspense, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/button";
import { AuthError, AuthShell, apiErrorMessage, authInputClass } from "../auth-shell";

function ResetPassword() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : "This link is missing its token. Request a new one.");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 12) return setError("Use a password of at least 12 characters.");
    if (password !== confirm) return setError("The passwords don't match.");
    setLoading(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't reset your password."));
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <AuthShell title="Password updated">
        <div className="mb-4 flex items-center gap-2 text-sm text-emerald-400">
          <CheckCircle2 className="h-4 w-4" />
          You can sign in with your new password.
        </div>
        <Link href="/login" className="block">
          <Button variant="primary" size="lg" className="w-full">Sign in</Button>
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="At least 12 characters.">
      {error && <AuthError message={error} />}
      <form onSubmit={submit} className="space-y-3.5">
        <div>
          <label htmlFor="password" className="mb-1 block text-xs font-medium text-zinc-400">New password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password" className={authInputClass} />
        </div>
        <div>
          <label htmlFor="confirm" className="mb-1 block text-xs font-medium text-zinc-400">Confirm password</label>
          <input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password" className={authInputClass} />
        </div>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} disabled={!token}>
          Update password
        </Button>
      </form>
      <div className="mt-4 text-center text-xs text-zinc-500">
        <Link href="/auth/forgot" className="text-pal-400 transition-colors hover:text-pal-300">Request a new link</Link>
      </div>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPassword />
    </Suspense>
  );
}
