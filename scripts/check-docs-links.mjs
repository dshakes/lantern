#!/usr/bin/env node
// Docs link checker — fails CI when a Markdown link points at a file that does
// not exist or an anchor (#heading) that has no matching heading/id in the
// target. Catches the exact classes that have embarrassed us: ADR cross-ref
// link-rot and dead in-page anchors.
//
// Pure Node, no deps. Scope: all tracked *.md (via `git ls-files`), excluding
// generated / vendored trees. Only INTERNAL links are checked — http(s)/mailto
// and protocol-relative URLs are skipped (we don't make network calls in CI).
//
// Usage:  node scripts/check-docs-links.mjs   (exit 1 on any broken link)

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const EXCLUDE = /(^|\/)(node_modules|\.git|gen|dist|build|\.next|out)\//;

const files = execSync("git ls-files '*.md' '*.markdown'", { cwd: ROOT })
  .toString()
  .split("\n")
  .filter((f) => f && !EXCLUDE.test(f));

// GitHub-style heading slug.
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")   // drop punctuation (keep word chars, space, hyphen)
    .replace(/\s+/g, "-");
}

// Collect every anchor a Markdown file exposes: heading slugs + explicit
// <a id="..."> / id="..." / name="...".
function anchorsOf(absPath) {
  const out = new Set();
  if (!existsSync(absPath)) return out;
  const src = readFileSync(absPath, "utf8");
  for (const m of src.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) out.add(slug(m[1].replace(/[*_`]/g, "")));
  for (const m of src.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/g)) out.add(m[1].toLowerCase());
  return out;
}

const anchorCache = new Map();
const getAnchors = (p) => {
  if (!anchorCache.has(p)) anchorCache.set(p, anchorsOf(p));
  return anchorCache.get(p);
};

const broken = [];

for (const rel of files) {
  const abs = join(ROOT, rel);
  const src = readFileSync(abs, "utf8");
  const lines = src.split("\n");
  // Markdown inline links [text](target) — ignore images? images can also rot,
  // but keep to links + the <img src>/<a href> HTML forms.
  const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<a\s[^>]*href=["']([^"'#?]*[^"']*)["']|<img\s[^>]*src=["']([^"']+)["']/gi;
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(linkRe)) {
      let target = m[1] || m[2] || m[3];
      if (!target) continue;
      target = target.trim();
      // Skip external + non-file schemes.
      if (/^(https?:|mailto:|tel:|data:|\/\/)/i.test(target)) continue;
      if (target.startsWith("{") || target.includes("${")) continue; // template noise

      const [pathPart, anchor] = target.split("#");
      // Pure same-file anchor.
      if (pathPart === "") {
        if (anchor && !getAnchors(abs).has(anchor.toLowerCase())) {
          broken.push(`${rel}:${i + 1}  →  #${anchor}  (no matching heading/id in this file)`);
        }
        continue;
      }
      // Resolve relative path (absolute-from-repo if it starts with /).
      const targetAbs = pathPart.startsWith("/")
        ? join(ROOT, pathPart)
        : resolve(dirname(abs), pathPart);
      if (!existsSync(targetAbs)) {
        broken.push(`${rel}:${i + 1}  →  ${pathPart}  (file does not exist)`);
        continue;
      }
      // If it points at a directory, fine (README resolution is lenient).
      if (anchor && statSync(targetAbs).isFile() && /\.(md|markdown)$/i.test(targetAbs)) {
        if (!getAnchors(targetAbs).has(anchor.toLowerCase())) {
          broken.push(`${rel}:${i + 1}  →  ${pathPart}#${anchor}  (target file has no such anchor)`);
        }
      }
    }
  }
}

if (broken.length) {
  console.error(`\n✗ ${broken.length} broken doc link(s):\n`);
  for (const b of broken) console.error("  " + b);
  console.error("\nFix the path/anchor, or drop the dead reference.\n");
  process.exit(1);
}
console.log(`✓ docs links OK — checked ${files.length} Markdown files, no broken internal links.`);
