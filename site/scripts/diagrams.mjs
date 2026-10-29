// Generates the four PAL Runtime diagrams into public/diagrams/:
//   <name>-{dark,light}.svg (960 wide) and <name>-portrait-{dark,light}.svg (420 wide).
// Each diagram is laid out by hand below; this file only shares the drawing
// primitives and the two palettes, so both themes are always the same picture.
// Run: node scripts/diagrams.mjs   (outputs are committed; re-run after edits)
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('../public/diagrams/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const THEMES = {
  dark: {
    bg: '#111216', line: '#2e3038', text: '#fafaf8', text2: '#b9bac0', muted: '#8c8e96',
    accent: '#f5a524', accentText: '#ffb547', ember: '#ff5b2e',
    cool: '#7c8cff', ok: '#3fb68b', okText: '#5fd3a6', bad: '#ef4444', badText: '#ff8a8a',
    tint: 0.12,
  },
  light: {
    bg: '#ffffff', line: '#d9d8d2', text: '#0b0c0f', text2: '#45474e', muted: '#62656d',
    accent: '#e08a00', accentText: '#9a4a06', ember: '#e2461b',
    cool: '#4f5fd6', ok: '#1f8a63', okText: '#146b4b', bad: '#d03030', badText: '#b42323',
    tint: 0.09,
  },
};

const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "'Inter Tight', Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const CH = 9.7; // approx advance of a 16px mono glyph
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function make(t, w, h, title, desc) {
  // Smallest render: portrait at 328px wide (0.78x), landscape at 768px (0.8x).
  // A 16px floor keeps every label >= 12px rendered.
  const MIN = 16;
  const parts = [];
  let labels = 0;
  const tone = (k) => t[k] ?? k;
  const api = {
    // a labelled box; tone = border/tint colour key; dashed for "replayed / not run"
    box(x, y, bw, bh, { tone: k = 'line', fill = true, dashed = false, r = 12, title: tt, sub, sub2, align = 'center', strong = false } = {}) {
      const c = tone(k);
      const f = fill && k !== 'line' ? `fill="${c}" fill-opacity="${t.tint}"` : `fill="${t.bg}"`;
      parts.push(`<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${r}" ${f} stroke="${c}" stroke-width="${strong ? 2 : 1.5}"${dashed ? ' stroke-dasharray="6 5"' : ''}/>`);
      const lines = [tt && [tt, 17, t.text, 600], sub && [sub, 16, t.text2, 400], sub2 && [sub2, 16, t.text2, 400]].filter(Boolean);
      const total = lines.reduce((a, l) => a + l[1] + 6, -6);
      let cy = y + bh / 2 - total / 2;
      if (lines.length) labels++; // a box's title + subtitle are one label
      for (const [s, size, col, wt] of lines) {
        cy += size;
        const tx = align === 'center' ? x + bw / 2 : x + 16;
        api.text(tx, cy - 3, s, { size, color: col, weight: wt, anchor: align === 'center' ? 'middle' : 'start', maxW: bw - 16, count: false });
      }
    },
    text(x, y, s, { size = 16, color = t.text, weight = 400, anchor = 'start', mono = true, maxW, count = true } = {}) {
      if (count) labels++;
      size = Math.max(size, MIN);
      const est = s.length * CH * (size / 16) * (mono ? 1 : 0.88);
      if (maxW && est > maxW + 2) console.warn(`  ! "${s}" ~${Math.round(est)}px > ${maxW}px in ${title}`);
      parts.push(`<text x="${x}" y="${y}" font-family="${mono ? MONO : SANS}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(s)}</text>`);
    },
    // polyline arrow; head at the last point
    arrow(pts, { tone: k = 'muted', dashed = false, head = true, w: sw = 1.75 } = {}) {
      const c = tone(k);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
      parts.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dashed ? ' stroke-dasharray="5 5"' : ''}/>`);
      if (head) {
        const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const L = 9, s = 0.45;
        const p1 = [b[0] - L * Math.cos(ang - s), b[1] - L * Math.sin(ang - s)];
        const p2 = [b[0] - L * Math.cos(ang + s), b[1] - L * Math.sin(ang + s)];
        parts.push(`<path d="M${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L${b[0]} ${b[1]} L${p2[0].toFixed(1)} ${p2[1].toFixed(1)}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`);
      }
    },
    mark(x, y, kind, r = 11) {
      // ok tick / bad cross / crash bolt in a small disc
      const c = kind === 'ok' ? t.ok : t.bad;
      parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`);
      if (kind === 'ok') parts.push(`<path d="M${x - 5} ${y} l3.5 3.5 l6.5 -7" fill="none" stroke="${t.bg}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`);
      else if (kind === 'bad') parts.push(`<path d="M${x - 4.5} ${y - 4.5} l9 9 M${x + 4.5} ${y - 4.5} l-9 9" stroke="${t.bg}" stroke-width="2.4" stroke-linecap="round"/>`);
      else parts.push(`<path d="M${x + 1.5} ${y - 7} L${x - 4} ${y + 1} L${x} ${y + 1} L${x - 1.5} ${y + 7} L${x + 4} ${y - 1} L${x} ${y - 1} Z" fill="${t.bg}"/>`);
    },
    key(x, y, k = 'cool') {
      const c = tone(k);
      parts.push(`<g fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><circle cx="${x}" cy="${y}" r="5"/><path d="M${x + 5} ${y} h11 M${x + 12} ${y} v4 M${x + 16} ${y} v4"/></g>`);
    },
    raw(s) { parts.push(s); },
    get labels() { return labels; },
  };
  return {
    api,
    svg: () =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">` +
      `<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>` +
      `<rect width="${w}" height="${h}" rx="18" fill="${t.bg}"/>` +
      parts.join('') +
      `</svg>\n`,
  };
}

