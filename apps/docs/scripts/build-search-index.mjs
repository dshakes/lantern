// Postbuild: builds out/search-index.json from the rendered pages (title, headings,
// body text, anchors) and fails if a page lacks metadata. Zero dependencies.
// ponytail: regex over Next's own static HTML; swap for a real parser if page markup gets exotic.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "out");
const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");
const text = (h) => dec(h.replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

const meta = fs.readFileSync(path.join(root, "app/_meta.ts"), "utf8");
const routes = new Set([...meta.matchAll(/^  "([^"]+)": \{ title: "([^"]*)"/gm)].map((m) => m[1]));
const titles = Object.fromEntries([...meta.matchAll(/^  "([^"]+)": \{ title: "([^"]*)"/gm)].map((m) => [m[1], m[2]]));

const entries = [];
const seen = new Set();
const errors = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { if (f.name !== "_next" && f.name !== "404") walk(p); continue; }
    if (f.name !== "index.html") continue;
    const html = fs.readFileSync(p, "utf8");
    const art = html.match(/<article[^>]*>([\s\S]*?)<\/article>/);
    if (!art) continue;
    const rel = path.relative(out, path.dirname(p));
    const route = rel === "" ? "/" : "/" + rel;
    seen.add(route);
    const h1 = text((art[1].match(/<h1[^>]*>([\s\S]*?)<\/h1>/) ?? [])[1] ?? "");
    if (!routes.has(route)) errors.push(`${route}: no entry in app/_meta.ts`);
    else if (titles[route] !== h1) errors.push(`${route}: _meta title "${titles[route]}" != <h1> "${h1}"`);
    if (!/<meta name="description"/.test(html) || !/property="og:image"/.test(html)) errors.push(`${route}: missing description/og tags`);
    // One entry per h2/h3 section; text before the first heading belongs to the page itself.
    const parts = art[1].split(/(?=<h[23][ >])/);
    for (const part of parts) {
      const hm = part.match(/^<h([23])([^>]*)>([\s\S]*?)<\/h\1>/);
      const id = hm && (hm[2].match(/\bid="([^"]+)"/) ?? [])[1];
      if (hm && !id) continue; // heading without anchor: can't deep-link, fold into nothing
      entries.push({
        u: route === "/" ? "/" : route + "/",
        a: id ?? "",
        p: h1,
        h: hm ? text(hm[3]) : "",
        b: text(hm ? part.slice(hm[0].length) : part.replace(/<h1[\s\S]*?<\/h1>/, "")).slice(0, 1500),
      });
    }
  }
})(out);
for (const r of routes) if (!seen.has(r)) errors.push(`${r}: in _meta.ts but not built`);
if (errors.length) { console.error("search-index/meta check failed:\n" + errors.join("\n")); process.exit(1); }
fs.writeFileSync(path.join(out, "search-index.json"), JSON.stringify(entries));
console.log(`search-index: ${entries.length} sections from ${seen.size} pages (${(fs.statSync(path.join(out, "search-index.json")).size / 1024).toFixed(0)} KiB)`);
