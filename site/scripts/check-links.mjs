// Fails if any internal href/src in the built marketing pages points at a file
// that is not in dist/ (the docs are checked by starlight-links-validator).
// Run after `npm run build`: node scripts/check-links.mjs
import { readFileSync, existsSync } from 'node:fs';
const dist = new URL('../dist/', import.meta.url).pathname;
const pages = ['index.html', 'pal/index.html', 'runtime/index.html', 'compare/index.html', 'about/index.html'];
const bad = [];
for (const p of pages) {
  const html = readFileSync(dist + p, 'utf8');
  for (const [, url] of html.matchAll(/(?:href|src|srcset)="(\/pal\/[^"#?]*)/g)) {
    const f = dist + url.replace(/^\/pal\//, '');
    if (!(existsSync(f) && !f.endsWith('/')) && !existsSync(f + 'index.html') && !existsSync(f + '/index.html')) bad.push(`${p}: ${url}`);
  }
}
if (bad.length) { console.error(`broken internal links:\n  ${bad.join('\n  ')}`); process.exit(1); }
console.log(`internal links ok on ${pages.length} pages`);