// ---------------------------------------------------------------------------
// A. crash-resume
const A = {
  title: 'A run resumes after a crash',
  desc: 'Each finished step is written to the run journal. The process crashes during step 3. The recovery sweep finds the orphaned run and re-acquires its lock. Steps 1 and 2 are replayed from the journal, not re-run. Step 3 runs again with the same idempotency key, so the provider bills it once.',
  land(d, t) {
    d.text(32, 44, 'before the crash', { size: 14, color: t.muted });
    const xs = [32, 256, 480, 704], bw = 192, y1 = 60, bh = 64, mid = (i) => xs[i] + bw / 2;
    d.box(xs[0], y1, bw, bh, { tone: 'ok', title: 'step 1', sub: 'journaled' });
    d.box(xs[1], y1, bw, bh, { tone: 'ok', title: 'step 2', sub: 'journaled' });
    d.box(xs[2], y1, bw, bh, { tone: 'bad', title: 'step 3', sub: 'crash mid-call' });
    d.mark(xs[2] + bw, y1, 'crash', 13);
    d.arrow([[xs[0] + bw, y1 + 32], [xs[1], y1 + 32]]);
    d.arrow([[xs[1] + bw, y1 + 32], [xs[2], y1 + 32]]);
    d.box(xs[1], 160, 424, 56, { tone: 'cool', title: 'recovery sweep re-acquires the lock' });
    d.arrow([[mid(2), y1 + bh], [mid(2), 160]], { tone: 'cool' });
    d.arrow([[mid(2), 216], [mid(2), 286]], { tone: 'cool' });
    d.text(32, 270, 'after recovery', { size: 14, color: t.muted });
    const y2 = 286;
    d.box(xs[0], y2, bw, bh, { tone: 'ok', dashed: true, fill: false, title: 'step 1', sub: 'from journal' });
    d.box(xs[1], y2, bw, bh, { tone: 'ok', dashed: true, fill: false, title: 'step 2', sub: 'from journal' });
    d.box(xs[2], y2, bw, bh, { tone: 'accent', strong: true, title: 'step 3 again', sub: 'same key' });
    d.box(xs[3], y2, bw, bh, { tone: 'ok', title: 'step 4', sub: 'continues' });
    d.arrow([[xs[0] + bw, y2 + 32], [xs[1], y2 + 32]]);
    d.arrow([[xs[1] + bw, y2 + 32], [xs[2], y2 + 32]]);
    d.arrow([[xs[2] + bw, y2 + 32], [xs[3], y2 + 32]]);
    d.box(712, 148, 216, 80, { tone: 'line', fill: false, title: 'billed once', sub: 'provider dedups', sub2: 'the idempotency key' });
    d.arrow([[mid(2) + 40, y2], [mid(2) + 40, 252], [820, 252], [820, 228]], { tone: 'accent', dashed: true });
  },
  landH: 384,
  port(d, t) {
    const x = 24, bw = 372, bh = 56;
    d.text(x, 36, 'before the crash', { size: 14, color: t.muted });
    d.box(x, 48, bw, bh, { tone: 'ok', title: 'step 1 · journaled' });
    d.box(x, 120, bw, bh, { tone: 'ok', title: 'step 2 · journaled' });
    d.box(x, 192, bw, bh, { tone: 'bad', title: 'step 3 · crash mid-call' });
    d.mark(x + bw, 192, 'crash', 13);
    d.arrow([[210, 104], [210, 120]]); d.arrow([[210, 176], [210, 192]]);
    d.arrow([[210, 248], [210, 272]], { tone: 'cool' });
    d.box(x, 272, bw, 64, { tone: 'cool', title: 'recovery sweep', sub: 're-acquires the run lock' });
    d.arrow([[210, 336], [210, 372]], { tone: 'cool' });
    d.text(x, 392, 'after recovery', { size: 14, color: t.muted });
    d.box(x, 404, 178, bh, { tone: 'ok', dashed: true, fill: false, title: 'step 1', sub: 'from journal' });
    d.box(x + 194, 404, 178, bh, { tone: 'ok', dashed: true, fill: false, title: 'step 2', sub: 'from journal' });
    d.box(x, 476, bw, 64, { tone: 'accent', strong: true, title: 'step 3 runs again', sub: 'same idempotency key' });
    d.box(x, 556, bw, bh, { tone: 'ok', title: 'step 4 continues' });
    d.arrow([[210, 540], [210, 556]]);
    d.box(x, 628, bw, 64, { tone: 'line', fill: false, title: 'billed once', sub: 'provider dedups the key' });
    d.arrow([[210, 612], [210, 628]], { tone: 'accent', dashed: true });
  },
  portH: 716,
};

