// Dev aid: render public/diagrams/*.svg to PNG for review. node scripts/svg2png.mjs <outDir>
import { chromium } from 'playwright';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 900, height: 500 } });
for (const f of readdirSync('public/diagrams').filter((f) => f.endsWith('.svg'))) {
  await p.setContent(`<body style="margin:0;background:${f.includes('dark') ? '#0b0c0f' : '#fafaf8'}">${readFileSync('public/diagrams/' + f, 'utf8')}</body>`);
  await p.locator('svg').screenshot({ path: `${out}/${f.replace('.svg', '.png')}` });
}
await b.close();
