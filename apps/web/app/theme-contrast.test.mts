// WCAG AA gate for the central theme in globals.css: every text token must
// clear 4.5:1 on every page/card/hover surface, in dark (the @theme block)
// and light (the :root[data-theme="light"] remap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

// Merges every block opening with `start`, later blocks winning (the cascade).
function tokens(start: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = css.indexOf(start); i >= 0; i = css.indexOf(start, i + 1)) {
    const body = css.slice(i, css.indexOf("}", i));
    for (const m of body.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  }
  assert.ok(Object.keys(out).length, `missing block ${start}`);
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const dark = tokens("@theme {");
const light = { ...dark, ...tokens(':root[data-theme="light"] {') };
const text = ["zinc-50", "zinc-100", "zinc-200", "zinc-300", "zinc-400", "zinc-500", "lantern-300", "lantern-400", "lantern-500"];
const surfaces = ["surface-0", "surface-1", "surface-2", "surface-3"];
// zinc-600 is the faint tier (timestamps, counts): AA on page, card and inset surfaces.
const faint = ["zinc-600"];
const faintSurfaces = ["surface-0", "surface-1", "surface-2"];
// Warnings are written as text-amber-*; amber is remapped to the sulfur warn hue.
const warn = ["amber-100", "amber-200", "amber-300", "amber-400", "amber-500"];

for (const [name, t] of [["dark", dark], ["light", light]] as const) {
  test(`${name}: text tokens clear AA on every surface`, () => {
    for (const fg of text) for (const bg of surfaces) {
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${fg} ${t[fg]} on ${bg} ${t[bg]} = ${r.toFixed(2)}`);
    }
    for (const fg of warn) for (const bg of surfaces) {
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${fg} ${t[fg]} on ${bg} ${t[bg]} = ${r.toFixed(2)}`);
    }
    for (const fg of faint) for (const bg of faintSurfaces) {
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${fg} ${t[fg]} on ${bg} ${t[bg]} = ${r.toFixed(2)}`);
    }
  });
  test(`${name}: on-flame ink clears AA on solid flame fills`, () => {
    for (const bg of ["lantern-300", "lantern-400", "lantern-500"]) {
      const r = ratio(t["on-flame"], t[bg]);
      assert.ok(r >= 4.5, `on-flame on ${bg} = ${r.toFixed(2)}`);
    }
  });
}

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

for (const [name, t] of [["dark", dark], ["light", light]] as const) {
  test(`${name}: warning hue reads apart from the flame accent`, () => {
    const d = Math.abs(hue(t["amber-400"]) - hue(t["lantern-400"]));
    assert.ok(d >= 15, `warn ${t["amber-400"]} vs flame ${t["lantern-400"]}: ${d.toFixed(1)}deg apart`);
  });
}
