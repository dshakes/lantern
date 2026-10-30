"use client";

// /login — sign in / sign up.
//
// Only offers what the deployment really supports: GET /auth/providers says
// which OAuth providers are configured and whether sign-up is open, invite-
// only or closed. Unknown (older control-plane) → no OAuth buttons rather
// than buttons that can only fail.
//
// Session handling follows the auth-loop fix: the HttpOnly cookie write is
// AWAITED before navigating to a gated route, and when the server bounced us
// here (?from= / ?next=) while we still hold a valid token, the cookie is
// repaired non-destructively (api.syncCookie) instead of forcing a re-login.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Loader2, MailCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { api, type AuthProviders } from "@/lib/api";
import { Turnstile, TURNSTILE_SITE_KEY } from "@/components/turnstile";
import { AuthError, AuthFrame, authInputClass } from "@/app/auth/auth-shell";
import { describeAuthError, safeNextPath, type AuthErrorView } from "./auth-errors";

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

const OAUTH_META: Record<string, { label: string; Icon: () => React.ReactElement }> = {
  google: { label: "Continue with Google", Icon: GoogleIcon },
  github: { label: "Continue with GitHub", Icon: GitHubIcon },
};

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, signup, loginDemo, isAuthenticated, isLoading } = useAuth();

  const nextPath = safeNextPath(searchParams.get("next") || searchParams.get("from"));
  // A from/next param means the SERVER rejected our session. If the client
  // still reads as authenticated it's the localStorage/cookie desync — repair.
  const bounced = searchParams.get("from") !== null || searchParams.get("next") !== null;
  const inviteParam = searchParams.get("invite") ?? "";
  const oauthError = searchParams.get("error");

  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">(inviteParam ? "signup" : "signin");
  const [inviteCode, setInviteCode] = useState(inviteParam);
  const [captchaToken, setCaptchaToken] = useState("");
  const onCaptcha = useCallback((t: string) => setCaptchaToken(t), []);
  const [checkEmail, setCheckEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [name, setName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<AuthErrorView | null>(
    oauthError ? { kind: "other", message: "That sign-in didn't complete. Try again or use email." } : null,
  );
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    void api.getAuthProviders().then(setProviders);
  }, []);

  const signupMode = providers?.signup ?? "open";
  const signupAllowed = signupMode !== "closed" || Boolean(inviteParam);
  const oauthProviders = Object.entries(providers?.oauth ?? {})
    .filter(([id, on]) => on && OAUTH_META[id])
    .map(([id]) => id)
    .sort();

  // Redirect / desync repair once AuthProvider has validated the token.
  const redirecting = useRef(false);
  const destination = useRef<string | null>(null);
  useEffect(() => {
    if (isLoading || !isAuthenticated || redirecting.current) return;
    redirecting.current = true;
    let cancelled = false;
    void (async () => {
      if (bounced) await api.syncCookie();
      await api.whenCookieSynced();
      if (!cancelled) router.replace(destination.current ?? nextPath);
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoading, isAuthenticated, bounced, nextPath, router]);

  if (!isLoading && isAuthenticated) return null;

  const switchMode = (m: "signin" | "signup") => {
    setMode(m);
    setError(null);
    setResent(false);
  };

  const handleOAuthLogin = async (provider: string) => {
    setError(null);
    setOauthLoading(provider);
    try {
      const data = await api.oauthStart(provider);
      if (data.redirect_url) window.location.href = data.redirect_url;
      else throw new Error("no redirect");
    } catch (err) {
      setError(describeAuthError(err, "signin"));
      setOauthLoading(null);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setResent(false);
    const fail = (message: string) => setError({ kind: "other", message });
    if (!email.trim() || !password) return fail("Enter your email and password.");
    if (mode === "signup") {
      if (!name.trim()) return fail("Enter your name.");
      if (password.length < 12) return fail("Use a password of at least 12 characters.");
      if (password !== confirmPassword) return fail("The passwords don't match.");
      if (signupMode === "invite" && !inviteCode.trim()) return fail("This workspace is invite-only. Enter your invite code.");
      if (TURNSTILE_SITE_KEY && !captchaToken) return fail("Complete the check above the button.");
    }
    setLoading(true);
    try {
      if (mode === "signup") {
        // A brand-new account picks its path on /welcome.
        destination.current = "/welcome";
        const { verificationRequired } = await signup(email.trim(), password, name.trim(), {
          inviteCode: inviteCode.trim() || undefined,
          captchaToken: captchaToken || undefined,
        });
        if (verificationRequired) {
          setCheckEmail(true);
          return;
        }
        await api.whenCookieSynced();
        router.replace("/welcome");
      } else {
        await login(email.trim(), password);
        await api.whenCookieSynced();
        router.replace(nextPath);
      }
    } catch (err) {
      destination.current = null;
      setError(describeAuthError(err, mode));
    } finally {
      setLoading(false);
    }
  };

  const resendVerification = async () => {
    try {
      await api.resendVerification(email.trim());
    } finally {
      setResent(true); // same answer either way — never reveals whether the account exists
    }
  };

  if (checkEmail) {
    return (
      <AuthFrame>
        <div className="rounded-xl border border-zinc-800/80 bg-surface-1 p-6">
          <MailCheck className="h-6 w-6 text-pal-400" />
          <h1 className="mt-3 text-lg font-semibold text-zinc-50">Check your email</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
            We sent a verification link to <span className="text-zinc-200">{email}</span>. Open it to finish setting up, then sign in.
          </p>
          <button
            onClick={() => { setCheckEmail(false); switchMode("signin"); }}
            className="mt-5 text-sm font-medium text-pal-400 hover:text-pal-300"
          >
            Back to sign in
          </button>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
          {mode === "signin" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          {mode === "signin" ? "Sign in to your PAL workspace." : "Your personal layer and agent runtime, in one place."}
        </p>
      </div>

      {error && (
        <div role="alert">
          <AuthError message={error.message} />
          {error.kind === "unverified" && email && (
            <p className="-mt-2 mb-3.5 text-xs text-zinc-400">
              {resent ? (
                "If that account needs verifying, a new link is on its way."
              ) : (
                <button onClick={resendVerification} className="font-medium text-pal-400 hover:text-pal-300">
                  Send a new verification link
                </button>
              )}
            </p>
          )}
        </div>
      )}

      {oauthProviders.length > 0 && (
        <>
          <div className="space-y-2.5">
            {oauthProviders.map((id) => {
              const { label, Icon } = OAUTH_META[id];
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleOAuthLogin(id)}
                  disabled={oauthLoading !== null || loading}
                  className="flex h-10 w-full items-center justify-center gap-2.5 rounded-lg border border-zinc-700 bg-surface-1 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-surface-2 disabled:opacity-50"
                >
                  {oauthLoading === id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon />}
                  {label}
                </button>
              );
            })}
          </div>
          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-800" />
            <span className="text-[11px] uppercase tracking-wider text-zinc-600">or with email</span>
            <div className="h-px flex-1 bg-zinc-800" />
          </div>
        </>
      )}

      <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
        {mode === "signup" && (
          <Field id="name" label="Name">
            <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" className={authInputClass} />
          </Field>
        )}

        <Field id="email" label="Email">
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            inputMode="email"
            autoFocus
            className={authInputClass}
          />
        </Field>

        <Field
          id="password"
          label="Password"
          aside={
            mode === "signin" && (providers?.passwordReset ?? true) ? (
              <Link href="/auth/forgot" className="text-[12px] text-zinc-500 hover:text-zinc-200">
                Forgot password?
              </Link>
            ) : null
          }
        >
          <div className="relative">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyUp={(e) => setCapsLock(e.getModifierState?.("CapsLock") ?? false)}
              placeholder={mode === "signup" ? "At least 12 characters" : "Your password"}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              className={`${authInputClass} pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 hover:text-zinc-200"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {capsLock && <p className="mt-1 text-[12px] text-amber-400">Caps Lock is on.</p>}
          {mode === "signup" && password.length > 0 && password.length < 12 && (
            <p className="mt-1 text-[12px] text-zinc-500">{12 - password.length} more character{12 - password.length === 1 ? "" : "s"}.</p>
          )}
        </Field>

        {mode === "signup" && (
          <Field id="confirm" label="Confirm password">
            <input
              id="confirm"
              type={showPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              className={authInputClass}
            />
          </Field>
        )}

        {mode === "signup" && (signupMode === "invite" || inviteParam) && (
          <Field id="invite" label="Invite code">
            <input id="invite" type="text" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} autoComplete="off" className={`${authInputClass} font-mono text-xs`} />
          </Field>
        )}

        {mode === "signup" && <Turnstile onToken={onCaptcha} />}

        <button
          type="submit"
          disabled={loading || oauthLoading !== null}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-pal-500 text-sm font-medium text-on-flame transition-colors hover:bg-pal-400 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-label={mode === "signup" ? "Creating account" : "Signing in"} />
          ) : (
            <>
              {mode === "signup" ? "Create account" : "Sign in"}
              <ArrowRight className="h-3.5 w-3.5" />
            </>
          )}
        </button>
      </form>

      <p className="mt-5 text-center text-xs text-zinc-500">
        {mode === "signin" ? (
          signupAllowed ? (
            <>
              No account?{" "}
              <button onClick={() => switchMode("signup")} className="font-medium text-pal-400 hover:text-pal-300">
                Sign up
              </button>
            </>
          ) : (
            "New accounts are by invitation."
          )
        ) : (
          <>
            Already have an account?{" "}
            <button onClick={() => switchMode("signin")} className="font-medium text-pal-400 hover:text-pal-300">
              Sign in
            </button>
          </>
        )}
      </p>

      {process.env.NEXT_PUBLIC_DEMO_MODE === "1" && (
        <button
          onClick={() => {
            loginDemo();
            router.replace(nextPath);
          }}
          className="mt-4 flex h-10 w-full items-center justify-center rounded-lg border border-zinc-800 text-sm text-zinc-400 hover:bg-surface-1 hover:text-zinc-200"
        >
          Explore the demo
        </button>
      )}
    </AuthFrame>
  );
}

function Field({ id, label, aside, children }: { id: string; label: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label htmlFor={id} className="text-xs font-medium text-zinc-400">
          {label}
        </label>
        {aside}
      </div>
      {children}
    </div>
  );
}
