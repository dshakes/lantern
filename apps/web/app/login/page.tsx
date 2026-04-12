"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, Github } from "lucide-react";
import { useAuth } from "@/lib/auth";

type Tab = "signin" | "signup";

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84Z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z"
        fill="#EA4335"
      />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const { login, signup, loginDemo, isAuthenticated } = useAuth();

  const [tab, setTab] = useState<Tab>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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

    if (tab === "signup") {
      if (!name.trim()) {
        setError("Name is required");
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match");
        return;
      }
      if (password.length < 6) {
        setError("Password must be at least 6 characters");
        return;
      }
    }

    setLoading(true);
    try {
      if (tab === "signup") {
        await signup(email, password, name);
        router.replace("/onboarding");
      } else {
        await login(email, password);
        router.replace("/agents");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Authentication failed",
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

  const switchTab = (newTab: Tab) => {
    setTab(newTab);
    setError(null);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 px-4">
      {/* Subtle grid background */}
      <div className="fixed inset-0 grid-bg opacity-50" />

      <div className="relative z-10 w-full max-w-sm">
        {/* Logo */}
        <div className="mb-10 flex flex-col items-center">
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-lantern-400 to-lantern-600 shadow-lg shadow-lantern-500/25">
            <span className="text-2xl font-bold text-white leading-none">
              L
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            {tab === "signin" ? "Sign in to Lantern" : "Create your account"}
          </h1>
          <p className="mt-2 text-sm text-zinc-500">
            {tab === "signin"
              ? "Manage your AI agents and monitor runs"
              : "Get started with Lantern in seconds"}
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-zinc-800 bg-surface-1 p-6 shadow-xl">
          {/* Social login buttons */}
          <div className="space-y-2.5">
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-zinc-700 bg-surface-2 px-4 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-surface-3 hover:border-zinc-600 active:scale-[0.98]"
            >
              <GoogleIcon />
              Continue with Google
            </button>
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-zinc-700 bg-surface-2 px-4 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-surface-3 hover:border-zinc-600 active:scale-[0.98]"
            >
              <Github className="h-4 w-4" />
              Continue with GitHub
            </button>
          </div>

          {/* Divider */}
          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-800" />
            <span className="text-xs text-zinc-600">or</span>
            <div className="h-px flex-1 bg-zinc-800" />
          </div>

          {/* Tab switcher */}
          <div className="mb-5 flex rounded-lg border border-zinc-700 bg-surface-2 p-1">
            <button
              type="button"
              onClick={() => switchTab("signin")}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                tab === "signin"
                  ? "bg-surface-3 text-zinc-100 shadow-sm"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => switchTab("signup")}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                tab === "signup"
                  ? "bg-surface-3 text-zinc-100 shadow-sm"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Sign Up
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            {tab === "signup" && (
              <div>
                <label
                  htmlFor="name"
                  className="mb-1.5 block text-sm font-medium text-zinc-300"
                >
                  Name
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                  className="focus-ring w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
                />
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
                className="focus-ring w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
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
                placeholder={tab === "signup" ? "At least 6 characters" : "Enter your password"}
                autoComplete={tab === "signup" ? "new-password" : "current-password"}
                className="focus-ring w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
              />
            </div>

            {tab === "signup" && (
              <div>
                <label
                  htmlFor="confirmPassword"
                  className="mb-1.5 block text-sm font-medium text-zinc-300"
                >
                  Confirm Password
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm your password"
                  autoComplete="new-password"
                  className="focus-ring w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-lantern-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {tab === "signup" ? "Creating account..." : "Signing in..."}
                </>
              ) : (
                tab === "signup" ? "Create account" : "Sign in"
              )}
            </button>
          </form>

          {/* Dev credentials hint */}
          {tab === "signin" && (
            <p className="mt-3 text-center text-xs text-zinc-600">
              Dev credentials: admin@lantern.dev / lantern
            </p>
          )}
        </div>

        {/* Demo button below card */}
        <div className="mt-5">
          <button
            onClick={handleDemo}
            disabled={demoLoading}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-surface-1 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]"
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
          <p className="mt-3 text-center text-xs text-zinc-600">
            Demo mode uses local mock data -- no backend required.
          </p>
        </div>

        {/* Footer */}
        <p className="mt-8 text-center text-[11px] text-zinc-600">
          By signing in you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  );
}
