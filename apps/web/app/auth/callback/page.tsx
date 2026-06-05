"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get("code");
    const token = searchParams.get("token"); // legacy fallback
    const errorParam = searchParams.get("error");

    if (errorParam) {
      setError(errorParam);
      setTimeout(() => router.replace("/login"), 3000);
      return;
    }

    // Full reload after auth so AuthProvider re-runs its mount effect and
    // fetches /auth/me with the new token (router.replace keeps stale user).
    const finish = () => window.location.replace("/agents");

    if (code) {
      // Preferred: exchange the one-time code for a JWT (token is never in the
      // URL). The code is single-use and expires in ~60s.
      api
        .exchangeOAuthCode(code)
        .then(finish)
        .catch(() => {
          setError("Sign-in link expired or already used");
          setTimeout(() => router.replace("/login"), 3000);
        });
    } else if (token) {
      api.setToken(token);
      finish();
    } else {
      setError("No sign-in code received");
      setTimeout(() => router.replace("/login"), 3000);
    }
  }, [searchParams, router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-0">
        <div className="text-center">
          <p className="text-sm text-red-400">{error}</p>
          <p className="mt-2 text-xs text-zinc-500">Redirecting to login...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0">
      <div className="flex items-center gap-3 text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Signing in...</span>
      </div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface-0">
          <div className="flex items-center gap-3 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Signing in...</span>
          </div>
        </div>
      }
    >
      <AuthCallbackInner />
    </Suspense>
  );
}
