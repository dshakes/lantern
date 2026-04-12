"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "@/lib/auth";
import { ToastProvider } from "@/components/toast";
import { ModelProvider } from "@/lib/model-context";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>
        <ModelProvider>{children}</ModelProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
