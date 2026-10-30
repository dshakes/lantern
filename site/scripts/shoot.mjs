// Dev aid: screenshot pages at desktop + phone widths in both themes and
// report console errors and horizontal overflow. Not part of the build.
//   node scripts/shoot.mjs <outDir> <url>... [--widths=1440,390] [--themes=dark,light] [--full]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `=${d}`).split('=')[1];
const full = args.includes('--full');
const [out, ...urls] = args.filter((a) => !a.startsWith('--'));
mkdirSync(out, { recursive: true });
const widths = opt('widths', '1440,390').split(',').map(Number);
const themes = opt('themes', 'dark,light').split(',');
const browser = await chromium.launch();
let bad = 0;
for (const theme of themes) for (const w of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => { try { localStorage.setItem('starlight-theme', t); } catch {} }, theme);
  for (const url of urls) {
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(url, { waitUntil: 'networkidle' });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const name = url.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '').replace(/[^a-z0-9]+/gi, '_') || 'root';
    await page.screenshot({ path: `${out}/${name}-${w}-${theme}.png`, fullPage: full });
    const flag = errs.length || over > 0;
    if (flag) bad++;
    console.log(`${flag ? 'FAIL' : 'ok  '} ${w} ${theme} ${url} overflow=${over} errors=${errs.length}${errs.length ? ' ' + errs.join(' | ').slice(0, 300) : ''}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(`${bad} problem(s)`);
process.exit(bad ? 1 : 0);
