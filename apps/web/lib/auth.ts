"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { api, DEMO_USER, type User } from "@/lib/api";
import React from "react";

// ---------------------------------------------------------------------------
// Auth state type
// ---------------------------------------------------------------------------

export interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isDemoMode: boolean;
  signup: (email: string, password: string, name: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  loginDemo: () => void;
  logout: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthState | null>(null);

// Demo mode is OFF unless explicitly enabled at build time. When off, the
// client-minted `demo_token_*` path cannot authenticate at all: loginDemo()
// is a no-op and any restored demo token is dropped. Even when ON, the
// middleware validates every protected-route request against the
// control-plane's /auth/me — a demo token 401s there — so demo mode never
// grants access to real tenant data; it only drives local explore-the-UI
// state on public pages.
const DEMO_MODE_ENABLED = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

function isDemoToken(token: string): boolean {
  return token.startsWith("demo_token_");
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDemoMode, setIsDemoMode] = useState(false);

  // On mount: restore token from localStorage
  useEffect(() => {
    const stored = api.restoreToken();
    if (stored) {
      // A client-minted demo token can only be honored when demo mode is
      // explicitly enabled. Otherwise drop it — it is not a real credential.
      if (isDemoToken(stored)) {
        if (DEMO_MODE_ENABLED) {
          setToken(stored);
          setUser(DEMO_USER);
          setIsDemoMode(true);
        } else {
          api.setToken(null);
        }
        setIsLoading(false);
      } else {
        setToken(stored);
        // Validate the real token by calling /auth/me
        api.getMe().then((u) => {
          setUser(u);
          setIsLoading(false);
        }).catch(() => {
          // Token expired or invalid -- clear it
          api.setToken(null);
          setToken(null);
          setIsLoading(false);
        });
      }
    } else {
      setIsLoading(false);
    }
  }, []);

  const signup = useCallback(async (email: string, password: string, name: string) => {
    const result = await api.signup(email, password, name);
    setToken(result.token);
    setUser(result.user);
    setIsDemoMode(false);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    setToken(result.token);
    setUser(result.user);
    // A real login must never be classified as demo. (The api.login demo
    // fallback is itself demo-gated.) Treat a demo-shaped token as demo
    // only when demo mode is enabled; otherwise it isn't a usable session.
    setIsDemoMode(DEMO_MODE_ENABLED && isDemoToken(result.token));
  }, []);

  const loginDemo = useCallback(() => {
    // Hard-gated: without NEXT_PUBLIC_DEMO_MODE=1 this cannot mint a token,
    // so the client-side auth bypass is off in any normal/production build.
    if (!DEMO_MODE_ENABLED) {
      console.warn("[lantern] Demo mode is disabled (set NEXT_PUBLIC_DEMO_MODE=1 to enable).");
      return;
    }
    const demoToken = "demo_token_" + Date.now();
    api.setToken(demoToken);
    setToken(demoToken);
    setUser(DEMO_USER);
    setIsDemoMode(true);
  }, []);

  const logout = useCallback(() => {
    api.logout();
    setToken(null);
    setUser(null);
    setIsDemoMode(false);
  }, []);

  const value: AuthState = {
    user,
    token,
    isLoading,
    isAuthenticated: !!token,
    isDemoMode,
    signup,
    login,
    loginDemo,
    logout,
  };

  return React.createElement(AuthContext.Provider, { value }, children);
}
