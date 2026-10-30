// Screenshot a local HTML/SVG file with the system Chrome.
// Usage: node shot.mjs <file> <out.png> [width] [height] [--transparent] [--full]
// Needs playwright-core resolvable (NODE_PATH=<scratch>/node_modules); not a repo dependency.
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const [file, out, w = '1200', h = '800', ...flags] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: flags.includes('--2x') ? 2 : 1 });
await page.goto('file://' + resolve(file));
await page.waitForTimeout(300);
await page.screenshot({ path: out, omitBackground: flags.includes('--transparent'), fullPage: flags.includes('--full') });
await browser.close();
