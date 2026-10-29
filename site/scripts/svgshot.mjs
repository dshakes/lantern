// Renders each diagram SVG to a PNG (for eyeballing): node scripts/svgshot.mjs <outdir>
import { chromium } from 'playwright';
import { readdirSync, readFileSync } from 'node:fs';
const dir = new URL('../public/diagrams/', import.meta.url);
const out = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ deviceScaleFactor: 1 });
for (const f of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
  const svg = readFileSync(new URL(f, dir), 'utf8');
  await p.setContent(`<body style="margin:0;background:#777">${svg}</body>`);
  await p.locator('svg').screenshot({ path: `${out}/diag-${f.replace('.svg', '.png')}` });
}
await b.close();
