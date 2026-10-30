// Shared shapes for the interactive diagrams. Every claim a diagram makes
// carries a `Src` so readers can jump to the code that backs it.

/** `ref` "broker" = the opt-in egress broker (ADR 0026); labelling only. */
export type Src = { p: string; l?: number; ref?: "broker" };

import { GH } from "../../../repo.config.mjs";

const REPO = `${GH}/blob/master`;

export function srcHref(s: Src): string {
  // No #L anchors: they point at moving lines on master and drift. Link the file.
  return `${REPO}/${s.p}`;
}

export function srcLabel(s: Src): string {
  return s.p.split("/").slice(-2).join("/");
}

export type Tone = "host" | "guest" | "deny" | "store" | "client" | "plain";

// Old docs routes used in the diagram data -> the docs' current homes.
const MOVED: Record<string, string> = {
  "/cli": "reference/cli", "/deployment": "operate/deployment", "/models": "build/models", "/sdk": "reference/sdk",
  "/stack": "runtime/stack", "/security": "runtime/security", "/budgets": "build/budgets", "/api": "reference/api",
  "/scheduling": "build/scheduling", "/surfaces": "pal/surfaces", "/marketplace": "build/marketplace", "/evaluations": "build/evaluations",
};
export function docsHref(old: string): string {
  const [path, frag] = old.split("#");
  const to = MOVED[path] ?? path.replace(/^\//, "");
  return `${import.meta.env.BASE_URL.replace(/\/$/, "")}/docs/${to}/${frag ? `#${frag}` : ""}`;
}
