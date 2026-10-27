import fs from "fs";
import path from "path";

// Diagram inlines one of the repo's architecture SVGs (docs/assets/diagrams, the
// single source shared with the README) at build time
// (server component, static export). Inlining avoids basePath/asset-loading
// issues entirely and lets CSS scale the SVG responsively (.diagram svg).
//
// basePath rewriting: SVGs contain <a href="/..."> hotspots that need the
// PAGES_BASE_PATH prefix on GitHub Pages (e.g. /lantern/runtime/...).
// We do a plain string replace — only absolute hrefs starting with "/" are
// touched; external hrefs ("https://...") are unchanged.
export function Diagram({ name, caption }: { name: string; caption?: string }) {
  const basePath = process.env.PAGES_BASE_PATH ?? "";
  // A missing diagram fails the static build instead of rendering an empty figure.
  let svg = fs.readFileSync(path.join(process.cwd(), "..", "..", "docs", "assets", "diagrams", `${name}.svg`), "utf8");
  if (basePath) {
    svg = svg.replace(/href="\//g, `href="${basePath}/`);
  }
  return (
    <figure className="diagram">
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
