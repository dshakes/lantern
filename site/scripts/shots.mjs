// Mobile gate: screenshots every page at 360/390/768/1280 in dark + light and
// fails loudly if any page scrolls horizontally (scrollWidth !== clientWidth)
// or any diagram's labels render below 12px.
// Needs a running server: `npm run build && npx astro preview --port 4329`
// Usage: node scripts/shots.mjs <outdir> [base=http://localhost:4329/pal/] [--only=name,name]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'shots';
const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4329/pal/';
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const fullPageMax = Number(process.env.SHOT_FULL ?? 1) !== 0;
mkdirSync(out, { recursive: true });

const PAGES = [
  ['landing', ''],
  ['pal', 'pal/'],
  ['runtime', 'runtime/'],
  ['compare', 'compare/'],
  ['about', 'about/'],
  ['docs-home', 'docs/'],
  ['docs-quickstart', 'docs/start/quickstart/'],
  ['docs-durable', 'docs/runtime/durable-execution/'],
  ['docs-budgets', 'docs/build/budgets/'],
  ['docs-egress', 'docs/runtime/egress/'],
].filter(([n]) => !only || only.includes(n));
const WIDTHS = [360, 390, 768, 1280];
const THEMES = ['dark', 'light'];

const browser = await chromium.launch();
const failures = [];
for (const theme of THEMES) {
  const ctx = await browser.newContext({ colorScheme: theme, reducedMotion: "reduce" });
  await ctx.addInitScript((t) => { try { localStorage.setItem('starlight-theme', t); } catch {} }, theme);
  const page = await ctx.newPage();
  for (const [name, path] of PAGES) {
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      const res = await page.goto(base + path, { waitUntil: 'networkidle' });
      if (!res || res.status() >= 400) { failures.push(`${name} ${w} ${theme}: HTTP ${res?.status()}`); continue; }
      // load lazy diagrams so the label-size check sees every one
      await page.evaluate(async () => {
        const imgs = [...document.querySelectorAll('.diagram img')].filter((i) => i.offsetWidth > 0);
        for (const i of imgs) i.loading = 'eager';
        await Promise.all(imgs.map((i) => i.decode().catch(() => {})));
      });
      const m = await page.evaluate(() => {
        const s = document.scrollingElement;
        const wide = [...document.querySelectorAll('body *')]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > s.clientWidth + 1; })
          .slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
        // diagram labels are >= 16px in the SVG; rendered size = 16 * shown/natural width
        const small = [...document.querySelectorAll('.diagram img')]
          .filter((i) => i.offsetWidth > 0 && i.naturalWidth > 0)
          .map((i) => ({ src: i.currentSrc.split('/').pop(), px: (16 * i.getBoundingClientRect().width) / i.naturalWidth }))
          .filter((d) => d.px < 12);
        const all = [...document.querySelectorAll('.diagram img')].filter((i) => i.offsetWidth > 0 && i.naturalWidth > 0).map((i) => (16 * i.getBoundingClientRect().width) / i.naturalWidth);
        const diag = all.length ? Math.min(...all).toFixed(1) : '';
        return { sw: s.scrollWidth, cw: s.clientWidth, wide, small, diag, theme: document.documentElement.dataset.theme };
      });
      const ok = m.sw === m.cw;
      if (!ok) failures.push(`${name} ${w} ${theme}: scrollWidth ${m.sw} != clientWidth ${m.cw} (${m.wide.join(', ')})`);
      for (const d of m.small) failures.push(`${name} ${w} ${theme}: diagram ${d.src} labels render at ${d.px.toFixed(1)}px (< 12)`);
      if (m.theme !== theme) failures.push(`${name} ${w} ${theme}: page rendered theme ${m.theme}`);
      await page.screenshot({ path: `${out}/${name}-${w}-${theme}.png`, fullPage: fullPageMax });
      console.log(`${ok && !m.small.length ? 'ok  ' : 'FAIL'} ${name.padEnd(16)} ${String(w).padStart(4)} ${theme.padEnd(5)} sw=${m.sw} cw=${m.cw}${m.diag ? ` minLabel=${m.diag}px` : ''}`);
    }
  }
  await ctx.close();
}
await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`\nall ${PAGES.length * WIDTHS.length * THEMES.length} page/width/theme combinations pass (no horizontal scroll)`);
