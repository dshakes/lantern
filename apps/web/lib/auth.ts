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
      setToken(stored);
      // Check if it's a demo token
      if (stored.startsWith("demo_token_")) {
        setUser(DEMO_USER);
        setIsDemoMode(true);
        setIsLoading(false);
      } else {
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
    setIsDemoMode(result.token.startsWith("demo_token_"));
  }, []);

  const loginDemo = useCallback(() => {
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
