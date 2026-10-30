// Generates the docs diagrams into public/diagrams/<name>-{dark,light}.svg.
// One visual language (the halos docs style): a rounded canvas, rounded zones
// with an uppercase kicker, cards with a numbered kicker, a bold title and
// short grey sub-lines. The card that matters is ringed in the product
// gradient (pal coral -> magenta, Runtime indigo -> cyan); the path that
// matters is drawn in the gradient with a slow dash-flow and a travelling
// packet. Held is amber, failure is red, done is green. Reduced motion stops
// the animation. Each diagram is laid out by hand; both themes are one picture.
// Run: node scripts/diagrams.mjs   (outputs are committed; re-run after edits)
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';

const OUT = new URL('../public/diagrams/', import.meta.url);
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith('.svg')) unlinkSync(new URL(f, OUT));

const W = 880;
const SANS = "'Inter Tight','Inter',ui-sans-serif,-apple-system,'Segoe UI',sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace";
// docs/brand/tokens.css ramps; light uses darker stops so text in the gradient holds contrast
const RAMPS = {
  pal: { dark: ['#ff7a3d', '#e5207f'], light: ['#c2410c', '#c81e5a'] },
  rt: { dark: ['#8b7fff', '#14c8f0'], light: ['#4a3ee6', '#0e7490'] },
};
const THEMES = {
  dark: { cv: '#0f1014', cvs: '#1c1d23', zone: '#131419', zones: '#24262d', card: '#17181d', cards: '#2a2c33',
    t: '#fafaf8', s: '#b9bac0', k: '#8c8e96', ln: '#5c5f68', hold: '#ffb547', holdBg: '#2a1f0c', bad: '#ff8a8a', badBg: '#2a1414',
    ok: '#5fd3a6', okBg: '#0f241c', soft: 0.12, sh: '#000000', sho: 0.5 },
  light: { cv: '#f6f5f2', cvs: '#e2e1dc', zone: '#f1f0ec', zones: '#dedcd5', card: '#ffffff', cards: '#d9d8d2',
    t: '#0b0c0f', s: '#45474e', k: '#62656d', ln: '#9a9ca3', hold: '#a8460a', holdBg: '#fdf1e3', bad: '#b42323', badBg: '#fbedea',
    ok: '#146b4b', okBg: '#e6f4ee', soft: 0.07, sh: '#1a1408', sho: 0.08 },
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// rough advance widths, to warn when a label overflows its card
const width = (s, size, mono) => String(s).length * size * (mono ? 0.6 : 0.53);

function draw(theme, ramp, H, title, desc, body) {
  const c = THEMES[theme];
  const [g0, g1] = RAMPS[ramp][theme];
  const P = [];
  const warn = (s, size, max, mono) => { if (theme === 'dark' && width(s, size, mono) > max) console.warn(`  ! "${s}" ~${Math.round(width(s, size, mono))}px > ${max}px in ${title}`); };
  const tone = (k) => ({ hold: [c.hold, c.holdBg], bad: [c.bad, c.badBg], ok: [c.ok, c.okBg] })[k];
  const d = {
    zone(x, y, w, h, kicker, { accent = true } = {}) {
      P.push(`<rect class="zone" x="${x}" y="${y}" width="${w}" height="${h}" rx="16"/>`);
      if (kicker) P.push(`<text class="k${accent ? ' ka' : ''}" x="${x + 16}" y="${y + 24}">${esc(kicker)}</text>`);
    },
    // a card: n = numbered kicker, key = gradient ring, tone = hold|bad|ok, mono = monospaced sub-lines, ghost = dashed outline
    card(x, y, w, h, { n, title: tt, sub = [], key = false, tone: tn, mono = false, ghost = false } = {}) {
      if (ghost) P.push(`<rect class="ghost" x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>`);
      else if (tn) { const [s, f] = tone(tn); P.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${f}" stroke="${s}" stroke-width="1.5"/>`); }
      else P.push(`<rect class="card" x="${x}" y="${y}" width="${w}" height="${h}" rx="12" filter="url(#sh)"/>`);
      if (key) P.push(`<rect class="soft" x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/><rect class="ring" x="${x + 0.75}" y="${y + 0.75}" width="${w - 1.5}" height="${h - 1.5}" rx="11.25"/>`);
      const lines = (n ? 1 : 0) + (tt ? 1 : 0) + sub.length;
      let ty = y + h / 2 - (lines * 17) / 2 + 12;
      if (n) { P.push(`<text class="k${tn ? '' : ' ka'}" x="${x + 16}" y="${ty}"${tn ? ` style="fill:${tone(tn)[0]}"` : ''}>${esc(n)}</text>`); ty += 18; }
      if (tt) { warn(tt, 13.5, w - 28); P.push(`<text class="t" x="${x + 16}" y="${ty}">${esc(tt)}</text>`); ty += 18; }
      for (const s of sub) { warn(s, mono ? 11.5 : 12, w - 28, mono); P.push(`<text class="${mono ? 'm' : 's'}" x="${x + 16}" y="${ty}">${esc(s)}</text>`); ty += 16; }
    },
    // arrow along points; kind: n (grey) | a (gradient, animated) | hold | bad; dashed = conditional path
    arrow(pts, { kind = 'n', dashed = false, label, lx, ly } = {}) {
      const dd = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('');
      const cls = kind === 'a' ? 'la' : 'ln';
      const st = kind === 'hold' ? ` style="stroke:${c.hold}"` : kind === 'bad' ? ` style="stroke:${c.bad}"` : '';
      const anim = kind === 'a' ? ' flow' : dashed ? ' dash' : '';
      P.push(`<path class="${cls}${anim}"${st} d="${dd}"/>`);
      const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = 6.5, s = 0.55;
      const h1 = [b[0] - L * Math.cos(ang - s), b[1] - L * Math.sin(ang - s)], h2 = [b[0] - L * Math.cos(ang + s), b[1] - L * Math.sin(ang + s)];
      P.push(`<path class="${cls}"${st} d="M${h1[0].toFixed(1)} ${h1[1].toFixed(1)}L${b[0]} ${b[1]}L${h2[0].toFixed(1)} ${h2[1].toFixed(1)}"/>`);
      if (kind === 'a') P.push(`<circle class="pkt" r="3"><animateMotion dur="2.6s" repeatCount="indefinite" path="${dd}"/></circle>`);
      if (label) P.push(`<text class="xs" x="${lx}" y="${ly}">${esc(label)}</text>`);
    },
    text(x, y, s, cls = 's') { P.push(`<text class="${cls}" x="${x}" y="${y}">${esc(s)}</text>`); },
    chip(x, y, s) {
      const w = width(s, 12, false) + 20;
      P.push(`<rect class="chip" x="${x}" y="${y}" width="${w.toFixed(1)}" height="24" rx="12"/><text class="s" x="${x + 10}" y="${y + 16}">${esc(s)}</text>`);
      return w;
    },
  };
  body(d);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<style>
.cv{fill:${c.cv};stroke:${c.cvs};stroke-width:1.5}
.zone{fill:${c.zone};stroke:${c.zones};stroke-width:1.5}
.card{fill:${c.card};stroke:${c.cards};stroke-width:1.5}
.soft{fill:url(#gs)}.ring{fill:none;stroke:url(#ga);stroke-width:1.5}
.ghost{fill:none;stroke:${c.ln};stroke-width:1.5;stroke-dasharray:4 4}
.chip{fill:${c.card};stroke:${c.cards};stroke-width:1}
text{font-family:${SANS}}
.t{font-size:13.5px;font-weight:600;fill:${c.t}}
.s{font-size:12px;fill:${c.s}}
.m{font:11.5px ${MONO};fill:${c.s}}
.xs{font-size:11px;font-weight:500;fill:${c.k}}
.k{font-size:10.5px;font-weight:650;letter-spacing:.08em;fill:${c.k}}
.ka{fill:url(#ga)}
.ln,.la{fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.ln{stroke:${c.ln}}.la{stroke:url(#ga)}
.dash{stroke-dasharray:5 5}
.pkt{fill:url(#ga)}
.flow{stroke-dasharray:4 6;animation:flow 1.1s linear infinite}
@keyframes flow{to{stroke-dashoffset:-20}}
@media (prefers-reduced-motion:reduce){.flow{animation:none;stroke-dasharray:none}.pkt{display:none}}
</style>
<defs>
<linearGradient id="ga" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0"><stop offset="0" stop-color="${g0}"/><stop offset="1" stop-color="${g1}"/></linearGradient>
<linearGradient id="gs" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0"><stop offset="0" stop-color="${g0}" stop-opacity="${c.soft}"/><stop offset="1" stop-color="${g1}" stop-opacity="${c.soft}"/></linearGradient>
<filter id="sh" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.6" flood-color="${c.sh}" flood-opacity="${c.sho}"/></filter>
</defs>
<rect class="cv" x=".75" y=".75" width="${W - 1.5}" height="${H - 1.5}" rx="16"/>
${P.join('\n')}
</svg>
`;
}

// n equal cards in a row between x0 and x1
const row = (n, gap = 28, x0 = 40, x1 = 840) => { const w = (x1 - x0 - gap * (n - 1)) / n; return { w: +w.toFixed(1), xs: Array.from({ length: n }, (_, i) => +(x0 + i * (w + gap)).toFixed(1)) }; };
const chain = (d, xs, w, y, kind) => { for (let i = 0; i + 1 < xs.length; i++) d.arrow([[+(xs[i] + w + 6).toFixed(1), y], [+(xs[i + 1] - 6).toFixed(1), y]], { kind }); };

const DIAGRAMS = {
  // ---------------------------------------------------------------- pal
  'pal-how-it-works': {
    ramp: 'pal', H: 368,
    title: 'How pal works',
    desc: 'A message arrives in iMessage or WhatsApp on your Mac. The channel bridge runs owner-only checks and asks the PAL control plane for a draft through the same sessions API the SDKs use; the model router picks the model. Back on the Mac the draft passes the check stack. Most replies are sent after a human-paced delay. A reply that commits you to money or an action, or claims something pal cannot verify, is held and shown to you in your self-chat.',
    body(d) {
      d.zone(24, 24, 832, 140, 'YOUR MAC · TWO CHANNEL BRIDGES');
      const { w, xs } = row(4);
      const y = 52, h = 96, m = (i) => +(xs[i] + w / 2).toFixed(1);
      d.card(xs[0], y, w, h, { n: '01', title: 'Message arrives', sub: ['iMessage (chat.db)', 'WhatsApp'] });
      d.card(xs[1], y, w, h, { n: '02', title: 'Channel bridge', sub: ['owner-only checks', 'mute · quiet hours'] });
      d.card(xs[2], y, w, h, { n: '04', title: 'Check stack', sub: ['voice floor · refine', 'commitment + grounding'] });
      d.card(xs[3], y, w, h, { n: '05', title: 'Send', sub: ['paced like your', 'real reply times'], key: true });
      d.arrow([[+(xs[0] + w + 6).toFixed(1), 100], [xs[1] - 6, 100]]);
      d.arrow([[+(xs[2] + w + 6).toFixed(1), 100], [xs[3] - 6, 100]], { kind: 'a' });
      d.zone(24, 196, 560, 148, 'PAL PLATFORM');
      d.card(40, 224, 248, 104, { n: '03', title: 'Control plane', sub: ['one session per contact', 'memory · web_search tool'] });
      d.card(320, 224, 248, 104, { title: 'Model router', sub: ['model: "auto"', '-> a concrete model'], mono: true });
      d.arrow([[294, 276], [314, 276]]);
      d.arrow([[m(1), 154], [m(1), 176], [176, 176], [176, 218]]);
      d.arrow([[240, 218], [240, 186], [m(2) - 24, 186], [m(2) - 24, 160]], { label: 'draft', lx: m(2) - 16, ly: 180 });
      d.zone(608, 196, 248, 148, 'YOU · SELF-CHAT', { accent: false });
      d.card(624, 224, 216, 104, { tone: 'hold', n: 'HELD', title: 'Held for you', sub: ["money · promises · claims", "pal can't verify"] });
      d.arrow([[m(2) + 24, 154], [m(2) + 24, 184], [732, 184], [732, 218]], { kind: 'hold', dashed: true });
    },
  },
  'pal-reply-gates': {
    ramp: 'pal', H: 424,
    title: 'Every contact reply passes the same checks',
    desc: 'A contact reply is drafted, checked for bot tells and for drift from your own writing (and regenerated if it fails), given a confidence tier and, if medium or low, refined against the five most similar messages you really sent. Then the commitment gate holds money and promises, the grounding gate holds dates, outcomes and condolences it cannot verify, and the claim verifier rewrites any action pal did not actually take into an intent. What passes is sent; what is held goes to your self-chat.',
    body(d) {
      const { w, xs } = row(4);
      const h = 96, m = (i) => +(xs[i] + w / 2).toFixed(1);
      d.zone(24, 24, 832, 140, 'SOUNDS LIKE YOU');
      d.card(xs[0], 52, w, h, { n: '01', title: 'Draft', sub: ['the contact\'s session', 'web_search on'] });
      d.card(xs[1], 52, w, h, { n: '02', title: 'Bot-tell guard', sub: ['stock phrases · repeats', 'voice drift: regenerate'] });
      d.card(xs[2], 52, w, h, { n: '03', title: 'Confidence tier', sub: ['HIGH · MEDIUM · LOW'] });
      d.card(xs[3], 52, w, h, { n: '04', title: 'Critique-refine', sub: ['MEDIUM and LOW only', 'vs 5 real messages'] });
      chain(d, xs, w, 100);
      d.zone(24, 188, 832, 140, 'ONLY WHAT IS TRUE');
      d.card(xs[0], 216, w, h, { n: '05', title: 'Commitment gate', sub: ['money · promises', 'in any language'] });
      d.card(xs[1], 216, w, h, { n: '06', title: 'Grounding gate', sub: ['dates · outcomes', 'bad news, jokey tone'] });
      d.card(xs[2], 216, w, h, { n: '07', title: 'Claim verifier', sub: ['"I sent it" stays only', 'if it happened'] });
      d.card(xs[3], 216, w, h, { n: '08', title: 'Send', sub: ['paced like your', 'real reply times'], key: true });
      d.arrow([[m(3), 154], [m(3), 176], [+(xs[0] + w - 14).toFixed(1), 176], [+(xs[0] + w - 14).toFixed(1), 210]]);
      chain(d, xs.slice(0, 3), w, 264);
      d.arrow([[+(xs[2] + w + 6).toFixed(1), 264], [xs[3] - 6, 264]], { kind: 'a' });
      d.card(40, 352, 800, 52, { tone: 'hold', title: 'Held for you, never sent', sub: ['Paged to your self-chat. Type the reply yourself, or approve with send where it is offered.'] });
      d.arrow([[m(0), 318], [m(0), 346]], { kind: 'hold', dashed: true });
      d.arrow([[m(1), 318], [m(1), 346]], { kind: 'hold', dashed: true });
    },
  },
  'pal-memory': {
    ramp: 'pal', H: 340,
    title: 'One memory across both channels',
    desc: 'iMessage and WhatsApp handles resolve to one canonical person in the control plane. Timeline events for that person feed the context pal reads before replying, and cross-thread recall searches everyone else in your tenant. On the Mac, recent episodes, topics, the sent log and dislike patterns are kept in AES-256-GCM encrypted files.',
    body(d) {
      d.zone(24, 24, 200, 292, 'CHANNELS', { accent: false });
      d.card(40, 64, 168, 84, { title: 'iMessage', sub: ['phone or email handle'] });
      d.card(40, 196, 168, 84, { title: 'WhatsApp', sub: ['WhatsApp ID'] });
      d.zone(248, 24, 608, 176, 'CONTROL PLANE · POSTGRES, ROW-LEVEL SECURITY');
      d.card(264, 56, 176, 128, { n: '01', title: 'Person graph', sub: ['/v1/people/resolve', '/v1/people/merge'], mono: true, key: true });
      d.card(464, 56, 176, 60, { title: 'Timeline', sub: ['/v1/memory/events'], mono: true });
      d.card(464, 124, 176, 60, { title: 'Context', sub: ['/v1/memory/context'], mono: true });
      d.card(664, 56, 176, 128, { n: '02', title: 'Cross-thread recall', sub: ['/v1/memory/search', 'everyone else'], mono: true });
      d.arrow([[214, 106], [258, 106]], { kind: 'a' });
      d.arrow([[214, 238], [236, 238], [236, 140], [258, 140]], { kind: 'a' });
      d.arrow([[446, 86], [458, 86]]);
      d.arrow([[446, 154], [458, 154]]);
      d.arrow([[646, 120], [658, 120]]);
      d.zone(248, 224, 608, 92, 'ON YOUR MAC · ENCRYPTED AT REST (AES-256-GCM)', { accent: false });
      let x = 264;
      for (const s of ['episodes · 14 days', 'topic index · 7 days', 'sent-reply log', 'dislike patterns']) x += d.chip(x, 266, s) + 10;
    },
  },
  // ---------------------------------------------------------------- Runtime
  'runtime-how-it-works': {
    ramp: 'rt', H: 380,
    title: 'How PAL Runtime works',
    desc: 'Your code, the pal CLI and the dashboard call the control plane over REST, directly or through the gateway. The control plane authenticates, applies budgets and tenant isolation, and hands work to the workflow engine, which journals every step. Model calls go through the model router by capability. Untrusted code runs in a microVM that the runtime scheduler places and the runtime manager starts. Every internal gRPC hop needs the shared service token.',
    body(d) {
      const { w, xs } = row(4);
      const m = (i) => +(xs[i] + w / 2).toFixed(1);
      d.zone(24, 24, 832, 132, 'YOU · ANY CLIENT');
      d.card(xs[0], 52, w, 88, { title: 'SDKs', sub: ['TS · Python · Go'] });
      d.card(xs[1], 52, w, 88, { title: 'pal CLI · dashboard', sub: ['the same REST API'] });
      d.card(xs[2], 52, w, 88, { n: '01', title: 'Gateway', sub: [':8443 · TLS · API keys'] });
      d.card(xs[3], 52, w, 88, { n: '02', title: 'Control plane', sub: [':8080 REST · :50051', 'auth · budgets · RLS'], key: true });
      chain(d, xs.slice(0, 3), w, 96);
      d.arrow([[+(xs[2] + w + 6).toFixed(1), 96], [xs[3] - 6, 96]], { kind: 'a' });
      d.zone(24, 180, 832, 176, 'RUNTIME SERVICES · gRPC · SERVICE-TOKEN AUTHENTICATED');
      d.card(xs[3], 208, w, 132, { n: '03', title: 'Workflow engine', sub: [':50052', 'journals every step', 'replays after a crash'] });
      d.card(xs[2], 208, w, 60, { title: 'Model router', sub: ['by capability · :50053'] });
      d.card(xs[2], 280, w, 60, { title: 'Runtime scheduler', sub: ['places VMs · :50055'] });
      d.card(xs[1], 280, w, 60, { title: 'Runtime manager', sub: [':50054 · starts them'] });
      d.card(xs[0], 208, w, 132, { n: '04', title: 'microVM', sub: ['Firecracker or Kata', 'harness enforces egress', 'and vends secrets'], key: true });
      d.arrow([[m(3), 146], [m(3), 202]], { kind: 'a' });
      d.arrow([[xs[3] - 6, 238], [+(xs[2] + w + 6).toFixed(1), 238]]);
      d.arrow([[xs[3] - 6, 310], [+(xs[2] + w + 6).toFixed(1), 310]], { kind: 'a' });
      d.arrow([[xs[2] - 6, 310], [+(xs[1] + w + 6).toFixed(1), 310]], { kind: 'a' });
      d.arrow([[xs[1] - 6, 310], [+(xs[0] + w + 6).toFixed(1), 310]], { kind: 'a' });
      d.text(xs[1] + 4, 232, 'Postgres · Redis · S3', 'xs');
      d.text(xs[1] + 4, 248, 'run state, journal, bundles', 'xs');
    },
  },
  'run-lifecycle': {
    ramp: 'rt', H: 300,
    title: 'The life of a run',
    desc: 'A POST to /v1/runs is authenticated and checked against the agent budget; over a hard cap it is refused with 402 before any model is called. The run is executed either as a model call or through the workflow interpreter when the agent has a saved graph. Each step writes step_started and step_completed to the journal, model calls go through the router and are recorded against the budget, and the client streams the journal over server-sent events.',
    body(d) {
      const { w, xs } = row(5, 24);
      const m = (i) => +(xs[i] + w / 2).toFixed(1);
      d.zone(24, 24, 832, 148, 'ONE RUN, START TO FINISH');
      d.card(xs[0], 52, w, 104, { n: '01', title: 'POST /v1/runs', sub: ['JWT or API key', 'tenant from auth'] });
      d.card(xs[1], 52, w, 104, { n: '02', title: 'Budget check', sub: ['daily cost · runs', 'hard or soft'] });
      d.card(xs[2], 52, w, 104, { n: '03', title: 'Execute', sub: ['model call, or', 'workflow graph'] });
      d.card(xs[3], 52, w, 104, { n: '04', title: 'Journal', sub: ['step_started', 'step_completed'] });
      d.card(xs[4], 52, w, 104, { n: '05', title: 'Stream', sub: ['SSE from the', 'journal'], key: true });
      d.arrow([[+(xs[0] + w + 5).toFixed(1), 104], [xs[1] - 5, 104]]);
      chain(d, xs.slice(1), w, 104, 'a');
      d.card(xs[1], 204, w, 72, { tone: 'bad', title: '402', sub: ['hard cap hit;', 'no model call'] });
      d.arrow([[m(1), 162], [m(1), 198]], { kind: 'bad', dashed: true });
      d.card(xs[2], 204, +(w * 2 + 24).toFixed(1), 72, { title: 'Model router', sub: ['"auto" or a capability -> a provider model', 'usage recorded against the budget'] });
      d.arrow([[m(2), 162], [m(2), 198]]);
    },
  },
  'crash-resume': {
    ramp: 'rt', H: 344,
    title: 'A run resumes after a crash',
    desc: 'Each finished step is written to the run journal. The process crashes during step 3. The recovery sweep finds the run whose lock has expired and takes the lock. Steps 1 and 2 are replayed from the journal, not re-run. Step 3 runs again with the same idempotency key, so the provider bills it once.',
    body(d) {
      const { w, xs } = row(3, 48, 40, 640);
      d.zone(24, 24, 832, 124, 'BEFORE THE CRASH');
      d.card(xs[0], 52, w, 80, { n: '01', title: 'Step 1', sub: ['step_completed'], tone: 'ok' });
      d.card(xs[1], 52, w, 80, { n: '02', title: 'Step 2', sub: ['step_completed'], tone: 'ok' });
      d.card(xs[2], 52, w, 80, { n: '03', title: 'Step 3', sub: ['crash mid-call'], tone: 'bad' });
      chain(d, xs, w, 92);
      d.card(672, 52, 168, 80, { title: 'Recovery sweep', sub: ['every 30 s', 'takes the expired lock'], key: true });
      d.arrow([[+(xs[2] + w + 6).toFixed(1), 92], [666, 92]], { kind: 'bad', dashed: true });
      d.zone(24, 172, 832, 148, 'AFTER RECOVERY · RESUME, NOT RESTART');
      d.card(xs[0], 200, w, 80, { n: '01', title: 'Step 1', sub: ['cached from journal'], ghost: true });
      d.card(xs[1], 200, w, 80, { n: '02', title: 'Step 2', sub: ['cached from journal'], ghost: true });
      d.card(xs[2], 200, w, 80, { n: '03', title: 'Step 3, again', sub: ['same idempotency key', 'billed once'], key: true });
      chain(d, xs, w, 240);
      d.arrow([[756, 138], [756, 240], [+(xs[2] + w + 6).toFixed(1), 240]], { kind: 'a' });
      d.text(40, 304, 'idempotency key = (run_id, step_id, attempt): the provider drops the repeat', 'xs');
    },
  },
  'budget-gate': {
    ramp: 'rt', H: 296,
    title: 'Budgets are checked before the model is called',
    desc: 'A run request first meets the budget check: the agent caps and the tenant-wide daily cap. Over a hard cap the API returns 402 and no model is called, so the refusal costs nothing. Under the cap, the request is routed by capability to a provider model and the usage is recorded against the day.',
    body(d) {
      d.zone(24, 24, 832, 248, 'POLICY AS CODE · PER AGENT AND PER TENANT');
      d.card(40, 96, 176, 96, { n: '01', title: 'Run request', sub: ['agent + input'] });
      d.card(256, 88, 208, 112, { n: '02', title: 'Budget check', sub: ['cost/run · cost/day', 'tokens/day · runs/day', 'per-tool limits'], key: true });
      d.card(504, 52, 336, 84, { n: '03', title: 'Under the cap', sub: ['routed by capability to a model;', 'usage recorded for the day'], tone: 'ok' });
      d.card(504, 168, 336, 84, { title: 'Over a hard cap', sub: ['402 before any model call;', 'the refusal costs nothing'], tone: 'bad' });
      d.arrow([[222, 144], [250, 144]]);
      d.arrow([[470, 128], [484, 128], [484, 94], [498, 94]], { kind: 'a' });
      d.arrow([[470, 160], [484, 160], [484, 210], [498, 210]], { kind: 'bad', dashed: true });
    },
  },
  'sandbox-egress': {
    ramp: 'rt', H: 324,
    title: 'How code in a microVM reaches the network',
    desc: 'Untrusted code runs in a microVM as the workload user. In the default guest mode, the harness proxy on 127.0.0.1:3128 allows only the declared hosts, and production refuses to start the workload without the iptables rule that forces traffic through it. In opt-in broker mode the VM has no network card: traffic leaves over vsock to a broker on the host, which checks the allowlist and injects credentials there, so keys never enter the VM. Anything else is refused and audited.',
    body(d) {
      d.zone(24, 24, 400, 276, 'INSIDE THE microVM · UNTRUSTED');
      d.card(40, 56, 368, 80, { n: '01', title: 'Workload', sub: ['runs as the workload uid, not the harness', 'proxy variables set in its environment'] });
      d.card(40, 156, 368, 128, { n: '02', title: 'Harness · PID 1', sub: ['proxy on 127.0.0.1:3128', 'guest mode: iptables REDIRECT forces it', 'broker mode: no network card, vsock only', 'secrets socket checks the caller uid'], key: true });
      d.arrow([[224, 140], [224, 150]], { kind: 'a' });
      d.zone(448, 24, 408, 276, 'HOST AND INTERNET');
      d.card(464, 56, 376, 80, { n: '03', title: 'Allowlist check', sub: ['broker mode adds the credential here;', 'the secret never enters the VM'], key: true });
      d.card(464, 160, 180, 124, { title: 'Allowed host', sub: ['request goes out'], tone: 'ok' });
      d.card(660, 160, 180, 124, { title: 'Any other host', sub: ['refused', 'and audited'], tone: 'bad' });
      d.arrow([[414, 220], [436, 220], [436, 96], [458, 96]], { kind: 'a' });
      d.arrow([[554, 140], [554, 154]], { kind: 'a' });
      d.arrow([[750, 140], [750, 154]], { kind: 'bad', dashed: true });
    },
  },
  'trust-zones': {
    ramp: 'rt', H: 344,
    title: 'Where the trust boundaries are',
    desc: 'Callers authenticate at the edge with a JWT or an API key that carries scopes. The control plane takes the tenant from that credential and scopes every query with row-level security. Internal gRPC ports accept a tenant id only from callers presenting the shared service token. Untrusted code runs only in a microVM, behind the egress allowlist, with secrets vended to the workload user alone.',
    body(d) {
      const { w, xs } = row(4, 24);
      d.zone(24, 24, 832, 296, 'FOUR BOUNDARIES · EACH FAILS CLOSED');
      const H = 208, y = 56;
      d.card(xs[0], y, w, H, { n: '01', title: 'Edge', sub: ['JWT or API key', 'scopes per endpoint', 'gateway checks keys', 'with the control plane'] });
      d.card(xs[1], y, w, H, { n: '02', title: 'Tenant', sub: ['tenant from the', 'credential, never', 'the request body;', 'row-level security'], key: true });
      d.card(xs[2], y, w, H, { n: '03', title: 'Service', sub: ['gRPC :50051-:50055', 'shared service token', 'before a tenant id', 'is trusted'] });
      d.card(xs[3], y, w, H, { n: '04', title: 'Sandbox', sub: ['untrusted code only', 'in a microVM', 'egress allowlist', 'secrets to the', 'workload user only'], key: true });
      chain(d, xs, w, y + 104);
      d.text(40, 296, 'Production refuses to start when a boundary is not configured.', 'xs');
    },
  },
  'vm-lifecycle': {
    ramp: 'rt', H: 316,
    title: 'The life of a microVM',
    desc: 'A schedule request is placed on a node by the runtime scheduler and started by the runtime manager. A running VM can be paused, which snapshots it, stops it and frees its quota slot, then resumed under the same id. A VM with an idle timeout is paused automatically and resumed on the next exec. A fork starts N copies from one snapshot, each with its own id and identity. Delete drains and terminates.',
    body(d) {
      const { w, xs } = row(4, 32);
      const m = (i) => +(xs[i] + w / 2).toFixed(1);
      d.zone(24, 24, 832, 132, 'START');
      d.card(xs[0], 52, w, 88, { n: '01', title: 'Schedule', sub: ['/v1/runtime/schedule', 'over quota: 402'] });
      d.card(xs[1], 52, w, 88, { n: '02', title: 'Place', sub: ['warm pool · region', 'fair share · cost'] });
      d.card(xs[2], 52, w, 88, { n: '03', title: 'Spawn', sub: ['runtime manager', 'Firecracker or Kata'] });
      d.card(xs[3], 52, w, 88, { n: '04', title: 'Running', sub: ['heartbeat every 5 s', 'exec · files · logs'], key: true });
      chain(d, xs, w, 96);
      d.zone(24, 180, 832, 112, 'WHILE IT RUNS');
      d.card(xs[3], 210, w, 68, { title: 'Pause', sub: ['snapshot and stop', 'frees the quota slot'] });
      d.card(xs[2], 210, w, 68, { title: 'Resume', sub: ['same vm id; idle', 'VMs on next exec'] });
      d.card(xs[1], 210, w, 68, { title: 'Fork × N', sub: ['from one snapshot', 'own id + identity'] });
      d.card(xs[0], 210, w, 68, { title: 'Terminate', sub: ['delete with a grace', 'period: drain, stop'], tone: 'bad' });
      d.arrow([[m(3), 146], [m(3), 204]], { kind: 'a' });
      d.arrow([[xs[3] - 8, 244], [+(xs[2] + w + 8).toFixed(1), 244]]);
    },
  },
  'your-cloud': {
    ramp: 'rt', H: 300,
    title: 'Running the data plane in your cloud',
    desc: 'The control plane runs wherever you deploy it. The data plane runs inside your VPC with the microVM sandboxes and the run data. It dials out to the control plane and holds one connection open; run assignments come back down it. There are no inbound ports.',
    body(d) {
      d.zone(24, 24, 300, 252, 'CONTROL PLANE · MANAGED OR YOURS');
      d.card(40, 60, 268, 92, { n: '01', title: 'Control plane', sub: ['API, auth, agents, budgets', 'dashboard'] });
      d.card(40, 168, 268, 92, { title: 'Run assignments', sub: ['sent down the open', 'connection'], ghost: true });
      d.zone(372, 24, 484, 252, 'YOUR VPC · NO INBOUND PORTS');
      d.card(388, 60, 452, 92, { n: '02', title: 'Data plane', sub: ['registers, heartbeats, and holds one', 'connection open to the control plane'], key: true });
      d.card(388, 168, 216, 92, { title: 'microVM sandboxes', sub: ['your nodes, your network'] });
      d.card(624, 168, 216, 92, { title: 'Run data', sub: ['stays in your account'] });
      d.arrow([[382, 106], [314, 106]], { kind: 'a', label: 'dials out', lx: 322, ly: 96 });
      d.arrow([[314, 214], [344, 214], [344, 130], [382, 130]], { dashed: true });
    },
  },
};

let n = 0;
for (const [name, def] of Object.entries(DIAGRAMS)) {
  for (const theme of ['dark', 'light']) {
    writeFileSync(new URL(`${name}-${theme}.svg`, OUT), draw(theme, def.ramp, def.H, def.title, def.desc, def.body));
    n++;
  }
}
console.log(`wrote ${n} files to public/diagrams/`);
