// Dev aid: viewport-height screenshots down a page, for eyeballing.
// node scripts/peek.mjs <url> <width> <theme> <outprefix> [maxShots=4]
import { chromium } from 'playwright';
const [url, w, theme, pre, n = 4] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ colorScheme: theme, reducedMotion: 'reduce', viewport: { width: +w, height: 1100 } });
await ctx.addInitScript((t) => localStorage.setItem('starlight-theme', t), theme);
const p = await ctx.newPage();
await p.goto(url, { waitUntil: 'networkidle' });
const h = await p.evaluate(() => document.scrollingElement.scrollHeight);
for (let i = 0, y = 0; i < +n && y < h; i++, y += 1100) {
  await p.screenshot({ path: `${pre}-${i}.png`, clip: { x: 0, y, width: +w, height: Math.min(1100, h - y) }, fullPage: true });
}
await b.close();
