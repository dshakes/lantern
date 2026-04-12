"use client";

import { ToastProvider } from "@/components/settings/toast";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ToastProvider>{children}</ToastProvider>;
}
