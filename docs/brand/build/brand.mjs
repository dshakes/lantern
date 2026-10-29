// Generates every static logo file in site/public/brand/ (+ site/public/favicon.svg).
// Geometry lives here once; Logo.astro mirrors WORD/MARK below.
//
//   cd <scratch> && npm i opentype.js@1.3.4 playwright-core
//   curl -sSfLO https://cdn.jsdelivr.net/fontsource/fonts/inter-tight@latest/latin-{500,600}-normal.woff
//   NODE_PATH=<scratch>/node_modules node docs/brand/build/brand.mjs <scratch>
//
// Secondary words ("Runtime", "Personal Agentic Layer") are Inter Tight outlined
// to paths so the files render identically everywhere (README, Figma, email).
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const scratch = resolve(process.argv[2] || '.');
const require = createRequire(join(scratch, 'x.js'));
const opentype = require('opentype.js');
const font = (w) => opentype.loadSync(join(scratch, `latin-${w}-normal.woff`));
const OUT = resolve(new URL('../../../site/public/brand/', import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });

export const INK = '#0b0c0f', PAPER = '#fafaf8';
const PAL = ['#ff7a3d', '#e5207f'], RT = ['#6c5cff', '#14c8f0'];

// Monoline geometry: stroke 9, bowl radius 15, round caps.
// MARK: the p alone, centred in a 64 grid. WORD: "pal", x-height 13..43.
export const MARK = { stem: 'M17.5 13 V54', bowl: [32.5, 28, 15], dot: [32.5, 28, 6.5] };
export const WORD = {
  d: 'M4.5 13 V64 M81 13 V43 M100 -6 V34 A9 9 0 0 0 109 43',
  rings: [[19.5, 28], [66, 28]], dot: [19.5, 28, 6.5], box: [0, -11, 114, 80],
};
// Runtime: the bowl squares into a container.
const RT_BOWL = { x: 17.5, y: 13, s: 30, rx: 9 };

const grad = (id, [a, b]) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
const svg = (vb, body, label, w) => {
  const [, , vw, vh] = vb.split(' ').map(Number);
  const width = w ?? vw * 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${width}" height="${Math.round(width * vh / vw)}" role="img" aria-label="${label}">${body}</svg>\n`;
};
const fill = (dotFill, ramp, id) => (dotFill === 'grad' ? { defs: `<defs>${grad(id, ramp)}</defs>`, f: `url(#${id})` } : { defs: '', f: dotFill });

