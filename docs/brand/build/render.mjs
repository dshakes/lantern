// Render brand SVGs to PNG / GIF with the system Chrome (deterministic: every
// CSS animation is paused and seeked per frame, so GIFs match the SVG exactly).
//
//   NODE_PATH=<scratch>/node_modules node docs/brand/build/render.mjs png <in.svg> <out.png> <w> <h> [--bg=#hex]
//   NODE_PATH=<scratch>/node_modules node docs/brand/build/render.mjs gif <in.svg> <out.gif> <w> <h> <seconds> [fps] [--scale=0.5]
//
// Needs playwright-core (resolved from NODE_PATH, not a repo dependency) and ffmpeg.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(join(process.env.NODE_PATH || '.', 'x.js'));
const { chromium } = require('playwright-core');
const [mode, input, out, w, h, ...rest] = process.argv.slice(2);
const flag = (k) => rest.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const W = +w, H = +h;

const browser = await chromium.launch({ channel: 'chrome' });
// PNG = the poster frame (reduced motion shows the finished state by design).
const page = await browser.newPage({ viewport: { width: W, height: H }, reducedMotion: mode === 'png' ? 'reduce' : 'no-preference' });
await page.goto('file://' + resolve(input));
await page.evaluate(([W, H, bg]) => {
  const s = document.documentElement;
  s.setAttribute('width', W); s.setAttribute('height', H);
  if (bg) s.style.background = bg;
}, [W, H, flag('bg')]);

if (mode === 'png') {
  await page.waitForTimeout(100);
  await page.screenshot({ path: out, omitBackground: !flag('bg') });
} else {
  const secs = +rest[0], fps = +(rest[1] && !rest[1].startsWith('--') ? rest[1] : 15);
  const dir = mkdtempSync(join(tmpdir(), 'palgif-'));
  const n = Math.round(secs * fps);
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = t; }), (i * 1000) / fps);
    await page.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.png`) });
  }
  const scale = flag('scale') || '1';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, 'f%04d.png'),
    '-vf', `scale=iw*${scale}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
    '-loop', '0', out]);
  rmSync(dir, { recursive: true, force: true });
}
await browser.close();
