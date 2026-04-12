"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";

type Tab = "signin" | "signup";

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
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-lantern-400 to-lantern-600 shadow-lg shadow-lantern-500/20">
            <span className="text-xl font-bold text-white leading-none">
              L
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            {tab === "signin" ? "Sign in to Lantern" : "Create your account"}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {tab === "signin"
              ? "Manage your AI agents and monitor runs"
              : "Get started with Lantern in seconds"}
          </p>
        </div>

        {/* Tab switcher */}
        <div className="mb-6 flex rounded-lg border border-zinc-700 bg-surface-2 p-1">
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
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
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
              placeholder={tab === "signup" ? "At least 6 characters" : "Enter your password"}
              autoComplete={tab === "signup" ? "new-password" : "current-password"}
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
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
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-lantern-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:cursor-not-allowed disabled:opacity-50"
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
          Demo mode uses local mock data -- no backend required.
        </p>
      </div>
    </div>
  );
}
