// Workspace modes + navigation — the dashboard's information architecture.
//
// The dashboard serves two audiences, so it has two home spaces:
//   - "pal"     — the consumer's personal layer: today's Brief, held replies,
//                 automations, people + memory, voice, channels, privacy.
//   - "runtime" — PAL Runtime for builders: agents, runs, sandboxes, deploys,
//                 evals, budgets, experiments, connectors.
// Settings is shared and belongs to neither.
//
// Pure data + pure functions (no React) so the mapping is unit-tested and the
// sidebar, mobile nav, command bar and keyboard shortcuts all read ONE source.

export type WorkspaceMode = "pal" | "runtime";

export const MODE_STORAGE_KEY = "pal-mode";

export const MODE_LABEL: Record<WorkspaceMode, string> = {
  pal: "pal",
  runtime: "Runtime",
};

export const MODE_HOME: Record<WorkspaceMode, string> = {
  pal: "/brief",
  runtime: "/overview",
};

/** Lucide icon names are resolved by the renderer; data stays React-free. */
export type NavIcon =
  | "sun" | "inbox-check" | "zap" | "message" | "users" | "mic" | "file" | "shield" | "smartphone"
  | "gauge" | "bot" | "play" | "server" | "rocket" | "flask" | "chart" | "dollar" | "split"
  | "plug" | "radio" | "store" | "activity";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Extra path prefixes that should light this item up. */
  match?: string[];
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

export const NAV: Record<WorkspaceMode, NavSection[]> = {
  pal: [
    {
      items: [
        { href: "/brief", label: "Today", icon: "sun" },
        { href: "/personal/drafts", label: "Holds", icon: "inbox-check" },
        { href: "/automations", label: "Automations", icon: "zap" },
      ],
    },
    {
      title: "You",
      items: [
        { href: "/personal/contacts", label: "People & memory", icon: "users", match: ["/personal/vip", "/personal/groups"] },
        { href: "/personal/activity", label: "Activity", icon: "activity" },
        { href: "/personal/docs", label: "Documents", icon: "file" },
        { href: "/voice", label: "Voice", icon: "mic" },
      ],
    },
    {
      title: "Setup",
      items: [
        { href: "/personal/setup", label: "Channels", icon: "smartphone", match: ["/personal/auto-reply"] },
        { href: "/personal", label: "Assistant", icon: "shield" },
      ],
    },
  ],
  runtime: [
    {
      items: [
        { href: "/overview", label: "Overview", icon: "gauge" },
        { href: "/agents", label: "Agents", icon: "bot" },
        { href: "/runs", label: "Runs", icon: "play", match: ["/inbox"] },
        { href: "/runtime", label: "Sandboxes", icon: "server" },
      ],
    },
    {
      title: "Ship",
      items: [
        { href: "/deployments", label: "Deployments", icon: "rocket" },
        { href: "/eval-suites", label: "Evals", icon: "flask" },
        { href: "/experiments", label: "Experiments", icon: "split" },
        { href: "/evaluations", label: "Analytics", icon: "chart" },
        { href: "/budgets", label: "Budgets", icon: "dollar" },
      ],
    },
    {
      title: "Connect",
      items: [
        { href: "/connectors", label: "Connectors", icon: "plug" },
        { href: "/surfaces", label: "Channels", icon: "radio", match: ["/embed"] },
        { href: "/marketplace", label: "Marketplace", icon: "store" },
      ],
    },
  ],
};

/** The three thumb-reach destinations on the phone bottom bar, per mode. */
export const MOBILE_PRIMARY: Record<WorkspaceMode, NavItem[]> = {
  pal: [NAV.pal[0].items[0], NAV.pal[0].items[1], NAV.pal[0].items[2]],
  runtime: [NAV.runtime[0].items[0], NAV.runtime[0].items[1], NAV.runtime[0].items[2]],
};

const PAL_PREFIXES = ["/brief", "/personal", "/automations", "/voice", "/pal"];
const RUNTIME_PREFIXES = [
  "/overview", "/agents", "/runs", "/inbox", "/runtime", "/deployments", "/eval-suites",
  "/evaluations", "/experiments", "/budgets", "/connectors", "/surfaces", "/embed", "/marketplace",
];

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** The mode a route belongs to, or null for shared routes (/, /settings). */
export function modeForPath(pathname: string): WorkspaceMode | null {
  if (PAL_PREFIXES.some((p) => underPrefix(pathname, p))) return "pal";
  if (RUNTIME_PREFIXES.some((p) => underPrefix(pathname, p))) return "runtime";
  return null;
}

/** Resolve the mode to render: the route's own mode, else the remembered one. */
export function resolveMode(pathname: string, stored: string | null): WorkspaceMode {
  return modeForPath(pathname) ?? (stored === "runtime" ? "runtime" : "pal");
}

/**
 * Whether a nav item is the active one. Longest-match wins so "/personal"
 * (Assistant) does not light up on "/personal/drafts" (Holds).
 */
export function isNavActive(item: NavItem, pathname: string, all: NavItem[]): boolean {
  const prefixes = [item.href, ...(item.match ?? [])];
  const mine = Math.max(...prefixes.map((p) => (underPrefix(pathname, p) ? p.length : -1)));
  if (mine < 0) return false;
  for (const other of all) {
    if (other === item) continue;
    for (const p of [other.href, ...(other.match ?? [])]) {
      if (underPrefix(pathname, p) && p.length > mine) return false;
    }
  }
  return true;
}

export function allNavItems(mode: WorkspaceMode): NavItem[] {
  return NAV[mode].flatMap((s) => s.items);
}

// ---------------------------------------------------------------------------
// First landing after sign-in
// ---------------------------------------------------------------------------

export interface LandingFacts {
  /** Remembered mode from a previous visit, if any. */
  storedMode: string | null;
  /** Whether /v1/onboarding has any saved state (a started Runtime onboarding). */
  onboardingStarted: boolean;
  agentCount: number;
}

/**
 * Where "/" sends a signed-in user. A brand-new workspace (no remembered mode,
 * no agents, onboarding never started) goes to /welcome to pick a path; an
 * unfinished Runtime onboarding resumes; everyone else lands on their home.
 */
export function chooseLanding(f: LandingFacts): string {
  if (f.storedMode === "pal" || f.storedMode === "runtime") return MODE_HOME[f.storedMode];
  if (f.agentCount > 0) return MODE_HOME.runtime;
  if (f.onboardingStarted) return "/onboarding";
  return "/welcome";
}
