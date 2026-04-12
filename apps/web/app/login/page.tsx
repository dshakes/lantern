"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, ArrowRight } from "lucide-react";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const { login, signup, loginDemo, isAuthenticated } = useAuth();

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

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

    if (mode === "signup") {
      if (!name.trim()) { setError("Name is required"); return; }
      if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
      if (password !== confirmPassword) { setError("Passwords do not match"); return; }
    }

    setLoading(true);
    try {
      if (mode === "signup") {
        await signup(email, password, name);
        router.replace("/onboarding");
      } else {
        await login(email, password);
        router.replace("/agents");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
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
      <div className="w-full max-w-[380px]">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-lantern-400 to-lantern-600">
            <span className="text-lg font-bold text-white">L</span>
          </div>
          <h1 className="text-xl font-semibold text-zinc-100">
            {mode === "signin" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {mode === "signin" ? "Sign in to your Lantern workspace" : "Get started in 30 seconds"}
          </p>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-zinc-800/80 bg-surface-1 p-5">
          <form onSubmit={handleSubmit} className="space-y-3.5">
            {error && (
              <div className="flex items-start gap-2 rounded-lg bg-red-500/8 border border-red-500/20 px-3 py-2.5 text-xs text-red-400">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {mode === "signup" && (
              <div>
                <label htmlFor="name" className="mb-1 block text-xs font-medium text-zinc-400">Name</label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                  className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/20"
                />
              </div>
            )}

            <div>
              <label htmlFor="email" className="mb-1 block text-xs font-medium text-zinc-400">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/20"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1 block text-xs font-medium text-zinc-400">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "signup" ? "At least 6 characters" : "••••••••"}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/20"
              />
            </div>

            {mode === "signup" && (
              <div>
                <label htmlFor="confirm" className="mb-1 block text-xs font-medium text-zinc-400">Confirm password</label>
                <input
                  id="confirm"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/20"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-lantern-500 py-2.5 text-sm font-medium text-white transition-all hover:bg-lantern-400 disabled:opacity-50 active:scale-[0.98]"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  {mode === "signup" ? "Create account" : "Sign in"}
                  <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          </form>

          <div className="mt-4 text-center text-xs text-zinc-500">
            {mode === "signin" ? (
              <>
                No account?{" "}
                <button onClick={() => { setMode("signup"); setError(null); }} className="text-lantern-400 hover:text-lantern-300 transition-colors">
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button onClick={() => { setMode("signin"); setError(null); }} className="text-lantern-400 hover:text-lantern-300 transition-colors">
                  Sign in
                </button>
              </>
            )}
          </div>
        </div>

        {/* Divider */}
        <div className="my-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-zinc-800/60" />
          <span className="text-[11px] text-zinc-600">or</span>
          <div className="h-px flex-1 bg-zinc-800/60" />
        </div>

        {/* Demo mode */}
        <button
          onClick={handleDemo}
          disabled={demoLoading}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-800/80 py-2.5 text-sm text-zinc-400 transition-all hover:bg-surface-1 hover:text-zinc-200 disabled:opacity-50 active:scale-[0.98]"
        >
          {demoLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Try the demo"}
        </button>
        <p className="mt-2 text-center text-[11px] text-zinc-600">
          No account needed — explore with sample data
        </p>

        {/* Dev hint */}
        <p className="mt-6 text-center text-[10px] text-zinc-700">
          Dev: admin@lantern.dev / lantern
        </p>
      </div>
    </div>
  );
}
