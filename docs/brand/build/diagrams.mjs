// Animated product diagrams -> site/public/media/<name>.svg
//   node docs/brand/build/diagrams.mjs
// Each scene is one CSS-keyframe loop on a self-contained dark stage, so it reads
// the same on a light or dark page (GitHub README, site, social). The static
// markup IS the poster frame: under prefers-reduced-motion nothing animates and
// the finished state shows. Every id/class is prefixed with the file name
// (diagrams can be inlined together). Behaviour shown is grounded in CLAUDE.md:
// Brief/attention engine, commitment gate, voice floor, people graph, world
// model + anticipation, data plane, microVM lifecycle, egress broker + DLP,
// journal crash-resume + receipts, budgets / router / eval gate.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../../../site/public/media/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const C = {
  bg: '#0b0c0f', s1: '#131419', s2: '#1a1c22', s3: '#23252d', line: 'rgba(250,250,248,.09)', line2: 'rgba(250,250,248,.16)',
  t1: '#fafaf8', t2: '#b9bac0', t3: '#8c8e96',
  coral: '#ff7a3d', mag: '#e5207f', palText: '#ff8a6b',
  indigo: '#6c5cff', cyan: '#14c8f0', rtText: '#6fe3ff', violet: '#9a90ff',
  ok: '#5fd3a6', bad: '#ff8a8a', badFill: '#ef4444', hold: '#ffb547',
};
const FONT = `-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',system-ui,sans-serif`;
const MONO = `ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function scene(name, { T, product, title, sub }, draw) {
  const P = name + '-';
  const css = [], anim = [];
  let n = 0;
  const pc = (t) => Math.max(0, Math.min(100, (t / T) * 100)).toFixed(2);
  // Keyframe animation over absolute seconds. steps: [[t, css], ...]
  const kf = (steps, ease = 'linear') => {
    const c = `${P}k${n++}`;
    const all = [...steps];
    if (all[0][0] > 0) all.unshift([0, all[0][1]]);
    if (all.at(-1)[0] < T) all.push([T, all.at(-1)[1]]);
    css.push(`@keyframes ${c}{${all.map(([t, s]) => `${pc(t)}%{${s}}`).join('')}}`);
    anim.push(`.${c}{animation:${c} ${T}s ${ease} infinite}`);
    return c;
  };
  const END = T - 0.45;
  // Visible from t0 to t1 (fades), optional rise.
  const on = (t0, t1 = END, rise = 0) => kf([
    [0, `opacity:0;transform:translateY(${rise}px)`], [t0, `opacity:0;transform:translateY(${rise}px)`],
    [t0 + 0.3, 'opacity:1;transform:translateY(0)'], [t1, 'opacity:1;transform:translateY(0)'],
    [Math.min(T, t1 + 0.3), `opacity:0;transform:translateY(0)`],
  ], 'ease-out');
  // A packet moving along points between t0 and t1.
  const pkt = (pts, t0, t1, color, r = 4.5) => {
    const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    const tot = seg.reduce((a, b) => a + b, 0);
    let acc = 0;
    const steps = [[0, `opacity:0;transform:translate(${pts[0][0]}px,${pts[0][1]}px)`], [t0 - 0.01, `opacity:0;transform:translate(${pts[0][0]}px,${pts[0][1]}px)`], [t0, `opacity:1;transform:translate(${pts[0][0]}px,${pts[0][1]}px)`]];
    pts.slice(1).forEach((p, i) => { acc += seg[i]; steps.push([t0 + (t1 - t0) * (acc / tot), `opacity:1;transform:translate(${p[0]}px,${p[1]}px)`]); });
    const [lx, ly] = pts.at(-1);
    steps.push([t1 + 0.2, `opacity:0;transform:translate(${lx}px,${ly}px)`]);
    return `<g class="${kf(steps)}" opacity="0"><circle r="${r * 2.4}" fill="${color}" opacity=".22"/><circle r="${r}" fill="${color}"/></g>`;
  };
  const pulse = (t, color, len = 0.9) => kf([[0, 'opacity:0'], [t, 'opacity:0'], [t + 0.12, 'opacity:.9'], [t + len, 'opacity:0']]);

  const h = { C, P, T, kf, on, pkt, pulse, END, ...prims(P) };
  const body = draw(h);
  const [r1, r2] = product === 'pal' ? [C.coral, C.mag] : [C.indigo, C.cyan];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" width="960" height="540" role="img" aria-labelledby="${P}title ${P}desc">
<title id="${P}title">${esc(title)}</title><desc id="${P}desc">${esc(sub)}</desc>
<style>
text{font-family:${FONT}}.${P}m{font-family:${MONO}}
${css.join('\n')}
@media (prefers-reduced-motion:no-preference){${anim.join('')}}
</style>
<defs>
<linearGradient id="${P}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${r1}"/><stop offset="1" stop-color="${r2}"/></linearGradient>
<radialGradient id="${P}glow" cx="${product === 'pal' ? '.92' : '.08'}" cy="0" r=".9"><stop offset="0" stop-color="${r2}" stop-opacity=".2"/><stop offset=".5" stop-color="${r1}" stop-opacity=".05"/><stop offset="1" stop-color="${r1}" stop-opacity="0"/></radialGradient>
<pattern id="${P}grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#fff" fill-opacity=".045"/></pattern>
<marker id="${P}ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1 L9 5 L0 9z" fill="${C.t3}"/></marker>
</defs>
<rect width="960" height="540" rx="24" fill="${C.bg}"/><rect width="960" height="540" rx="24" fill="url(#${P}grid)"/><rect width="960" height="540" rx="24" fill="url(#${P}glow)"/>
<rect x=".5" y=".5" width="959" height="539" rx="23.5" fill="none" stroke="${C.line}"/>
<circle cx="45" cy="42" r="5" fill="url(#${P}g)"/><text x="57" y="46.5" font-size="13" font-weight="500" fill="${C.t2}">${product === 'pal' ? 'pal' : 'PAL Runtime'}</text>
<text x="40" y="80" font-size="23" font-weight="650" letter-spacing="-.4" fill="${C.t1}">${esc(title)}</text>
<text x="40" y="105" font-size="14" fill="${C.t3}">${esc(sub)}</text>
${body}
</svg>
`;
  writeFileSync(join(OUT, `${name}.svg`), svg);
  return svg.length;
}

