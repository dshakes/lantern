// Settings navigation — ONE array the Settings layout renders.
//
// To add a page: create app/(dashboard)/settings/<slug>/page.tsx and append
// `{ href: "/settings/<slug>", label, icon }` here. Entries that are tabs of
// the main settings page use `?tab=<id>`. Keep labels short; order = display.

export type SettingsIcon = "settings" | "key" | "cpu" | "users" | "card" | "smartphone" | "shield";

export interface SettingsNavItem {
  href: string;
  label: string;
  icon: SettingsIcon;
  description?: string;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  { href: "/settings?tab=general", label: "General", icon: "settings" },
  { href: "/settings?tab=providers", label: "Model providers", icon: "cpu" },
  { href: "/settings?tab=api-keys", label: "API keys", icon: "key" },
  { href: "/settings?tab=team", label: "Team", icon: "users" },
  { href: "/settings?tab=billing", label: "Billing", icon: "card" },
];

/** Whether a nav entry is the current one (path + optional ?tab=). */
export function isSettingsActive(item: SettingsNavItem, pathname: string, tab: string | null): boolean {
  const [path, query] = item.href.split("?");
  if (pathname !== path) return false;
  const itemTab = new URLSearchParams(query ?? "").get("tab");
  if (!itemTab) return true;
  return (tab ?? "general") === itemTab;
}
