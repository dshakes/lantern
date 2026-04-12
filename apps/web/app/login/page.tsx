"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const { login, loginDemo, isAuthenticated } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

  // If already authenticated, redirect
  if (isAuthenticated) {
    router.replace("/agents");
    return null;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password.trim()) {
      setError("Email and password are required");
      return;
    }
    setLoading(true);
    try {
      await login(email, password);
      router.replace("/agents");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Login failed",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleDemo = () => {
    setDemoLoading(true);
    loginDemo();
    router.replace("/agents");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-lantern-400 to-lantern-600 shadow-lg shadow-lantern-500/20">
            <span className="text-xl font-bold text-white leading-none">
              L
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            Sign in to Lantern
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Manage your AI agents and monitor runs
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="email"
              className="mb-1.5 block text-sm font-medium text-zinc-300"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1.5 block text-sm font-medium text-zinc-300"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-lantern-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Signing in...
              </>
            ) : (
              "Sign in"
            )}
          </button>
        </form>

        {/* Divider */}
        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-zinc-800" />
          <span className="text-xs text-zinc-600">or</span>
          <div className="h-px flex-1 bg-zinc-800" />
        </div>

        {/* Demo button */}
        <button
          onClick={handleDemo}
          disabled={demoLoading}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {demoLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading demo...
            </>
          ) : (
            "Continue with demo"
          )}
        </button>

        <p className="mt-4 text-center text-xs text-zinc-600">
          Demo mode uses local mock data -- no gateway required.
        </p>
      </div>
    </div>
  );
}