function markBody(stroke, dotFill, ramp = PAL, runtime = false) {
  const { defs, f } = fill(dotFill, ramp, runtime ? 'prt' : 'pg');
  const [cx, cy, r] = MARK.bowl;
  const bowl = runtime
    ? `<rect x="${RT_BOWL.x}" y="${RT_BOWL.y}" width="${RT_BOWL.s}" height="${RT_BOWL.s}" rx="${RT_BOWL.rx}"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
  return `${defs}<g fill="none" stroke="${stroke}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"><path d="${MARK.stem}"/>${bowl}</g><circle cx="${MARK.dot[0]}" cy="${MARK.dot[1]}" r="${MARK.dot[2]}" fill="${f}"/>`;
}
function wordBody(stroke, dotFill, ramp = PAL, id = 'wg') {
  const { defs, f } = fill(dotFill, ramp, id);
  return `${defs}<g fill="none" stroke="${stroke}" stroke-width="9" stroke-linecap="round"><path d="${WORD.d}"/>${WORD.rings.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="15"/>`).join('')}</g><circle cx="${WORD.dot[0]}" cy="${WORD.dot[1]}" r="${WORD.dot[2]}" fill="${f}"/>`;
}
// Outline text with its baseline at y, left at x; returns [pathData, advanceWidth].
function words(text, weight, size, x, y, tracking = -0.02) {
  const f = font(weight);
  let d = '', cx = x;
  for (const g of f.stringToGlyphs(text)) {
    d += g.getPath(cx, y, size).toPathData(2);
    cx += (g.advanceWidth / f.unitsPerEm) * size + tracking * size;
  }
  return [d, cx - x - tracking * size];
}

const files = {};
const variants = [['', INK, 'grad'], ['-on-dark', PAPER, 'grad'], ['-mono-black', INK, INK], ['-mono-white', PAPER, PAPER]];
const WVB = WORD.box.join(' ');

for (const [sfx, stroke, dot] of variants) {
  files[`mark${sfx}.svg`] = svg('8 5.5 49 56', markBody(stroke, dot), 'pal');
  files[`lockup${sfx}.svg`] = svg(WVB, wordBody(stroke, dot), 'pal', 342);
  files[`runtime-mark${sfx}.svg`] = svg('8 5.5 49 56', markBody(stroke, dot, RT, true), 'PAL Runtime');

  // Horizontal descriptor lockup: pal | Personal Agentic Layer (descriptor x-height aligned to the bowls).
  const sub = stroke === INK ? '#45474e' : '#b9bac0';
  const subFill = dot === 'grad' ? sub : stroke;
  const [pd, pw] = words('Personal Agentic Layer', 500, 26, 140, 43);
  files[`lockup-horizontal${sfx}.svg`] = svg(`0 -11 ${Math.ceil(140 + pw + 2)} 80`,
    `${wordBody(stroke, dot, PAL, 'hg')}<path d="M124 6 V50" stroke="${stroke}" stroke-opacity=".18" stroke-width="2"/><path d="${pd}" fill="${subFill}"/>`, 'pal, Personal Agentic Layer', 600);

  // Stacked: wordmark over descriptor, centred.
  const [sd, sw] = words('Personal Agentic Layer', 500, 14, 0, 0);
  const sx = (114 - sw) / 2;
  const [sd2] = words('Personal Agentic Layer', 500, 14, sx, 96);
  files[`lockup-stacked${sfx}.svg`] = svg(`${Math.min(0, Math.floor(sx)) - 2} -11 ${Math.ceil(Math.max(114, sw)) + 4} 114`,
    `${wordBody(stroke, dot, PAL, 'sg')}<path d="${sd2}" fill="${subFill}"/>`, 'pal, Personal Agentic Layer', 300);
  void sd;

  // Runtime lockup: pal (electric dot) + Runtime.
  const [rd, rw] = words('Runtime', 500, 40, 134, 43, -0.025);
  files[`runtime-lockup${sfx}.svg`] = svg(`0 -11 ${Math.ceil(134 + rw + 2)} 80`,
    `${wordBody(stroke, dot, RT, 'rg')}<path d="${rd}" fill="${stroke}"/>`, 'PAL Runtime', 520);
}

// App icons: ink squircle, paper p, gradient dot, a low glow of the ramp from the bowl.
const appIcon = (ramp, runtime, id) => svg('0 0 512 512',
  `<defs><radialGradient id="${id}h" cx=".5" cy=".46" r=".62"><stop offset="0" stop-color="${ramp[1]}" stop-opacity=".34"/><stop offset=".55" stop-color="${ramp[0]}" stop-opacity=".08"/><stop offset="1" stop-color="${ramp[0]}" stop-opacity="0"/></radialGradient></defs>` +
  `<rect width="512" height="512" rx="114" fill="${INK}"/><rect width="512" height="512" rx="114" fill="url(#${id}h)"/>` +
  `<rect x="1.5" y="1.5" width="509" height="509" rx="112.5" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="3"/>` +
  `<g transform="translate(256 256) scale(5.6) translate(-32.5 -33.5)">${markBody(PAPER, 'grad', ramp, runtime).replace(/id="(prt|pg)"/, `id="${id}"`).replace(/url\(#(prt|pg)\)/, `url(#${id})`)}</g>`,
  runtime ? 'PAL Runtime' : 'pal', 512);
files['app-icon.svg'] = appIcon(PAL, false, 'ai');
files['runtime-app-icon.svg'] = appIcon(RT, true, 'ri');

// Favicon: follows the browser theme.
const fav = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 5.5 49 56" role="img" aria-label="pal"><style>g{stroke:${INK}}@media (prefers-color-scheme:dark){g{stroke:${PAPER}}}</style>${markBody(INK, 'grad').replace(/ stroke="#0b0c0f"/, '')}</svg>\n`;
files['favicon.svg'] = fav;

for (const [n, s] of Object.entries(files)) writeFileSync(join(OUT, n), s);
writeFileSync(join(OUT, '..', 'favicon.svg'), fav);
console.log(`wrote ${Object.keys(files).length} files to ${OUT}`);

// Animated wordmark (site hero, README): strokes draw in, the dot lands in the
// bowl and settles, then a slow "held" ripple. Reduced motion: the final frame.
function animated(stroke, ramp, id, label) {
  const draw = (len, delay, dur) => `--l:${len};stroke-dasharray:${len};animation:d ${dur}s cubic-bezier(.65,0,.35,1) ${delay}s both`;
  const css = `@keyframes d{0%{stroke-dashoffset:var(--l);opacity:0}1%{opacity:1}100%{stroke-dashoffset:0}}` +
    `@keyframes drop{0%{transform:scale(0);opacity:0}10%{opacity:1}55%{transform:scale(1.28)}78%{transform:scale(.92)}100%{transform:none;opacity:1}}` +
    `@keyframes rip{0%{r:6.5px;opacity:.55}70%,100%{r:13px;opacity:0}}` +
    `.s1{${draw(52, 0, .5)}}.s2{${draw(95, .12, .6)}}.s3{${draw(95, .3, .6)}}.s4{${draw(31, .55, .35)}}.s5{${draw(55, .68, .55)}}` +
    `.dot{transform-box:fill-box;transform-origin:50% 50%;opacity:0;animation:drop .7s cubic-bezier(.3,0,.2,1) 1.05s forwards}` +
    `.rip{opacity:0;animation:rip 3.6s ease-out 2.2s infinite}` +
    `@media (prefers-reduced-motion:reduce){*{animation:none!important}.dot{opacity:1}.rip{display:none}}`;
  return svg(WVB, `<title>${label}</title><style>${css}</style><defs>${grad(id, ramp)}</defs>` +
    `<g fill="none" stroke="${stroke}" stroke-width="9" stroke-linecap="round">` +
    `<path class="s1" d="M4.5 13 V64"/><path class="s2" d="M19.5 13 a15 15 0 1 1 0 30 a15 15 0 1 1 0 -30"/>` +
    `<path class="s3" d="M66 13 a15 15 0 1 0 0 30 a15 15 0 1 0 0 -30"/><path class="s4" d="M81 13 V43"/><path class="s5" d="M100 -6 V34 A9 9 0 0 0 109 43"/></g>` +
    `<circle class="rip" cx="19.5" cy="28" r="6.5" fill="none" stroke="url(#${id})" stroke-width="1.5"/>` +
    `<circle class="dot" cx="19.5" cy="28" r="6.5" fill="url(#${id})"/>`, label, 342);
}
writeFileSync(join(OUT, 'logo-animated.svg'), animated(INK, PAL, 'la', 'pal'));
writeFileSync(join(OUT, 'logo-animated-on-dark.svg'), animated(PAPER, PAL, 'la', 'pal'));
writeFileSync(join(OUT, 'runtime-logo-animated-on-dark.svg'), animated(PAPER, RT, 'lr', 'PAL Runtime'));