// B. sandbox-egress (broker mode)
const B = {
  title: 'Sandbox egress through the host broker',
  desc: 'An agent tool call runs code in a microVM that has no network card. Its only way out is vsock to a broker on the host. The broker checks every request against the allowlist and adds the credential there, so keys never enter the VM. An allowed host goes through; any other host is refused and audited.',
  land(d, t) {
    d.box(24, 150, 152, 72, { tone: 'line', title: 'tool call', sub: 'from the agent' });
    d.arrow([[176, 186], [216, 186]], { tone: 'accent' });
    d.box(216, 56, 248, 264, { tone: 'accent', r: 16 });
    d.text(340, 92, 'microVM', { size: 17, weight: 600, anchor: 'middle', mono: false });
    d.text(340, 114, 'no network card', { size: 14, color: t.text2, anchor: 'middle' , count: false });
    d.box(248, 150, 184, 72, { tone: 'line', title: 'your code', sub: 'no keys inside' });
    d.arrow([[432, 186], [520, 186]], { tone: 'cool' });
    d.text(476, 176, 'vsock', { size: 14, color: t.text2, anchor: 'middle' });
    d.box(520, 56, 232, 264, { tone: 'cool', r: 16 });
    d.text(636, 92, 'host broker', { size: 17, weight: 600, anchor: 'middle', mono: false });
    d.box(544, 120, 184, 52, { tone: 'line', title: '1 allowlist' });
    d.box(544, 188, 184, 52, { tone: 'line', title: '2 add key' });
    d.key(588, 280); d.text(614, 285, 'keys stay here', { size: 14, color: t.text2 });
    d.arrow([[752, 146], [800, 146], [800, 112], [820, 112]], { tone: 'ok' });
    d.arrow([[752, 214], [800, 214], [800, 252], [820, 252]], { tone: 'bad' });
    d.mark(840, 112, 'ok'); d.text(858, 117, 'allowed', { size: 15, color: t.okText });
    d.text(828, 142, 'api.github.com', { size: 13, color: t.text2 , count: false });
    d.mark(840, 252, 'bad'); d.text(858, 257, 'refused', { size: 15, color: t.badText });
    d.text(828, 282, 'audited', { size: 13, color: t.text2 , count: false });
  },
  landH: 376,
  port(d, t) {
    const x = 24, w = 372;
    d.box(x, 24, w, 56, { tone: 'line', title: 'tool call from the agent' });
    d.arrow([[210, 80], [210, 108]], { tone: 'accent' });
    d.box(x, 108, w, 168, { tone: 'accent', r: 16 });
    d.text(210, 140, 'microVM', { size: 17, weight: 600, anchor: 'middle', mono: false });
    d.text(210, 162, 'no network card', { size: 14, color: t.text2, anchor: 'middle' , count: false });
    d.box(x + 40, 184, w - 80, 64, { tone: 'line', title: 'your code', sub: 'no keys inside' });
    d.arrow([[210, 276], [210, 320]], { tone: 'cool' });
    d.text(222, 304, 'vsock', { size: 14, color: t.text2 });
    d.box(x, 320, w, 228, { tone: 'cool', r: 16 });
    d.text(210, 352, 'host broker', { size: 17, weight: 600, anchor: 'middle', mono: false });
    d.box(x + 24, 372, w - 48, 48, { tone: 'line', title: '1 allowlist' });
    d.box(x + 24, 432, w - 48, 48, { tone: 'line', title: '2 add key' });
    d.key(x + 110, 516); d.text(x + 136, 521, 'keys stay here', { size: 14, color: t.text2 });
    d.arrow([[120, 548], [120, 596]], { tone: 'ok' });
    d.arrow([[300, 548], [300, 596]], { tone: 'bad' });
    d.mark(120, 616, 'ok'); d.text(120, 652, 'allowed', { size: 15, color: t.okText, anchor: 'middle' });
    d.text(120, 674, 'api.github.com', { size: 13, color: t.text2, anchor: 'middle' , count: false });
    d.mark(300, 616, 'bad'); d.text(300, 652, 'refused', { size: 15, color: t.badText, anchor: 'middle' });
    d.text(300, 674, 'audited', { size: 13, color: t.text2, anchor: 'middle' , count: false });
  },
  portH: 700,
};

