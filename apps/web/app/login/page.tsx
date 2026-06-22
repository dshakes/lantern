"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Loader2, ArrowRight } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, signup, loginDemo, isAuthenticated } = useAuth();

  // Where to send the user after a successful login. Defaults to /agents.
  // ?next= is set by the 401-redirect in lib/runtime-api + lib/api so that
  // a session expiring mid-task drops the user back where they were.
  // Reject absolute URLs to avoid open-redirect; only same-origin paths.
  const nextPath = (() => {
    const raw = searchParams.get("next");
    if (!raw) return "/agents";
    if (!raw.startsWith("/") || raw.startsWith("//")) return "/agents";
    return raw;
  })();

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

  if (isAuthenticated) {
    router.replace(nextPath);
    return null;
  }

  const handleOAuthLogin = async (provider: string) => {
    setError(null);
    setOauthLoading(provider);
    try {
      const data = await api.oauthStart(provider);
      if (data.redirect_url) {
        window.location.href = data.redirect_url;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("OAuth is not configured")) {
        // Extract the specific error from the API response.
        const match = message.match(/API \d+: (.*)/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]);
            setError(parsed.error || message);
          } catch {
            setError(message);
          }
        } else {
          setError(message);
        }
      } else {
        setError("OAuth requires the API server. Start it with: make run-api");
      }
      setOauthLoading(null);
    }
  };

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
        router.replace(nextPath);
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
    router.replace(nextPath);
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
          {/* Error */}
          {error && (
            <div className="mb-3.5 flex items-start gap-2 rounded-lg bg-red-500/8 border border-red-500/20 px-3 py-2.5 text-xs text-red-400">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Social login buttons */}
          <div className="space-y-2.5">
            <button
              type="button"
              onClick={() => handleOAuthLogin("google")}
              disabled={oauthLoading !== null}
              className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-zinc-700/80 bg-white/[0.03] px-3 py-2.5 text-sm text-zinc-200 transition-all hover:bg-white/[0.07] hover:border-zinc-600 disabled:opacity-50 active:scale-[0.98]"
            >
              {oauthLoading === "google" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <GoogleIcon />
                  Continue with Google
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleOAuthLogin("github")}
              disabled={oauthLoading !== null}
              className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-zinc-700/80 bg-white/[0.03] px-3 py-2.5 text-sm text-zinc-200 transition-all hover:bg-white/[0.07] hover:border-zinc-600 disabled:opacity-50 active:scale-[0.98]"
            >
              {oauthLoading === "github" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <GitHubIcon />
                  Continue with GitHub
                </>
              )}
            </button>
          </div>

          {/* Divider */}
          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-800/60" />
            <span className="text-[11px] text-zinc-600">or</span>
            <div className="h-px flex-1 bg-zinc-800/60" />
          </div>

          {/* Email form */}
          <form onSubmit={handleSubmit} className="space-y-3.5">
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

        {/* Demo mode — only when explicitly enabled at build time. Off by
            default so production never advertises a client-minted demo login. */}
        {process.env.NEXT_PUBLIC_DEMO_MODE === "1" && (
          <>
            {/* Divider */}
            <div className="my-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-zinc-800/60" />
              <span className="text-[11px] text-zinc-600">or</span>
              <div className="h-px flex-1 bg-zinc-800/60" />
            </div>

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
          </>
        )}

        {/* Dev hint -- only visible in development */}
        {process.env.NODE_ENV === "development" && (
          <p className="mt-6 text-center text-[10px] text-zinc-700">
            Dev: admin@lantern.dev / lantern
          </p>
        )}
      </div>
    </div>
  );
}
