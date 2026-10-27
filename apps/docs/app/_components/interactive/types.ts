// Shared shapes for the interactive diagrams. Every claim a diagram makes
// carries a `Src` so readers can jump to the code that backs it.

/** `ref` "broker" = the opt-in egress broker (ADR 0026); labelling only. */
export type Src = { p: string; l?: number; ref?: "broker" };

const REPO = "https://github.com/dshakes/lantern/blob/master";

export function srcHref(s: Src): string {
  return `${REPO}/${s.p}${s.l ? `#L${s.l}` : ""}`;
}

export function srcLabel(s: Src): string {
  return `${s.p.split("/").slice(-2).join("/")}${s.l ? `:${s.l}` : ""}`;
}

export type Tone = "host" | "guest" | "deny" | "store" | "client" | "plain";
