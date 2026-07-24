import type { ReactNode } from "react";

/**
 * Plain-language concept explainer. Every docs section leads with one of
 * these so a reader who isn't deep in infra can follow before the
 * technical detail starts.
 */
export function Concept({
  title = "In plain terms",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="callout callout-concept">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