// Drawing primitives.
function prims(P) {
  const tx = (x, y, s, o = {}) => `<text xml:space="preserve" x="${x}" y="${y}" font-size="${o.size || 13}"${o.w ? ` font-weight="${o.w}"` : ''} fill="${o.fill || C.t1}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.mono ? ` class="${P}m"` : ''}${o.ls ? ` letter-spacing="${o.ls}"` : ''}${o.op ? ` opacity="${o.op}"` : ''}>${o.raw ? s : esc(s)}</text>`;
  const box = (x, y, w, hh, o = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="${o.rx ?? 12}" fill="${o.fill || C.s1}" stroke="${o.stroke || C.line}"${o.sw ? ` stroke-width="${o.sw}"` : ''}${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}${o.op ? ` opacity="${o.op}"` : ''}/>`;
  const g = (cls, inner, o = {}) => `<g${cls ? ` class="${cls}"` : ''}${o.op !== undefined ? ` opacity="${o.op}"` : ''}>${inner}</g>`;
  const line = (d, o = {}) => `<path d="${d}" fill="none" stroke="${o.stroke || C.line2}" stroke-width="${o.sw || 1.5}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}${o.arrow ? ` marker-end="url(#${P}ar)"` : ''} stroke-linecap="round"${o.op ? ` opacity="${o.op}"` : ''}/>`;
  // Chat bubble. lines: string | [text, opts]. Returns {svg, h}.
  const bubble = (x, y, w, lines, o = {}) => {
    const lh = 18, hh = 14 + lines.length * lh;
    const bx = o.me ? x - w : x;
    const fill = o.me ? `url(#${P}g)` : (o.fill || C.s3);
    let s = `<rect x="${bx}" y="${y}" width="${w}" height="${hh}" rx="15" fill="${fill}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="1.5"` : ''}${o.dash ? ` stroke-dasharray="${o.dash}" fill-opacity=".0"` : ''}/>`;
    if (o.accent) s += `<rect x="${bx}" y="${y + 8}" width="3" height="${hh - 16}" rx="1.5" fill="${o.accent}"/>`;
    lines.forEach((l, i) => {
      const [t, lo] = Array.isArray(l) ? l : [l, {}];
      s += tx(bx + 13, y + 21 + i * lh, t, { size: 13, fill: o.me ? '#fff' : C.t1, ...lo });
    });
    return { svg: s, h: hh };
  };
  const phone = (x, y, w, hh, title, sub) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="34" fill="${C.s1}" stroke="${C.line2}" stroke-width="1.5"/>` +
    `<rect x="${x + 6}" y="${y + 6}" width="${w - 12}" height="${hh - 12}" rx="28" fill="#0e0f13"/>` +
    `<rect x="${x + w / 2 - 38}" y="${y + 14}" width="76" height="20" rx="10" fill="#000"/>` +
    `<path d="M${x + 6} ${y + 84} H${x + w - 6}" stroke="${C.line}"/>` +
    `<circle cx="${x + w / 2}" cy="${y + 54}" r="11" fill="${C.s3}"/>` + tx(x + w / 2, y + 58.5, title[0].toUpperCase(), { size: 11, w: 600, anchor: 'middle', fill: C.t2 }) +
    tx(x + w / 2, y + 78, title, { size: 11, anchor: 'middle', fill: C.t2 }) +
    (sub ? tx(x + w - 22, y + 58, sub, { size: 10, anchor: 'end', fill: C.t3 }) : '');
  const chip = (x, y, s, color, o = {}) => {
    const w = o.w || s.length * 6.4 + 18;
    return `<rect x="${x}" y="${y}" width="${w}" height="20" rx="10" fill="${color}" fill-opacity="${o.fo ?? 0.14}" stroke="${color}" stroke-opacity=".45"/>` + tx(x + w / 2, y + 14, s, { size: 11, w: 600, anchor: 'middle', fill: color, mono: o.mono });
  };
  const typing = (x, y, cls) => `<g class="${cls}" opacity="0"><rect x="${x}" y="${y}" width="52" height="30" rx="15" fill="${C.s3}"/>${[0, 1, 2].map((i) => `<circle cx="${x + 15 + i * 11}" cy="${y + 15}" r="3.2" fill="${C.t3}"/>`).join('')}</g>`;
  const check = (x, y, color = C.ok, r = 9) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-opacity=".6"/><path d="M${x - r * 0.42} ${y} l${r * 0.3} ${r * 0.32} l${r * 0.55} -${r * 0.62}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
  const cross = (x, y, color = C.bad, r = 9) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-opacity=".6"/><path d="M${x - r * 0.35} ${y - r * 0.35} l${r * 0.7} ${r * 0.7} M${x + r * 0.35} ${y - r * 0.35} l-${r * 0.7} ${r * 0.7}" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>`;
  return { tx, box, g, line, bubble, phone, chip, typing, check, cross };
}

const sizes = {};
const add = (name, meta, fn) => { sizes[name] = scene(name, meta, fn); };

/* ───────────────────────── pal: Brief ───────────────────────── */
add('pal-brief', { T: 13, product: 'pal', title: 'Brief: what needs you, ranked', sub: 'Type ? and pal ranks waiting threads, drafts and promises across every chat. One tap acts on the top item.' }, (h) => {
  const { C, tx, box, g, line, bubble, phone, on, pkt, kf, typing, check } = h;
  let s = tx(40, 152, 'What pal noticed', { size: 12, fill: C.t3, w: 500 });
  const cards = [
    ['Priya', 'waiting on you · 3 days', C.hold],
    ['Draft to Sam', 'written, needs your ok', C.palText],
    ['Send Alex the deck', 'you promised Tuesday', C.violet],
  ];
  cards.forEach(([t, d, col], i) => {
    const y = 166 + i * 76;
    s += g(null, box(40, y, 280, 60, { rx: 14 }) + `<circle cx="66" cy="${y + 30}" r="11" fill="${col}" fill-opacity=".16" stroke="${col}" stroke-opacity=".55"/><circle cx="66" cy="${y + 30}" r="3.5" fill="${col}"/>` +
      tx(88, y + 26, t, { w: 600, size: 14 }) + tx(88, y + 45, d, { size: 12, fill: C.t3 }));
    s += g(h.kf([[0, 'opacity:0'], [1 + i * 0.45, 'opacity:0'], [1.15 + i * 0.45, 'opacity:1'], [1.9 + i * 0.45, 'opacity:0']]), box(40, y, 280, 60, { rx: 14, fill: 'none', stroke: col, sw: 1.5 }), { op: 0 });
    s += line(`M320 ${y + 30} C350 ${y + 30} 345 262 380 262`, { op: 0.9 });
    s += pkt([[320, y + 30], [350, y + 30 + (262 - y - 30) * 0.5], [380, 262]], 1.1 + i * 0.45, 1.7 + i * 0.45, col, 3.5);
  });
  // Ranker
  s += box(380, 222, 150, 80, { rx: 16, fill: C.s2, stroke: `url(#${h.P}g)`, sw: 1.5 });
  s += g(h.pulse(2.4, 0, 1.4), `<rect x="374" y="216" width="162" height="92" rx="20" fill="none" stroke="${C.mag}" stroke-width="2" opacity=".6"/>`, { op: 0 });
  s += tx(455, 255, 'Rank', { anchor: 'middle', w: 650, size: 16 }) + tx(455, 274, 'who and what matters', { anchor: 'middle', size: 11.5, fill: C.t3 }) + tx(455, 292, 'LLM · order + why only', { anchor: 'middle', size: 10.5, fill: C.t3, mono: 1 });
  s += line('M530 262 C560 262 560 290 594 290', { op: 0.9 }) + pkt([[530, 262], [560, 276], [594, 290]], 3.0, 3.4, C.mag, 3.5);
  // Phone
  s += phone(594, 122, 326, 410, 'pal', 'self-chat');
  s += g(on(0.4, h.END, 6), bubble(902, 220, 36, ['?'], { me: 1 }).svg, { op: 1 });
  s += typing(612, 262, kf([[0, 'opacity:0'], [2.7, 'opacity:0'], [2.9, 'opacity:1'], [3.55, 'opacity:1'], [3.7, 'opacity:0']]));
  const brief = bubble(612, 262, 266, [
    ['3 things need you', { w: 650 }],
    '1  Priya · waiting 3 days',
    ['    she asked about Saturday', { fill: C.t3, size: 12 }],
    '2  Draft to Sam · ready to send',
    '3  Send Alex the deck · due Tue',
  ]);
  s += g(on(3.6, h.END, 8), brief.svg + g(on(9.6), `<path d="M640 297 H786" stroke="${C.t2}" stroke-width="1.4"/>`, { op: 1 }));
  s += g(on(5.4, h.END, 0), `<circle cx="874" cy="264" r="15" fill="${C.s2}" stroke="#0e0f13" stroke-width="3"/>` + tx(874, 269, '👍', { size: 13, anchor: 'middle' }), { op: 1 });
  const d = bubble(612, 380, 248, ['Draft to Priya:', ['“Sat works! 11 at the park?”', { fill: C.t1 }], ['reply send to approve', { fill: C.t3, size: 12 }]]);
  s += g(on(6.4, h.END, 8), d.svg);
  s += g(on(8.2, h.END, 8), bubble(902, 452, 62, ['send'], { me: 1 }).svg);
  s += g(on(9.2, h.END, 4), tx(902, 503, 'Sent to Priya', { size: 11.5, anchor: 'end', fill: C.t3 }) + check(806, 499, C.ok, 7));
  s += g(on(9.6, h.END, 0), check(296, 196, C.ok, 10));
  s += tx(40, 432, 'Reactions act on the top item', { size: 12, fill: C.t3, w: 500 });
  [['👍', 'do it'], ['👎', 'skip'], ['⏰', 'snooze'], ['❓', 'show me']].forEach(([e, t], i) => { const x = 40 + i * 132; s += box(x, 446, 122, 36, { rx: 18, fill: C.s1 }) + tx(x + 16, 469, e, { size: 14 }) + tx(x + 40, 469, t, { size: 12.5, fill: C.t2 }); });
  return s;
});

/* ───────────────────────── pal: Holds ───────────────────────── */
add('pal-holds', { T: 13, product: 'pal', title: 'Holds: it asks before it promises', sub: 'Money, commitments and claims it can’t verify wait for your yes. Enforced at the send boundary, not in a prompt.' }, (h) => {
  const { C, tx, box, g, line, bubble, phone, on, pkt, kf, chip, cross, check } = h;
  let s = phone(40, 122, 300, 410, 'Jordan', 'iMessage');
  s += g(on(0.4, h.END, 6), bubble(58, 222, 224, ['hey, can you send 700 for rent?', 'need it today']).svg);
  // ghost draft
  s += g(on(1.5, 3.3, 6), tx(322, 300, 'pal’s draft', { size: 11, anchor: 'end', fill: C.t3 }) + `<rect x="128" y="308" width="194" height="32" rx="15" fill="none" stroke="${C.palText}" stroke-dasharray="4 4" stroke-width="1.4"/>` + tx(141, 329, 'sure, sending it tonight', { fill: C.palText }), { op: 0 });
  s += pkt([[322, 324], [350, 324], [372, 300]], 3.0, 3.5, C.palText, 3.5);
  s += g(on(9.7, h.END, 8), bubble(322, 308, 172, ['let me call you tonight'], { me: 1 }).svg + tx(322, 357, 'sent · your words', { size: 11, anchor: 'end', fill: C.t3 }));
  // Gate
  s += tx(480, 160, 'Send boundary', { size: 12, anchor: 'middle', fill: C.t3, w: 500 });
  s += line('M480 168 V500', { dash: '3 5', op: 0.7 });
  s += box(372, 214, 216, 204, { rx: 16, fill: C.s2 });
  s += tx(390, 242, 'Commitment gate', { w: 650, size: 15 });
  s += tx(390, 276, 'LLM judge', { size: 12.5, fill: C.t2 }) + tx(390, 293, 'draft promises money', { size: 11.5, fill: C.t3 });
  s += tx(390, 326, 'Backstop, always on', { size: 12.5, fill: C.t2 }) + tx(390, 343, 'money ask in the thread', { size: 11.5, fill: C.t3 });
  s += g(on(3.7), cross(562, 282, C.hold, 10), { op: 1 }) + g(on(4.05), cross(562, 332, C.hold, 10), { op: 1 });
  s += g(on(4.5, h.END, 0), `<rect x="430" y="362" width="100" height="40" rx="20" fill="${C.hold}"/>` + tx(480, 387.5, 'HELD', { anchor: 'middle', w: 750, size: 14, fill: '#1a1205', ls: 1.5 }), { op: 1 });
  s += g(kf([[0, 'opacity:0;transform:scale(1)'], [4.5, 'opacity:0'], [4.55, 'opacity:.8'], [5.4, 'opacity:0']]), `<rect x="426" y="358" width="108" height="48" rx="24" fill="none" stroke="${C.hold}" stroke-width="2"/>`, { op: 0 });
  s += pkt([[530, 382], [600, 382], [632, 300]], 5.0, 5.5, C.hold, 3.5);
  // Owner phone
  s += phone(620, 122, 300, 410, 'pal', 'self-chat');
  s += g(on(5.6, h.END, 6), bubble(638, 222, 262, [['HELD · Jordan is asking for money', { w: 650, fill: C.hold }], 'Draft: “sure, sending it tonight”', ['reply send, or tell me what to say', { fill: C.t3, size: 12 }]], { accent: C.hold }).svg);
  s += g(on(7.4, h.END, 6), bubble(902, 310, 182, ['say I’ll call him tonight'], { me: 1 }).svg);
  s += g(on(9.6, h.END, 6), bubble(638, 356, 240, ['Sent to Jordan:', '“let me call you tonight”']).svg + check(860, 375, C.ok, 8));
  void chip; return s;
});

/* ───────────────────────── pal: sounds like you ───────────────────────── */
add('pal-voice', { T: 12, product: 'pal', title: 'Sounds like you, not a bot', sub: 'Every draft is scored against messages you really sent. One that drifts from your voice is rewritten before it goes out.' }, (h) => {
  const { C, tx, box, g, line, on, chip, check, cross, kf } = h;
  let s = '';
  s += g(null, box(40, 140, 360, 54, { rx: 14 }) + tx(58, 162, 'Priya', { size: 12, fill: C.t3 }) + tx(58, 182, 'are we still on for saturday?', { size: 14 }));
  // Draft 1
  s += g(on(0.8, 4.6, 8), box(40, 214, 360, 92, { rx: 14, fill: C.s2 }) + tx(58, 238, 'Draft 1', { size: 12, fill: C.t3 }) + tx(58, 262, 'Certainly! I’d be happy to confirm', { size: 14 }) + tx(58, 282, 'our plans for Saturday.', { size: 14 }), { op: 0.35 });
  s += g(on(1.8, 4.6), chip(232, 226, 'bot-tell · stock phrase', C.bad, { w: 156 }), { op: 0.35 });
  // Draft 2 (final)
  s += g(on(5.2, h.END, 8), box(40, 324, 360, 70, { rx: 14, fill: C.s2, stroke: C.ok, sw: 1.2 }) + tx(58, 348, 'Rewritten', { size: 12, fill: C.t3 }) + tx(58, 372, 'haha yes, sat works 👍 11?', { size: 15 }));
  s += g(on(7.0, h.END, 6), check(380, 338, C.ok, 9) + tx(372, 414, 'sent', { size: 12, fill: C.ok, anchor: 'end' }));
  // Score axis
  const X0 = 450, X1 = 910, Y = 290, xs = (v) => X0 + (X1 - X0) * v;
  s += tx(X0, 150, 'Voice score', { w: 650, size: 15 }) + tx(X0, 170, 'distance from your own sent messages', { size: 12, fill: C.t3 });
  s += line(`M${X0} ${Y} H${X1}`, { stroke: C.line2 });
  s += tx(X0, Y + 22, 'you · your real messages', { size: 11, fill: C.t3 }) + tx(X1, Y + 24, 'not you', { size: 11, fill: C.t3, anchor: 'end' });
  // your messages: deterministic swarm
  let seed = 7; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 46; i++) { const v = 0.04 + Math.pow(rnd(), 1.6) * 0.38; s += `<circle cx="${xs(v).toFixed(1)}" cy="${(Y - 14 - rnd() * 34).toFixed(1)}" r="3" fill="${C.t2}" opacity=".45"/>`; }
  s += `<path d="M${xs(0.44)} ${Y - 62} V${Y + 8}" stroke="${C.hold}" stroke-width="1.5" stroke-dasharray="3 3"/>` + tx(xs(0.44), Y + 22, 'your floor (p95) 0.44', { size: 11, fill: C.hold, anchor: 'middle' });
  // markers
  const mark = (v, col, lbl, cls, op) => g(cls, `<path d="M${xs(v)} ${Y - 56} V${Y}" stroke="${col}" stroke-width="2"/><circle cx="${xs(v)}" cy="${Y - 62}" r="7" fill="${col}"/>` + tx(xs(v), Y - 76, lbl, { size: 12, w: 650, anchor: 'middle', fill: col }), { op });
  s += mark(0.71, C.bad, 'draft 1 · 0.71', on(2.0, 4.6, -10), 0.35);
  s += g(on(2.4, 4.6), tx(xs(0.71), Y + 46, 'too far from you → rewrite', { size: 12, anchor: 'middle', fill: C.bad }) + cross(xs(0.71) - 92, Y + 42, C.bad, 7), { op: 0 });
  s += mark(0.19, C.ok, 'rewrite · 0.19', on(6.0, h.END, -10), 1);
  // exemplars
  s += g(on(3.2, h.END, 6), tx(X0, 356, 'Grounded in your 5 closest real messages', { size: 12, fill: C.t3 }), { op: 1 });
  let xx = X0;
  ['haha yes', 'sat works', '11?', 'see u there 👍', 'ya def'].forEach((t, i) => {
    const cw = t.length * 7 + 22;
    s += g(on(3.4 + i * 0.18, h.END, 6), `<rect x="${xx}" y="370" width="${cw}" height="30" rx="15" fill="url(#${h.P}g)" fill-opacity=".9"/>` + tx(xx + 11, 390, t, { size: 13, fill: '#fff' }));
    xx += cw + 8;
  });
  s += g(on(3.4, h.END), tx(X0, 440, 'Also checked: no stock phrases, no repeated skeleton,', { size: 12, fill: C.t3 }) + tx(X0, 458, 'no denying facts in your profile.', { size: 12, fill: C.t3 }), { op: 1 });
  void kf; return s;
});

/* ───────────────────────── pal: memory ───────────────────────── */
add('pal-memory', { T: 12, product: 'pal', title: 'One memory per person, across chats', sub: 'iMessage and WhatsApp resolve to the same person, so what they told you on one is there on the other.' }, (h) => {
  const { C, tx, box, g, line, on, pkt, chip, bubble } = h;
  let s = '';
  const src = [
    ['iMessage', '+1 512 555 0142', 'moving to Austin in December', 168],
    ['WhatsApp', 'Priya R.', 'can you send the sitter’s number?', 284],
  ];
  src.forEach(([ch, hd, msg, y], i) => {
    s += box(40, y, 290, 92, { rx: 14 }) + tx(58, y + 24, ch, { size: 12, w: 600, fill: C.t2 }) + tx(312, y + 24, hd, { size: 11, fill: C.t3, anchor: 'end', mono: 1 });
    s += g(on(0.5 + i * 0.6, h.END, 6), bubble(58, y + 36, 254, [msg]).svg);
    s += line(`M330 ${y + 46} C370 ${y + 46} 360 260 400 260`, { op: 0.9 });
    s += pkt([[330, y + 46], [365, (y + 46 + 260) / 2], [400, 260]], 1.3 + i * 0.6, 1.9 + i * 0.6, C.palText, 3.5);
  });
  // person
  s += box(400, 190, 200, 140, { rx: 18, fill: C.s2, stroke: `url(#${h.P}g)`, sw: 1.5 });
  s += `<circle cx="440" cy="232" r="20" fill="url(#${h.P}g)"/>` + tx(440, 238, 'P', { anchor: 'middle', w: 700, size: 16, fill: '#fff' });
  s += tx(470, 228, 'Priya', { w: 650, size: 16 }) + tx(470, 246, 'college friend', { size: 12, fill: C.t3 });
  s += g(on(2.6, h.END), chip(416, 266, '2 handles · 1 person', C.palText, { w: 168 }), { op: 1 });
  s += tx(416, 312, '/v1/people/resolve', { size: 10.5, fill: C.t3, mono: 1 });
  // timeline
  s += tx(640, 160, 'Timeline', { w: 650, size: 15 }) + tx(640, 178, 'dated episodes, both channels', { size: 12, fill: C.t3 });
  s += line('M652 196 V352', { stroke: C.line2 });
  const ev = [['Oct 21', 'iMessage', 'moving to Austin in December'], ['Oct 25', 'WhatsApp', 'asked for the sitter’s number'], ['Oct 27', 'iMessage', 'Saturday at the park?']];
  ev.forEach(([d, c, t], i) => {
    const y = 210 + i * 52;
    s += g(on(2.8 + i * 0.4, h.END, 6), `<circle cx="652" cy="${y}" r="5" fill="${C.bg}" stroke="${C.palText}" stroke-width="2"/>` + tx(668, y + 4, `${d} · ${c}`, { size: 11.5, fill: C.t3 }) + tx(668, y + 22, t, { size: 13 }), { op: 1 });
  });
  s += line('M600 260 H630', { op: 0.9, arrow: 1 });
  // recall
  s += box(40, 410, 880, 104, { rx: 16, fill: C.s1 });
  s += tx(58, 434, 'Later, on WhatsApp', { size: 12, fill: C.t3 });
  s += g(on(5.0, h.END, 6), bubble(58, 446, 300, ['how’s the house hunt going?']).svg);
  s += g(on(6.6, h.END, 6), bubble(902, 446, 380, ['slowly! you’re still set for austin in dec, right?'], { me: 1 }).svg);
  s += g(on(6.6, h.END), tx(902, 504, 'recalled from iMessage · Oct 21', { size: 11, anchor: 'end', fill: C.palText }), { op: 1 });
  s += pkt([[652, 210], [652, 400], [700, 446]], 5.8, 6.5, C.palText, 3.5);
  return s;
});

/* ───────────────────────── pal: world model + nudges ───────────────────────── */
add('pal-world', { T: 13, product: 'pal', title: 'Knows what’s true now, and nudges first', sub: 'A dated picture of your life from mail, calendar and your own notes. Every line cites a source; nothing is typed in by hand.' }, (h) => {
  const { C, tx, box, g, line, on, pkt, kf, chip } = h;
  let s = tx(40, 152, 'Evidence', { size: 12, fill: C.t3, w: 500 });
  const src = [
    ['Mail', 'Opening moved to Nov 18 · vendor confirm', C.t2],
    ['Calendar', 'Thu 10:00 · 1:1 with Sam', C.t2],
    ['Your note', 'opening is the 18th now', C.palText],
  ];
  src.forEach(([k, t, col], i) => {
    const y = 166 + i * 70;
    s += box(40, y, 300, 56, { rx: 14 }) + tx(58, y + 23, k, { size: 11.5, w: 600, fill: C.t3 }) + tx(58, y + 42, t, { size: 13, fill: col === C.palText ? C.t1 : C.t1 });
    s += line(`M340 ${y + 28} C366 ${y + 28} 360 254 384 254`, { op: 0.85 });
    s += pkt([[340, y + 28], [362, (y + 28 + 254) / 2], [384, 254]], 0.8 + i * 0.35, 1.4 + i * 0.35, C.palText, 3.5);
  });
  // world model card
  s += box(384, 160, 270, 190, { rx: 16, fill: C.s2 });
  s += tx(402, 186, 'World model', { w: 650, size: 15 }) + tx(636, 186, '## Now', { size: 11.5, fill: C.t3, anchor: 'end', mono: 1 });
  s += tx(402, 222, 'store opening', { size: 13, fill: C.t2 });
  s += g(kf([[0, 'opacity:1'], [2.6, 'opacity:1'], [2.9, 'opacity:0']]), tx(560, 222, 'Nov 10', { size: 13, w: 650, fill: C.t3 }) + `<path d="M558 218 H608" stroke="${C.bad}" stroke-width="1.5"/>`, { op: 0 });
  s += g(on(2.9, h.END, 4), tx(560, 222, 'Nov 18', { size: 13, w: 650, fill: C.ok }), { op: 1 });
  s += g(on(3.0, h.END), tx(402, 240, 'source: mail “Opening moved to Nov 18”', { size: 10.5, fill: C.t3, mono: 1 }), { op: 1 });
  s += `<path d="M402 256 H636" stroke="${C.line}"/>`;
  s += tx(402, 280, '1:1 with Sam', { size: 13, fill: C.t2 }) + tx(560, 280, 'Thu 10:00', { size: 13, w: 650 });
  s += tx(402, 298, 'source: calendar', { size: 10.5, fill: C.t3, mono: 1 });
  s += g(on(3.4, h.END), chip(402, 316, 'no source → dropped', C.t3, { w: 150, fo: 0.08 }), { op: 1 });
  s += g(on(3.6, h.END, 6), box(384, 368, 270, 52, { rx: 14, fill: C.s1, stroke: C.palText }) + tx(400, 391, '🧭 updated what I know:', { size: 12.5 }) + tx(400, 409, 'opening is Nov 18 (from mail)', { size: 12.5, fill: C.t2 }), { op: 1 });
  // nudges
  s += tx(690, 152, 'Nudges', { size: 12, fill: C.t3, w: 500 });
  const nd = [
    ['in 10 min', '1:1 with Sam starts soon', 'pulling up your last thread'],
    ['3 days', 'You haven’t replied to Priya', 'want me to take a crack at it?'],
    ['tomorrow', 'Your anniversary is tomorrow', 'want me to draft something?'],
  ];
  nd.forEach(([w, a, b], i) => {
    const y = 166 + i * 84;
    s += g(on(5.4 + i * 1.3, h.END, 10), box(690, y, 230, 70, { rx: 16, fill: C.s2, stroke: C.line2 }) + `<circle cx="712" cy="${y + 22}" r="8" fill="url(#${h.P}g)"/>` + tx(726, y + 26, 'pal', { size: 11.5, w: 600, fill: C.t2 }) + tx(904, y + 26, w, { size: 11, fill: C.t3, anchor: 'end' }) + tx(704, y + 46, a, { size: 13, w: 600 }) + tx(704, y + 62, b, { size: 12, fill: C.t3 }));
  });
  s += pkt([[654, 300], [672, 300], [690, 200]], 5.0, 5.4, C.palText, 3.5);
  s += g(null, tx(690, 430, 'Quiet hours, mute and the kill switch apply.', { size: 11.5, fill: C.t3 }));
  return s;
});

/* ───────────────────────── Runtime: architecture ───────────────────────── */
add('runtime-architecture', { T: 12, product: 'runtime', title: 'Control plane in the cloud, data plane in yours', sub: 'Your VPC dials out, so there are no inbound ports. Runs, sandboxes and run data stay on your side.' }, (h) => {
  const { C, tx, box, g, line, on, pkt, kf, chip, cross, check } = h;
  let s = '';
  const node = (x, y, w, t, d, col = C.line2) => box(x, y, w, 54, { rx: 12, fill: C.s2, stroke: col }) + tx(x + 14, y + 23, t, { w: 600, size: 13.5 }) + tx(x + 14, y + 41, d, { size: 11, fill: C.t3, mono: 1 });
  // clients
  s += box(40, 134, 330, 40, { rx: 12, fill: C.s1 }) + tx(56, 159, 'SDK · CLI · console', { size: 13, w: 600 }) + tx(354, 159, 'REST /v1 · SSE', { size: 11, fill: C.t3, mono: 1, anchor: 'end' });
  // control plane zone
  s += box(40, 196, 330, 316, { rx: 20, fill: 'none', stroke: C.line2, dash: '5 5' }) + tx(56, 220, 'Control plane', { size: 12.5, w: 600, fill: C.t2 }) + tx(354, 220, 'managed or self-hosted', { size: 11, fill: C.t3, anchor: 'end' });
  s += node(56, 234, 298, 'API + console', ':8080 · tenants, runs, budgets');
  s += node(56, 300, 143, 'Scheduler', 'placement');
  s += node(211, 300, 143, 'Model router', ':50053');
  s += node(56, 366, 298, 'Receipts + audit', 'Ed25519 · journal hash');
  s += tx(56, 450, 'never touches your code', { size: 11.5, fill: C.t3 }) + tx(56, 468, 'or your run data', { size: 11.5, fill: C.t3 });
  // data plane zone
  s += `<rect x="440" y="134" width="480" height="378" rx="20" fill="${C.indigo}" fill-opacity=".05" stroke="url(#${h.P}g)" stroke-width="1.5"/>`;
  s += tx(458, 160, 'Data plane · your VPC', { size: 12.5, w: 600, fill: C.rtText }) + tx(904, 160, 'EKS · GKE · AKS', { size: 11, fill: C.t3, anchor: 'end' });
  s += node(458, 176, 210, 'Data-plane agent', 'dials out · mTLS', C.cyan);
  s += node(690, 176, 212, 'Workflow engine', ':50052 · journal');
  s += node(458, 252, 444, 'Runtime manager', ':50054 · Firecracker · Kata · Wasmtime');
  // microVMs
  ['vm-7f3a', 'vm-91c2', 'vm-a04e'].forEach((v, i) => {
    const x = 458 + i * 152;
    s += box(x, 330, 140, 84, { rx: 14, fill: C.s1, stroke: C.line2, sw: 1.5 }) + tx(x + 12, 352, 'microVM', { size: 12, w: 600 }) + tx(x + 128, 352, v, { size: 10, fill: C.t3, anchor: 'end', mono: 1 });
    s += `<rect x="${x + 12}" y="364" width="116" height="36" rx="9" fill="${C.hold}" fill-opacity=".1" stroke="${C.hold}" stroke-opacity=".5"/>` + tx(x + 22, 387, 'your agent code', { size: 11.5, fill: C.hold });
    s += g(kf([[0, 'opacity:0'], [4.1 + i * 0.2, 'opacity:0'], [4.3 + i * 0.2, 'opacity:1'], [5.2 + i * 0.2, 'opacity:0']]), `<rect x="${x - 3}" y="327" width="146" height="90" rx="16" fill="none" stroke="${C.cyan}" stroke-width="2"/>`, { op: 0 });
  });
  s += node(458, 432, 444, 'Your data', 'Postgres · S3 · secrets stay in your account');
  // conduit
  s += line('M458 203 H400 V261 H354', { stroke: C.cyan, sw: 2, op: 0.6 });
  s += tx(405, 296, 'out-', { size: 10.5, fill: C.rtText, anchor: 'middle', mono: 1 }) + tx(405, 310, 'bound', { size: 10.5, fill: C.rtText, anchor: 'middle', mono: 1 });
  s += pkt([[458, 203], [400, 203], [400, 261], [354, 261]], 0.4, 1.2, C.cyan, 4);
  s += pkt([[205, 174], [205, 234]], 1.6, 1.9, C.violet, 4);
  s += pkt([[354, 261], [400, 261], [400, 203], [458, 203]], 2.1, 2.8, C.violet, 4);
  s += pkt([[668, 203], [690, 203]], 2.9, 3.1, C.violet, 4);
  s += pkt([[796, 230], [796, 252]], 3.2, 3.4, C.violet, 4);
  s += pkt([[680, 306], [680, 330]], 3.6, 3.9, C.violet, 4);
  s += pkt([[458, 203], [400, 203], [400, 261], [354, 261]], 6.2, 6.9, C.cyan, 4);
  s += pkt([[205, 234], [205, 174]], 7.0, 7.3, C.cyan, 4);
  s += g(on(7.2, h.END, 0), tx(205, 128, 'streamed back', { size: 11, fill: C.rtText, anchor: 'middle' }), { op: 0 });
  // inbound refused
  s += pkt([[960, 300], [924, 300]], 8.4, 8.8, C.bad, 4);
  s += g(on(8.8, 10.8), cross(920, 300, C.bad, 11) + tx(908, 284, 'inbound refused', { size: 11, fill: C.bad, anchor: 'end' }), { op: 0 });
  void chip; void check; return s;
});

/* ───────────────────────── Runtime: microVM lifecycle ───────────────────────── */
add('runtime-lifecycle', { T: 14, product: 'runtime', title: 'Sandboxes that pause, resume and fork', sub: 'Snapshot a running microVM, free its slot, bring it back with the same id, or fork it into many that share memory.' }, (h) => {
  const { C, tx, box, g, line, on, pkt, kf, chip } = h;
  let s = '';
  // request log
  s += box(40, 134, 286, 378, { rx: 16, fill: '#08090c' });
  s += tx(58, 160, 'requests', { size: 11.5, fill: C.t3, mono: 1 });
  const reqs = [['POST', '/v1/runtime/schedule', 0.4], ['', '→ vm-7f3a running', 1.0, C.ok], ['POST', '/vms/vm-7f3a/pause', 3.6], ['', '→ snapshot, slot freed', 4.6, C.ok], ['POST', '/vms/vm-7f3a/resume', 6.8], ['', '→ same vm id, running', 7.6, C.ok], ['POST', '/vms/vm-7f3a/fork {count:3}', 9.4], ['', '→ 3 forks, CoW memory', 10.6, C.ok]];
  reqs.forEach(([m, p, t, col], i) => {
    const y = 192 + i * 38;
    s += g(on(t, h.END, 4), (m ? tx(58, y, m, { size: 11.5, fill: C.violet, mono: 1, w: 600 }) : '') + tx(m ? 98 : 58, y, p, { size: 11.5, fill: col || C.t1, mono: 1 }), { op: 1 });
  });
  // VM
  const vx = 370, vy = 150;
  const vmState = kf([[0, `opacity:1`], [4.0, 'opacity:1'], [4.4, 'opacity:.35'], [7.4, 'opacity:.35'], [7.8, 'opacity:1']]);
  s += g(vmState, box(vx, vy, 250, 150, { rx: 18, fill: C.s2, stroke: C.cyan, sw: 2 }) +
    tx(vx + 18, vy + 28, 'vm-7f3a', { w: 650, size: 14, mono: 1 }) + tx(vx + 18, vy + 46, 'Firecracker · node-a', { size: 11, fill: C.t3 }) +
    [...Array(24)].map((_, i) => `<rect x="${vx + 18 + (i % 12) * 18}" y="${vy + 66 + Math.floor(i / 12) * 18}" width="14" height="14" rx="3" fill="${C.indigo}" fill-opacity="${0.35 + ((i * 7) % 5) / 10}"/>`).join('') +
    tx(vx + 18, vy + 128, 'memory pages', { size: 11, fill: C.t3 }));
  s += g(kf([[0, 'opacity:1'], [4.0, 'opacity:1'], [4.2, 'opacity:0'], [7.6, 'opacity:0'], [7.8, 'opacity:1']]), chip(vx + 164, vy + 14, 'running', C.ok, { w: 72 }), { op: 1 });
  s += g(kf([[0, 'opacity:0'], [4.2, 'opacity:0'], [4.4, 'opacity:1'], [7.6, 'opacity:1'], [7.8, 'opacity:0']]), chip(vx + 164, vy + 14, 'paused', C.hold, { w: 72 }), { op: 0 });
  // heartbeat
  s += g(kf([[0, 'opacity:0'], [1.0, 'opacity:0'], [1.2, 'opacity:1'], [4.0, 'opacity:1'], [4.2, 'opacity:0'], [7.8, 'opacity:0'], [8.0, 'opacity:1']]), `<path d="M${vx + 140} ${vy + 46} h20 l6 -10 l8 18 l6 -8 h24" fill="none" stroke="${C.ok}" stroke-width="1.6" stroke-linejoin="round"/>`, { op: 1 });
  // snapshot
  s += box(vx, 360, 250, 74, { rx: 16, fill: C.s1, stroke: C.line2, dash: '5 4' });
  s += tx(vx + 18, 386, 'snapshot', { w: 600, size: 13 }) + tx(vx + 18, 404, 'vmstate + mem file on disk', { size: 11, fill: C.t3 });
  s += g(on(4.5, h.END, 0), [...Array(12)].map((_, i) => `<rect x="${vx + 18 + i * 18}" y="414" width="14" height="10" rx="2.5" fill="${C.indigo}" fill-opacity=".7"/>`).join(''), { op: 1 });
  [0, 1, 2, 3].forEach((i) => { s += pkt([[vx + 40 + i * 50, vy + 150], [vx + 40 + i * 50, 360]], 3.9 + i * 0.08, 4.4 + i * 0.08, C.indigo, 3.5); });
  [0, 1, 2, 3].forEach((i) => { s += pkt([[vx + 60 + i * 44, 360], [vx + 60 + i * 44, vy + 150]], 7.1 + i * 0.08, 7.6 + i * 0.08, C.cyan, 3.5); });
  // quota
  s += tx(vx, 468, 'tenant quota', { size: 11.5, fill: C.t3 });
  [0, 1, 2, 3, 4, 5].forEach((i) => {
    const used = i < 2;
    s += `<rect x="${vx + 90 + i * 26}" y="456" width="20" height="16" rx="4" fill="${used ? C.cyan : C.s3}" fill-opacity="${used ? 0.8 : 1}"/>`;
  });
  s += g(kf([[0, 'opacity:0'], [4.4, 'opacity:0'], [4.6, 'opacity:1'], [7.4, 'opacity:1'], [7.6, 'opacity:0']]), `<rect x="${vx + 116}" y="456" width="20" height="16" rx="4" fill="${C.s3}"/>` + tx(vx + 260, 468, 'slot freed', { size: 11, fill: C.hold, anchor: 'end' }), { op: 0 });
  s += g(on(10.6, h.END), [2, 3, 4].map((i) => `<rect x="${vx + 90 + i * 26}" y="456" width="20" height="16" rx="4" fill="${C.cyan}" fill-opacity=".8"/>`).join(''), { op: 1 });
  // forks
  s += tx(660, 160, 'forks', { size: 11.5, fill: C.t3, mono: 1 });
  ['vm-91c2', 'vm-a04e', 'vm-c7d9'].forEach((v, i) => {
    const y = 172 + i * 92;
    s += g(on(10.0 + i * 0.25, h.END, 0), box(660, y, 260, 76, { rx: 16, fill: C.s2, stroke: C.cyan, sw: 1.5 }) + tx(678, y + 26, v, { w: 650, size: 13.5, mono: 1 }) + tx(678, y + 44, 'own id, cert, identity', { size: 11, fill: C.t3 }) +
      [...Array(10)].map((_, j) => `<rect x="${678 + j * 18}" y="${y + 52}" width="14" height="10" rx="2.5" fill="${C.indigo}" fill-opacity=".7"/>`).join('') + chip(838, y + 14, 'running', C.ok, { w: 68 }), { op: 1 });
    s += g(on(9.8 + i * 0.25, h.END), line(`M620 397 C640 397 640 ${y + 38} 660 ${y + 38}`, { stroke: C.cyan, dash: '3 4', op: 0.7 }), { op: 1 });
    s += pkt([[620, 397], [640, (397 + y + 38) / 2], [660, y + 38]], 9.8 + i * 0.25, 10.3 + i * 0.25, C.cyan, 3.5);
  });
  s += g(on(10.6, h.END), tx(660, 456, 'memory shared copy-on-write until written', { size: 11.5, fill: C.t3 }), { op: 1 });
  return s;
});

/* ───────────────────────── Runtime: egress broker ───────────────────────── */
add('runtime-egress', { T: 14, product: 'runtime', title: 'Egress: allowlisted, credential-injected, inspected', sub: 'In broker mode the microVM has no network device. The host broker decides what leaves, adds secrets, and scans for leaks.' }, (h) => {
  const { C, tx, box, g, line, on, pkt, kf, chip, check, cross } = h;
  let s = '';
  // microVM
  s += `<rect x="40" y="134" width="300" height="270" rx="20" fill="${C.indigo}" fill-opacity=".05" stroke="url(#${h.P}g)" stroke-width="2"/>`;
  s += tx(58, 160, 'microVM', { w: 650, size: 13.5, fill: C.rtText }) + tx(322, 160, 'no network device', { size: 11, fill: C.t3, anchor: 'end' });
  s += box(58, 176, 264, 128, { rx: 14, fill: C.hold, stroke: C.hold, op: 1 }).replace(`fill="${C.hold}"`, `fill="${C.hold}" fill-opacity=".08"`);
  s += tx(74, 200, 'untrusted agent code', { w: 600, size: 13, fill: C.hold });
  const cmds = [['$ curl api.github.com/user', 0.6], ['  -H "Authorization: $GH"', 0.6], ['$ curl -d @cards.csv api.github…', 5.4], ['$ curl paste.example', 9.6]];
  cmds.forEach(([c, t], i) => { s += g(on(t, h.END, 0), tx(74, 224 + i * 19, c, { size: 11.5, mono: 1, fill: C.t1 }), { op: 1 }); });
  s += tx(74, 296, '$GH is a placeholder, not the token', { size: 11, fill: C.t3 });
  s += box(58, 318, 264, 70, { rx: 14, fill: C.s2 }) + tx(74, 342, 'harness · PID 1', { w: 600, size: 13 }) + tx(74, 362, '127.0.0.1:3128 → vsock 2:3128', { size: 11, mono: 1, fill: C.t3 });
  s += line('M190 304 V318', { stroke: C.hold, dash: '3 3' });
  // broker
  s += box(390, 134, 250, 270, { rx: 20, fill: C.s2, stroke: C.cyan, sw: 1.5 });
  s += tx(408, 160, 'Egress broker', { w: 650, size: 14.5 }) + tx(622, 160, 'on the host', { size: 11, fill: C.t3, anchor: 'end' });
  const rows = [['allowlist', 'api.github.com only'], ['inject credential', 'lantern.secret/github'], ['DLP scan', 'card_number · secret_key']];
  rows.forEach(([a, b], i) => { const y = 180 + i * 70; s += box(408, y, 214, 56, { rx: 12, fill: C.s1 }) + tx(424, y + 23, a, { w: 600, size: 13 }) + tx(424, y + 42, b, { size: 11, fill: C.t3, mono: 1 }); });
  s += line('M322 353 C356 353 356 270 390 270', { stroke: C.cyan, sw: 1.8, op: 0.6 });
  s += tx(352, 324, 'vsock', { size: 10.5, fill: C.rtText, mono: 1, anchor: 'middle' });
  // flash rows
  const fl = (i, t, col) => g(kf([[0, 'opacity:0'], [t, 'opacity:0'], [t + 0.15, 'opacity:1'], [t + 1.1, 'opacity:0']]), `<rect x="406" y="${178 + i * 70}" width="218" height="60" rx="14" fill="none" stroke="${col}" stroke-width="2"/>`, { op: 0 });
  s += fl(0, 1.8, C.ok) + fl(1, 2.3, C.ok) + fl(2, 2.8, C.ok) + fl(0, 6.6, C.ok) + fl(1, 7.0, C.ok) + fl(2, 7.4, C.bad) + fl(0, 10.8, C.bad);
  // destinations
  s += box(690, 150, 230, 76, { rx: 14, fill: C.s1 }) + tx(708, 176, 'api.github.com', { w: 600, size: 13.5, mono: 1 }) + tx(708, 196, 'allowed', { size: 11.5, fill: C.t3 });
  s += box(690, 312, 230, 76, { rx: 14, fill: C.s1 }) + tx(708, 338, 'paste.example', { w: 600, size: 13.5, mono: 1 }) + tx(708, 358, 'not on the allowlist', { size: 11.5, fill: C.t3 });
  s += line('M640 214 C666 214 666 188 690 188', { op: 0.7 }) + line('M640 330 C666 330 666 350 690 350', { op: 0.7, dash: '4 4' });
  // flows
  s += pkt([[190, 304], [190, 318]], 1.0, 1.15, C.hold, 3.5);
  s += pkt([[322, 353], [356, 312], [390, 270]], 1.3, 1.7, C.hold, 3.5);
  s += pkt([[640, 214], [666, 200], [690, 188]], 3.1, 3.5, C.cyan, 3.5);
  s += g(on(3.4, 5.2, 4), chip(690, 236, 'Authorization: Bearer ghp_••••', C.rtText, { w: 230, mono: 1 }), { op: 0 });
  s += g(on(3.6, h.END, 0), check(898, 172, C.ok, 9) + tx(884, 196, '200', { size: 11.5, mono: 1, fill: C.ok, anchor: 'end' }), { op: 1 });
  s += pkt([[190, 304], [190, 318]], 5.8, 5.95, C.hold, 3.5);
  s += pkt([[322, 353], [356, 312], [390, 270]], 6.1, 6.5, C.hold, 3.5);
  s += g(on(7.6, h.END, 0), cross(616, 330, C.bad, 10), { op: 1 });
  s += pkt([[322, 353], [356, 312], [390, 270]], 10.3, 10.7, C.hold, 3.5);
  s += g(on(11.0, h.END, 0), cross(898, 334, C.bad, 9) + tx(884, 358, '403', { size: 11.5, mono: 1, fill: C.bad, anchor: 'end' }), { op: 1 });
  // audit
  s += box(40, 424, 880, 90, { rx: 16, fill: '#08090c' }) + tx(58, 446, 'audit', { size: 11.5, fill: C.t3, mono: 1 });
  const au = [['egress_inject  api.github.com  GET   allow   secret never entered the guest', 3.6, C.t2], ['dlp            api.github.com  POST  block   card_number · value never logged', 7.7, C.bad], ['egress         paste.example   GET   deny    not allowlisted', 11.1, C.bad]];
  au.forEach(([t, at, col], i) => { s += g(on(at, h.END, 4), tx(58, 470 + i * 18, t, { size: 11.5, mono: 1, fill: col }), { op: 1 }); });
  return s;
});

/* ───────────────────────── Runtime: crash-resume + receipt ───────────────────────── */
add('runtime-durable', { T: 14, product: 'runtime', title: 'Runs that finish, with proof', sub: 'Every step is journaled. After a crash the run resumes where it stopped; finished steps are never re-run. Then it’s signed.' }, (h) => {
  const { C, tx, box, g, line, on, pkt, kf, chip, check, cross } = h;
  let s = '';
  const steps = [['trigger', 'webhook'], ['fetch', 'tool'], ['summarize', 'ai-step'], ['send', 'connector'], ['end', '']];
  const X = (i) => 40 + i * 180;
  steps.forEach(([n, k], i) => {
    s += box(X(i), 140, 160, 64, { rx: 14, fill: C.s2 }) + tx(X(i) + 16, 166, n, { w: 650, size: 14 }) + tx(X(i) + 16, 186, k, { size: 11, fill: C.t3, mono: 1 });
    if (i < 4) s += line(`M${X(i) + 160} 172 H${X(i + 1)}`, { arrow: 1, op: 0.8 });
  });
  // first pass done marks
  const done = (i, t, col = C.ok) => g(on(t, h.END, 0), check(X(i) + 140, 158, col, 8), { op: 1 });
  s += done(0, 0.6) + done(1, 1.4) + done(2, 2.4);
  s += pkt([[X(0) + 160, 172], [X(1), 172]], 0.8, 1.0, C.violet) + pkt([[X(1) + 160, 172], [X(2), 172]], 1.6, 1.8, C.violet) + pkt([[X(2) + 160, 172], [X(3), 172]], 2.6, 2.8, C.violet);
  // crash
  s += g(kf([[0, 'opacity:0'], [3.3, 'opacity:0'], [3.4, 'opacity:1'], [6.6, 'opacity:1'], [6.8, 'opacity:0']]), `<rect x="${X(3) - 3}" y="137" width="166" height="70" rx="16" fill="${C.badFill}" fill-opacity=".12" stroke="${C.bad}" stroke-width="2"/>` + cross(X(3) + 140, 158, C.bad, 8) + tx(X(3) + 80, 228, 'worker crashed', { size: 12, anchor: 'middle', fill: C.bad, w: 600 }), { op: 0 });
  // replay pass
  s += g(on(6.6, 8.6, 0), tx(40, 236, 'resumed', { size: 12, fill: C.rtText, w: 600 }), { op: 0 });
  [0, 1, 2].forEach((i) => { s += g(on(6.9 + i * 0.3, h.END, 0), tx(X(i) + 16, 228, 'cached · skipped', { size: 11, fill: C.t3 }), { op: 1 }); });
  s += pkt([[X(0) + 80, 206], [X(3) + 20, 206]], 6.8, 7.8, C.cyan, 3.5);
  s += done(3, 8.6) + done(4, 9.2);
  s += pkt([[X(3) + 160, 172], [X(4), 172]], 8.8, 9.1, C.violet);
  s += g(on(8.6, h.END, 0), tx(X(3) + 16, 228, 'sent once', { size: 11, fill: C.ok }), { op: 1 });
  // journal
  s += box(40, 256, 520, 258, { rx: 16, fill: '#08090c' }) + tx(58, 280, 'journal_events', { size: 11.5, fill: C.t3, mono: 1 }) + tx(542, 280, 'run_id r-82c1', { size: 11, fill: C.t3, mono: 1, anchor: 'end' });
  const J = [['1', 'step_completed', 'trigger', 0.6], ['2', 'step_completed', 'fetch', 1.4], ['3', 'step_completed', 'summarize', 2.4], ['4', 'step_started', 'send', 3.0], ['', '— lock expired, recovery sweep reclaims the run —', '', 5.2], ['5', 'step_completed', 'send   key r-82c1:send:1', 8.6], ['6', 'run_completed', '', 9.3]];
  J.forEach(([q, k, st, t], i) => {
    const y = 306 + i * 27;
    s += g(on(t, h.END, 4), q ? tx(58, y, q.padStart(2, ' '), { size: 12, mono: 1, fill: C.t3 }) + tx(86, y, k, { size: 12, mono: 1, fill: k === 'step_started' ? C.hold : C.ok }) + tx(228, y, st, { size: 12, mono: 1, fill: C.t1 }) : tx(58, y, k, { size: 11.5, mono: 1, fill: C.rtText }), { op: 1 });
  });
  // receipt
  s += g(on(10.0, h.END, 10), box(590, 256, 330, 258, { rx: 18, fill: C.s2, stroke: `url(#${h.P}g)`, sw: 1.5 }) +
    tx(610, 284, 'Receipt', { w: 650, size: 15 }) + chip(842, 268, 'Ed25519', C.violet, { w: 62 }) +
    tx(610, 316, 'run', { size: 11.5, fill: C.t3 }) + tx(700, 316, 'r-82c1 · completed', { size: 12, mono: 1 }) +
    tx(610, 340, 'journal', { size: 11.5, fill: C.t3 }) + tx(700, 340, 'sha256 9f2c…e41a', { size: 12, mono: 1 }) +
    tx(610, 364, 'cost', { size: 11.5, fill: C.t3 }) + tx(700, 364, '$0.042 · 3,180 tokens', { size: 12, mono: 1 }) +
    tx(610, 388, 'signature', { size: 11.5, fill: C.t3 }) + tx(700, 388, 'b64 · 7Qm2…Kx0=', { size: 12, mono: 1 }) +
    `<path d="M610 408 H900" stroke="${C.line}"/>` + tx(610, 436, 'POST /v1/runs/receipts/verify', { size: 11.5, mono: 1, fill: C.t3 }) +
    tx(610, 462, 'edit one journal row and it fails', { size: 12, fill: C.t3 }), { op: 1 });
  s += g(on(11.2, h.END, 0), check(624, 489, C.ok, 9) + tx(640, 494, 'verified', { size: 13, w: 650, fill: C.ok }), { op: 1 });
  return s;
});

/* ───────────────────────── Runtime: budgets, routing, evals ───────────────────────── */
add('runtime-guardrails', { T: 13, product: 'runtime', title: 'Budgets, routing and eval gates', sub: 'Ask for a capability, not a vendor. Spend is checked before the model is called, and a regression can’t deploy.' }, (h) => {
  const { C, tx, box, g, line, on, pkt, kf, chip, check, cross } = h;
  let s = '';
  // request
  s += box(40, 140, 250, 112, { rx: 16, fill: '#08090c' }) + tx(58, 164, 'runs.create', { size: 11.5, mono: 1, fill: C.t3 });
  s += tx(58, 190, 'agent:  "triage"', { size: 12.5, mono: 1 }) + tx(58, 210, 'model:  "reasoning-large"', { size: 12.5, mono: 1, fill: C.rtText }) + tx(58, 230, 'input:  { email }', { size: 12.5, mono: 1 });
  // budget
  s += box(330, 140, 280, 112, { rx: 16, fill: C.s2 }) + tx(348, 166, 'Budget check', { w: 650, size: 14 }) + tx(592, 166, 'before any tokens', { size: 11, fill: C.t3, anchor: 'end' });
  s += tx(348, 196, 'today', { size: 11.5, fill: C.t3 }) + tx(592, 196, 'cap $25.00 / day', { size: 11.5, fill: C.t3, anchor: 'end' });
  s += `<rect x="348" y="206" width="244" height="10" rx="5" fill="${C.s3}"/>`;
  s += `<rect class="${kf([[0, 'width:0px'], [0.6, 'width:0px'], [1.0, 'width:230px'], [3.8, 'width:230px'], [4.2, 'width:239px']], 'ease-out')}" x="348" y="206" width="239" height="10" rx="5" fill="url(#${h.P}g)"/>`;
  s += g(kf([[0, 'opacity:1'], [4.0, 'opacity:1'], [4.2, 'opacity:0']]), tx(348, 238, '$23.60 spent', { size: 12, mono: 1 }), { op: 0 });
  s += g(on(4.2, h.END, 0), tx(348, 238, '$24.50 spent', { size: 12, mono: 1 }), { op: 1 });
  s += g(on(1.2, h.END, 0), check(592, 234, C.ok, 8), { op: 1 });
  s += line('M290 196 H330', { arrow: 1, op: 0.8 }) + pkt([[290, 196], [330, 196]], 0.5, 0.8, C.violet);
  // router
  s += box(650, 140, 270, 172, { rx: 16, fill: C.s2 }) + tx(668, 166, 'Model router', { w: 650, size: 14 }) + tx(902, 166, 'capability → model', { size: 11, fill: C.t3, anchor: 'end' });
  const cand = [['primary', 'anthropic · large'], ['failover', 'openai · large'], ['cache', 'prompt hit · $0']];
  cand.forEach(([a, b], i) => { const y = 182 + i * 40; s += box(668, y, 234, 32, { rx: 10, fill: C.s1 }) + tx(682, y + 21, a, { size: 11.5, fill: C.t3 }) + tx(888, y + 21, b, { size: 12, mono: 1, anchor: 'end' }); });
  s += g(kf([[0, 'opacity:0'], [1.6, 'opacity:0'], [1.8, 'opacity:1'], [2.4, 'opacity:1'], [2.6, 'opacity:0']]), `<rect x="666" y="180" width="238" height="36" rx="12" fill="none" stroke="${C.bad}" stroke-width="1.8"/>` + tx(902, 176, '429', { size: 11, fill: C.bad, anchor: 'end', mono: 1 }), { op: 0 });
  s += g(on(2.6, h.END, 0), `<rect x="666" y="220" width="238" height="36" rx="12" fill="none" stroke="${C.ok}" stroke-width="1.8"/>`, { op: 1 });
  s += line('M610 196 H650', { arrow: 1, op: 0.8 }) + pkt([[610, 196], [650, 196]], 1.3, 1.5, C.violet);
  s += line('M785 312 V340 H470 V252', { stroke: C.cyan, dash: '3 5', op: 0.45 });
  s += pkt([[785, 312], [785, 340], [470, 340], [470, 252]], 3.2, 4.0, C.cyan, 3.5);
  s += g(on(3.4, h.END, 0), tx(628, 334, 'tokens + cost recorded', { size: 11, fill: C.rtText, anchor: 'middle' }), { op: 1 });
  // 402
  s += box(40, 372, 420, 142, { rx: 16, fill: C.s1 }) + tx(58, 398, 'Next run', { w: 650, size: 14 }) + tx(442, 398, 'POST /v1/runs/forecast', { size: 11, fill: C.t3, mono: 1, anchor: 'end' });
  s += g(on(5.4, h.END, 4), tx(58, 428, 'forecast  ~$0.90 · would cross $25.00', { size: 12, mono: 1 }), { op: 1 });
  s += g(on(6.4, h.END, 0), `<rect x="58" y="446" width="148" height="44" rx="12" fill="${C.badFill}" fill-opacity=".14" stroke="${C.bad}" stroke-opacity=".6"/>` + tx(132, 474, 'HTTP 402', { size: 15, w: 700, anchor: 'middle', fill: C.bad, mono: 1 }) + tx(222, 466, 'refused before the model', { size: 12, fill: C.t2 }) + tx(222, 484, 'is called. $0 spent.', { size: 12, fill: C.t3 }), { op: 1 });
  // eval gate
  s += box(500, 372, 420, 142, { rx: 16, fill: C.s1 }) + tx(518, 398, 'Eval gate', { w: 650, size: 14 }) + tx(902, 398, 'CI · branch baseline', { size: 11, fill: C.t3, anchor: 'end' });
  s += tx(518, 430, 'baseline', { size: 12, fill: C.t3 }) + tx(600, 430, '0.94', { size: 12.5, mono: 1 });
  s += `<rect x="650" y="422" width="250" height="8" rx="4" fill="${C.s3}"/><rect x="650" y="422" width="235" height="8" rx="4" fill="${C.t3}"/>`;
  s += g(on(8.0, h.END, 0), tx(518, 452, 'this PR', { size: 12, fill: C.t3 }) + tx(600, 452, '0.91', { size: 12.5, mono: 1, fill: C.bad }), { op: 1 });
  s += `<rect class="${kf([[0, 'width:0px'], [8.0, 'width:0px'], [8.6, 'width:227px']], 'ease-out')}" x="650" y="444" width="227" height="8" rx="4" fill="${C.bad}"/>`;
  s += g(on(9.0, h.END, 0), `<rect x="518" y="466" width="148" height="34" rx="10" fill="${C.badFill}" fill-opacity=".14" stroke="${C.bad}" stroke-opacity=".6"/>` + tx(592, 488, 'HTTP 422', { size: 14, w: 700, anchor: 'middle', fill: C.bad, mono: 1 }) + tx(680, 488, 'regressed · deploy blocked', { size: 12, fill: C.t2 }), { op: 1 });
  void cross; return s;
});

for (const [n, b] of Object.entries(sizes)) console.log(n.padEnd(22), (b / 1024).toFixed(1) + 'KB');