// C. your-cloud (control plane / data plane)
const C = {
  title: 'PAL Runtime in your cloud',
  desc: 'The control plane runs wherever you deploy it. The data plane runs inside your VPC with the microVM sandboxes and the run data. It dials out to the control plane and holds one connection open; run assignments come back down it. There are no inbound ports.',
  land(d, t) {
    d.box(24, 72, 300, 232, { tone: 'line', r: 16 });
    d.text(174, 108, 'control plane', { size: 18, weight: 600, anchor: 'middle', mono: false });
    d.text(174, 132, 'run it anywhere', { size: 14, color: t.text2, anchor: 'middle' , count: false });
    d.box(48, 156, 252, 52, { tone: 'line', title: 'API · console' });
    d.box(48, 224, 252, 52, { tone: 'line', title: 'scheduling · routing' });
    d.box(504, 32, 432, 312, { tone: 'cool', r: 18, dashed: true, fill: false });
    d.text(528, 62, 'your VPC', { size: 15, color: t.text2 });
    d.box(536, 84, 368, 92, { tone: 'accent', title: 'data plane', sub: 'runs inside your account' });
    d.box(536, 196, 176, 116, { tone: 'line', title: 'microVM', sub: 'sandboxes' });
    d.box(728, 196, 176, 116, { tone: 'line', title: 'run data', sub: 'stays here' });
    d.arrow([[536, 116], [324, 116]], { tone: 'accent', w: 2 });
    d.text(430, 104, 'dials out', { size: 14, color: t.accentText, anchor: 'middle' });
    d.arrow([[324, 148], [536, 148]], { tone: 'muted', dashed: true });
    d.text(430, 170, 'runs come back', { size: 14, color: t.text2, anchor: 'middle' });
    d.arrow([[380, 262], [492, 262]], { tone: 'bad', dashed: true, head: false }); d.mark(504, 262, 'bad', 11); d.text(430, 290, 'no inbound ports', { size: 14, color: t.badText, anchor: 'middle' });
  },
  landH: 376,
  port(d, t) {
    const x = 24, w = 372;
    d.box(x, 24, w, 200, { tone: 'line', r: 16 });
    d.text(210, 58, 'control plane', { size: 18, weight: 600, anchor: 'middle', mono: false });
    d.text(210, 80, 'run it anywhere', { size: 14, color: t.text2, anchor: 'middle' , count: false });
    d.box(x + 20, 100, w - 40, 44, { tone: 'line', title: 'API · console' });
    d.box(x + 20, 156, w - 40, 44, { tone: 'line', title: 'scheduling · routing' });
    d.arrow([[150, 304], [150, 224]], { tone: 'accent', w: 2 });
    d.text(140, 262, 'dials out', { size: 14, color: t.accentText, anchor: 'end' });
    d.arrow([[270, 224], [270, 304]], { tone: 'muted', dashed: true });
    d.text(282, 262, 'runs back', { size: 14, color: t.text2 });
    d.box(x, 304, w, 296, { tone: 'cool', r: 18, dashed: true, fill: false });
    d.text(x + 20, 334, 'your VPC', { size: 15, color: t.text2 });
    d.box(x + 20, 352, w - 40, 76, { tone: 'accent', title: 'data plane', sub: 'inside your account' });
    d.box(x + 20, 444, 158, 92, { tone: 'line', title: 'microVM', sub: 'sandboxes' });
    d.box(x + 194, 444, 158, 92, { tone: 'line', title: 'run data', sub: 'stays here' });
    d.mark(x + w - 24, 304, 'bad', 11); d.text(x + w - 44, 334, 'no inbound ports', { size: 14, color: t.badText, anchor: 'end' });
  },
  portH: 624,
};

