import fs from "fs";
import path from "path";

// Diagram inlines one of the repo's hand-built architecture SVGs at build time
// (server component, static export). Inlining avoids basePath/asset-loading
// issues entirely and lets CSS scale the SVG responsively (.diagram svg).
export function Diagram({ name, caption }: { name: string; caption?: string }) {
  let svg = "";
  try {
    svg = fs.readFileSync(path.join(process.cwd(), "diagrams", `${name}.svg`), "utf8");
  } catch {
    return null;
  }
  return (
    <figure className="diagram">
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
