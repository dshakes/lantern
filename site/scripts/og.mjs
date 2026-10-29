// Renders public/og.png (1200x630) from the SVG/HTML below with the site's own fonts.
// Run: node scripts/og.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const font = (p) => readFileSync(new URL(`../node_modules/@fontsource-variable/${p}`, import.meta.url)).toString('base64');
const tight = font('inter-tight/files/inter-tight-latin-wght-normal.woff2');
const mono = font('jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2');
const html = `<!doctype html><html><head><style>
@font-face { font-family: T; src: url(data:font/woff2;base64,${tight}) format('woff2'); font-weight: 100 900; }
@font-face { font-family: M; src: url(data:font/woff2;base64,${mono}) format('woff2'); font-weight: 100 900; }
html, body { margin: 0; }
body { width: 1200px; height: 630px; background: #0b0c0f; color: #fafaf8; font-family: T; display: flex; flex-direction: column; justify-content: space-between; padding: 84px 96px; box-sizing: border-box; }
h1 { margin: 0; font-size: 92px; line-height: 1; letter-spacing: -0.04em; font-weight: 700; max-width: 900px; }
p { margin: 28px 0 0; font-size: 30px; color: #b9bac0; letter-spacing: -0.01em; }
.foot { font-family: M; font-size: 22px; color: #8c8e96; display: flex; justify-content: space-between; }
.foot b { color: #ffb547; font-weight: 500; }
</style></head><body>
<svg viewBox="-4 -4 113 72" width="170" height="108"><g stroke="#fafaf8" fill="none" stroke-width="8" stroke-linecap="round"><path d="M6 19 V62 M82 19 V49 M101 4 V49"/><circle cx="21" cy="34" r="15"/><circle cx="67" cy="34" r="15"/></g><circle cx="67" cy="34" r="6" fill="#ff5b2e"/></svg>
<div><h1>Your pal for every moment.</h1><p>A personal agent that asks first, and PAL Runtime, the layer it runs on.</p></div>
<div class="foot"><span>the <b>Personal Agentic Layer</b></span><span>Apache-2.0</span></div>
</body></html>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.setContent(html, { waitUntil: 'load' });
await p.evaluate(() => document.fonts.ready);
await p.screenshot({ path: new URL('../public/og.png', import.meta.url).pathname });
await b.close();