// D. budget-gate
const D = {
  title: 'A budget is checked before the model is called',
  desc: 'A run request first meets the budget check: a forecast and the daily caps. Over a hard cap, the API returns 402 and no model is called, so it costs nothing. Under the cap, the request is routed by capability to a provider model and the usage is recorded against the budget.',
  land(d, t) {
    d.box(24, 152, 168, 72, { tone: 'line', title: 'run request', sub: 'POST /v1/runs' });
    d.arrow([[192, 188], [240, 188]]);
    d.box(240, 136, 208, 104, { tone: 'accent', strong: true, title: 'budget check', sub: 'forecast +', sub2: 'daily caps' });
    d.arrow([[448, 168], [488, 168], [488, 84], [520, 84]], { tone: 'bad' });
    d.box(520, 44, 208, 80, { tone: 'bad', title: '402 refused', sub: 'no model call · $0' });
    d.arrow([[448, 208], [488, 208], [488, 292], [520, 292]], { tone: 'ok' });
    d.box(520, 252, 208, 80, { tone: 'ok', title: 'routed', sub: 'by capability' });
    d.arrow([[728, 292], [760, 292]], { tone: 'ok' });
    d.box(760, 252, 176, 80, { tone: 'line', title: 'usage', sub: 'recorded' });
    d.text(498, 140, 'over cap', { size: 13, color: t.badText });
    d.text(498, 246, 'under cap', { size: 13, color: t.okText });
  },
  landH: 376,
  port(d, t) {
    const x = 24, w = 372;
    d.box(x, 24, w, 64, { tone: 'line', title: 'run request', sub: 'POST /v1/runs' });
    d.arrow([[210, 88], [210, 116]]);
    d.box(x, 116, w, 72, { tone: 'accent', strong: true, title: 'budget check', sub: 'forecast + daily caps' });
    d.arrow([[120, 188], [120, 252]], { tone: 'bad' });
    d.arrow([[300, 188], [300, 252]], { tone: 'ok' });
    d.text(132, 226, 'over cap', { size: 13, color: t.badText });
    d.text(312, 226, 'under', { size: 13, color: t.okText });
    d.box(x, 252, 178, 96, { tone: 'bad', title: '402', sub: 'no model call', sub2: 'costs $0' });
    d.box(x + 194, 252, 178, 96, { tone: 'ok', title: 'routed', sub: 'by capability' });
    d.arrow([[300, 348], [300, 380]], { tone: 'ok' });
    d.box(x + 194, 380, 178, 64, { tone: 'line', title: 'usage', sub: 'recorded' });
  },
  portH: 468,
};

for (const [name, spec] of Object.entries({ 'crash-resume': A, 'sandbox-egress': B, 'your-cloud': C, 'budget-gate': D })) {
  for (const [theme, t] of Object.entries(THEMES)) {
    for (const [suffix, fn, w, h] of [['', spec.land, 960, spec.landH], ['-portrait', spec.port, 420, spec.portH]]) {
      const { api, svg } = make(t, w, h, spec.title, spec.desc);
      fn(api, t);
      writeFileSync(new URL(`${name}${suffix}-${theme}.svg`, OUT), svg());
      if (theme === 'dark') console.log(`${name}${suffix}: ${api.labels} text labels`);
    }
  }
}
